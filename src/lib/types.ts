import { randomUUID } from 'node:crypto'
import { classifyError, NetworkError } from '@lacasoft/coatipay-protocol'

export interface LogEntry {
  request_id: string
  method: string
  path: string
  status: number
  latency_ms: number
  /** Nodeit wallet selected for routing, if returned by the API. */
  node_route: string | null
}

export interface CoatiPayConfig {
  apiKey: string
  baseUrl?: string
  timeout?: number
  merchantWallet?: string
  /** Optional structured-log hook called after every SDK request. */
  logger?: (entry: LogEntry) => void
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: unknown
  /** Forwarded as Idempotency-Key header when present. */
  idempotencyKey?: string
}

export async function request<T>(config: CoatiPayConfig, opts: RequestOptions): Promise<T> {
  const url = `${config.baseUrl}/v1${opts.path}`
  const requestId = randomUUID()
  const start = Date.now()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeout ?? 30_000)

  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        // Only declare a JSON content-type when we actually send a body.
        // A bodyless POST (e.g. /cancel) that still claims application/json
        // makes Fastify reject it with "Body cannot be empty when
        // content-type is set to 'application/json'".
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'CoatiPay-Version': '0.1',
        'X-Request-Id': requestId,
        ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    const isAbort = err instanceof Error && err.name === 'AbortError'
    throw new NetworkError(isAbort ? `Request timed out: ${url}` : `Network error: ${url}`, err)
  } finally {
    clearTimeout(timer)
  }

  const data = (await res.json()) as { error?: unknown; node_operator?: string } & Record<
    string,
    unknown
  >

  config.logger?.({
    request_id: requestId,
    method: opts.method,
    path: opts.path,
    status: res.status,
    latency_ms: Date.now() - start,
    node_route: typeof data.node_operator === 'string' ? data.node_operator : null,
  })

  if (!res.ok) {
    throw classifyError(data.error as Parameters<typeof classifyError>[0])
  }

  return data as T
}

export { NetworkError }
