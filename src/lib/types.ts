import { randomUUID } from 'node:crypto'
import {
  type CoatiPayErrorCode,
  classifyError,
  docUrl,
  NetworkError,
} from '@lacasoft/coatipay-protocol'

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

  // The same rule in every CoatiPay SDK (shared vectors:
  // `@lacasoft/coatipay-protocol/vectors/errores.json`, `respuestas`). A body
  // that is not JSON is not a CoatiPay answer, even with a 2xx: a proxy's 502
  // is HTML.
  let data: unknown
  let esJson = true
  let causa: unknown
  try {
    data = await res.json()
  } catch (err) {
    esJson = false
    causa = err
  }
  const cuerpo = esObjeto(data) ? data : null

  config.logger?.({
    request_id: requestId,
    method: opts.method,
    path: opts.path,
    status: res.status,
    latency_ms: Date.now() - start,
    node_route: typeof cuerpo?.node_operator === 'string' ? cuerpo.node_operator : null,
  })

  if (!esJson) {
    throw new NetworkError(`Response is not JSON (HTTP ${res.status}): ${url}`, causa, res.status)
  }
  if (res.ok) return data as T

  // A CoatiPay error is an object whose `error` is an object with a non-empty
  // `code`. Anything else (Fastify's default error, a proxy's JSON) is not.
  const error = cuerpo?.error
  if (!esObjeto(error) || typeof error.code !== 'string' || error.code === '') {
    throw new NetworkError(`Response is not a CoatiPay error (HTTP ${res.status}): ${url}`, data, res.status)
  }
  throw classifyError({
    // A code this version does not know (a newer API) becomes the base class.
    code: error.code as CoatiPayErrorCode,
    message: typeof error.message === 'string' ? error.message : 'Unknown error',
    param: typeof error.param === 'string' ? error.param : null,
    doc_url: typeof error.doc_url === 'string' ? error.doc_url : docUrl(error.code),
  })
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export { NetworkError }
