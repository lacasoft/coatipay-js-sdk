import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WebhookEvent, WebhookEventType } from '@lacasoft/coatipay-protocol'
import type { CoatiPayConfig } from '../lib/types'
import { request } from '../lib/types'

/**
 * Default tolerance for the `t=` timestamp in the signature header.
 * 5 minutes — Stripe-equivalent. Tighter than that risks rejecting webhooks
 * delivered after a brief retry; looser opens a wider replay window.
 */
const DEFAULT_TOLERANCE_SECONDS = 300

/** Why a webhook signature was rejected. The same reasons in every CoatiPay SDK. */
export type WebhookSignatureReason =
  | 'malformed_header'
  | 'timestamp_out_of_tolerance'
  | 'no_matching_signature'

/** Thrown by `webhooks.verify` when the request cannot be trusted. */
export class WebhookSignatureError extends Error {
  readonly reason: WebhookSignatureReason
  constructor(reason: WebhookSignatureReason, message: string) {
    super(message)
    this.name = 'WebhookSignatureError'
    this.reason = reason
  }
}

export interface VerifyOptions {
  /** Seconds the `t=` timestamp may differ from now. Default 300. */
  tolerance?: number
  /** Current time in seconds. Default: the system clock. For tests. */
  now?: number
}

/** A webhook delivery that exhausted its retries (dead-letter queue). */
export interface DeadLetter {
  id: string
  endpoint_id: string
  endpoint_url: string
  event_id: string
  event_type: string
  /** The `X-Delivery-Id` of that delivery. */
  delivery_id: string
  attempts: number
  last_error: string | null
  last_attempted_at: number
  created_at: number
  replayed_at: number | null
  /** The signed event body, as it was sent. */
  payload: Record<string, unknown>
}

export class Webhooks {
  constructor(private config: CoatiPayConfig) {}

  /**
   * Register an endpoint. The returned `secret` signs its deliveries and is
   * only returned here: store it.
   */
  async register(
    url: string,
    events: WebhookEventType[],
  ): Promise<{ id: string; url: string; events: WebhookEventType[]; secret: string; created_at: number }> {
    return request(this.config, {
      method: 'POST',
      path: '/webhooks',
      body: { url, events },
    })
  }

  /** Deliveries that exhausted their retries, newest first. Secret key. */
  async listDeadLetters(params: { limit?: number } = {}): Promise<{
    data: DeadLetter[]
    has_more: boolean
  }> {
    const query = params.limit !== undefined ? `?limit=${encodeURIComponent(params.limit)}` : ''
    return request(this.config, { method: 'GET', path: `/webhooks/dead_letters${query}` })
  }

  /**
   * Send a dead letter again: the same event, with the same id, to the same
   * endpoint, retries reset. Secret key.
   */
  async replayDeadLetter(id: string): Promise<DeadLetter> {
    return request(this.config, {
      method: 'POST',
      path: `/webhooks/dead_letters/${encodeURIComponent(id)}/replay`,
    })
  }

  /**
   * Verify a webhook's `X-Signature` header and return the parsed event.
   * Call it in your webhook handler with the RAW request body.
   *
   * The same rules in every CoatiPay SDK (shared test vectors in
   * `@lacasoft/coatipay-protocol/vectors/webhooks.json`):
   *   - `t=<seconds>,v1=<hex>` parts, comma-separated; a part without `=` or
   *     without a key, a missing or repeated `t`, a `t` that is not all
   *     digits, or no `v1` → `malformed_header`.
   *   - `|now − t|` above the tolerance → `timestamp_out_of_tolerance`.
   *   - Valid if ANY `v1` is the HMAC-SHA256 of `<t>.<body>` with your secret,
   *     so a secret can be rotated without dropping deliveries; otherwise
   *     `no_matching_signature`.
   *
   * @param options Tolerance in seconds (a number, as before), or
   *   `{ tolerance, now }`.
   * @throws {WebhookSignatureError} with the `reason`.
   *
   * @example
   * const event = relay.webhooks.verify(rawBody, req.headers['x-signature'], secret)
   */
  verify(
    payload: string,
    signature: string,
    secret: string,
    options: number | VerifyOptions = {},
  ): WebhookEvent {
    const { tolerance = DEFAULT_TOLERANCE_SECONDS, now = Math.floor(Date.now() / 1000) } =
      typeof options === 'number' ? { tolerance: options } : options

    const ts: string[] = []
    const firmas: string[] = []
    for (const bruta of signature.split(',')) {
      const parte = bruta.trim()
      const igual = parte.indexOf('=')
      if (igual <= 0) throw new WebhookSignatureError('malformed_header', 'Invalid signature format')
      const clave = parte.slice(0, igual)
      if (clave === 't') ts.push(parte.slice(igual + 1))
      if (clave === 'v1') firmas.push(parte.slice(igual + 1))
    }
    const t = ts[0]
    if (ts.length !== 1 || t === undefined || !/^\d+$/.test(t) || firmas.length === 0) {
      throw new WebhookSignatureError('malformed_header', 'Invalid signature format')
    }

    if (Math.abs(now - Number(t)) > tolerance) {
      throw new WebhookSignatureError(
        'timestamp_out_of_tolerance',
        'Signature timestamp outside tolerance window',
      )
    }

    const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex'))
    const coincide = firmas.some((f) => {
      const recibida = Buffer.from(f)
      return recibida.length === expected.length && timingSafeEqual(recibida, expected)
    })
    if (!coincide) {
      throw new WebhookSignatureError('no_matching_signature', 'Signature verification failed')
    }

    return JSON.parse(payload) as WebhookEvent
  }
}
