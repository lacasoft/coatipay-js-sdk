import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WebhookEvent } from '@lacasoft/coatipay-protocol'
import type { CoatiPayConfig } from '../lib/types'
import { request } from '../lib/types'

/**
 * Default tolerance for the `t=` timestamp in the signature header.
 * 5 minutes — Stripe-equivalent. Tighter than that risks rejecting webhooks
 * delivered after a brief retry; looser opens a wider replay window.
 */
const DEFAULT_TOLERANCE_SECONDS = 300

export class Webhooks {
  constructor(private config: CoatiPayConfig) {}

  async register(
    url: string,
    events: string[],
  ): Promise<{ id: string; url: string; secret: string }> {
    return request(this.config, {
      method: 'POST',
      path: '/webhooks',
      body: { url, events },
    })
  }

  /**
   * Verify a webhook payload signature.
   * Call this in your webhook handler to ensure the request is from CoatiPay.
   *
   * Validates: (1) signature format, (2) timestamp freshness against
   * `toleranceSeconds` to mitigate replay, (3) HMAC equality with
   * timing-safe compare.
   *
   * @example
   * const event = relay.webhooks.verify(rawBody, req.headers['x-signature'], secret)
   */
  verify(
    payload: string,
    signature: string,
    secret: string,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  ): WebhookEvent {
    const parts = signature.split(',')
    const ts = parts.find((p) => p.startsWith('t='))?.slice(2)
    const sig = parts.find((p) => p.startsWith('v1='))?.slice(3)

    if (!ts || !sig) throw new Error('Invalid signature format')

    // Anti-replay: reject signatures whose `t=` is outside the tolerance
    // window. Mirrors what packages/sdk-python and packages/sdk-php do.
    const timestamp = Number(ts)
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error('Invalid signature format')
    }
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
      throw new Error('Signature timestamp outside tolerance window')
    }

    const expected = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')

    // Timing-safe equality: prevents byte-by-byte timing attacks against the
    // HMAC comparison. timingSafeEqual requires equal-length buffers, which
    // for hex-encoded sha256 is guaranteed (64 chars) — but we still guard.
    if (sig.length !== expected.length) {
      throw new Error('Signature verification failed')
    }
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new Error('Signature verification failed')
    }

    return JSON.parse(payload) as WebhookEvent
  }
}
