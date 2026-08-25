import type { CreatePaymentIntentParams, PaymentIntent } from '@lacasoft/coatipay-protocol'
import { MAX_BATCH_SIZE } from '@lacasoft/coatipay-protocol'
import type { Address, Hex } from 'viem'
import {
  splitSignature as _splitSignature,
  type AuthorizationTypedData,
  type BuildAuthorizationParams,
  buildReceiveAuthorizationTypedData,
  type SignedAuthorization,
  signReceiveAuthorization,
} from '../lib/eip712'
import type { CoatiPayConfig } from '../lib/types'
import { request } from '../lib/types'

export interface SubmitAuthorizationResponse {
  /** Echoed intent id. */
  intent_id: string
  /** Server-side estimate of when the operator will submit it on-chain. */
  estimated_settlement_at: string | null
  /** Authorization persisted server-side, awaiting operator pickup. */
  status: 'queued'
}

export interface SubmitAuthorizationBatchResponse {
  /** Per-authorization queueing result. Order matches the input. */
  results: Array<{ intent_id: string; status: 'queued' | 'rejected'; reason?: string }>
  queued: number
  rejected: number
}

export class PaymentIntents {
  constructor(private config: CoatiPayConfig) {}

  /**
   * Create a new payment intent.
   *
   * @example
   * const intent = await relay.paymentIntents.create({
   *   amount: 1000,      // $0.001000 USDC (6 decimals)
   *   currency: 'usdc',
   *   chain: 'base',
   *   metadata: { orderId: 'order_123' }
   * })
   */
  async create(params: CreatePaymentIntentParams): Promise<PaymentIntent> {
    const { idempotency_key, ...body } = params
    return request<PaymentIntent>(this.config, {
      method: 'POST',
      path: '/payment_intents',
      body,
      ...(idempotency_key ? { idempotencyKey: idempotency_key } : {}),
    })
  }

  /**
   * Retrieve a payment intent by ID.
   */
  async retrieve(id: string): Promise<PaymentIntent> {
    return request<PaymentIntent>(this.config, {
      method: 'GET',
      path: `/payment_intents/${id}`,
    })
  }

  /**
   * Cancel a payment intent (only valid while it is in 'created' state).
   */
  async cancel(id: string): Promise<PaymentIntent> {
    return request<PaymentIntent>(this.config, {
      method: 'POST',
      path: `/payment_intents/${id}/cancel`,
    })
  }

  /**
   * List payment intents for the authenticated merchant.
   */
  async list(params?: { limit?: number; starting_after?: string }): Promise<{
    data: PaymentIntent[]
    has_more: boolean
  }> {
    const qs = new URLSearchParams()
    if (params?.limit) qs.set('limit', String(params.limit))
    if (params?.starting_after) qs.set('starting_after', params.starting_after)

    return request(this.config, {
      method: 'GET',
      path: `/payment_intents?${qs.toString()}`,
    })
  }

  // ── Gasless settlement (ERC-3009 / ADR-003) ────────────────────────

  /**
   * Build the EIP-712 typed-data structure for `ReceiveWithAuthorization`
   * that USDC verifies on `payIntentWithAuthorization`. Hand the result to
   * a wallet (viem `walletClient.signTypedData`, `window.ethereum`, etc.)
   * to obtain a signature client-side.
   *
   * For server-side signing with a private key, prefer `signAuthorization`.
   *
   * @example (browser/wallet flow)
   * const typed = relay.paymentIntents.buildAuthorizationTypedData({
   *   payer: '0xPayer...',
   *   amount: 5_000_000n,                          // 5 USDC (6 decimals)
   *   settlementHub: '0xHub...',
   *   chain: 'base-sepolia',
   * })
   * const signature = await walletClient.signTypedData(typed)
   * await relay.paymentIntents.submitAuthorization(intentId, {
   *   payer: typed.message.from,
   *   validAfter: typed.message.validAfter,
   *   validBefore: typed.message.validBefore,
   *   nonce: typed.message.nonce,
   *   signature, // raw sig — works for EOA (65-byte) AND ERC-1271 smart wallets
   * })
   */
  buildAuthorizationTypedData(params: BuildAuthorizationParams): AuthorizationTypedData {
    return buildReceiveAuthorizationTypedData(params)
  }

  /**
   * Server-side convenience: build + sign the `ReceiveWithAuthorization`
   * message in one call. Returns everything needed for `submitAuthorization`.
   *
   * @example
   * const auth = await relay.paymentIntents.signAuthorization(
   *   { payer, amount: 5_000_000n, settlementHub, chain: 'base-sepolia' },
   *   privateKey,
   * )
   * await relay.paymentIntents.submitAuthorization(intentId, auth)
   */
  async signAuthorization(
    params: BuildAuthorizationParams,
    privateKey: Hex,
  ): Promise<SignedAuthorization> {
    return signReceiveAuthorization(params, privateKey)
  }

  /**
   * Submit a signed authorization for a registered intent. The API queues
   * it for the assigned operator to settle on-chain (via
   * `SettlementHub.payIntentWithAuthorization`).
   *
   * The endpoint is implemented in Phase B3; this client method targets
   * the documented path so SDK + API can be developed in parallel.
   */
  async submitAuthorization(
    intentId: string,
    auth: SignedAuthorization,
  ): Promise<SubmitAuthorizationResponse> {
    return request<SubmitAuthorizationResponse>(this.config, {
      method: 'POST',
      path: `/payment_intents/${intentId}/authorize`,
      body: serializeAuthorization(auth),
    })
  }

  /**
   * Submit multiple signed authorizations in one HTTP request. The operator
   * may settle them via `SettlementHub.payIntentBatchWithAuthorization`
   * (skip-on-failure). Useful for x402 micropayment flows where many small
   * payments are aggregated.
   *
   * Hard cap: `MAX_BATCH_SIZE` (matches `SettlementHub.MAX_BATCH_SIZE`,
   * imported from `@lacasoft/coatipay-protocol` SSOT — never hardcode the literal).
   */
  async submitAuthorizationBatch(
    items: Array<{ intent_id: string; authorization: SignedAuthorization }>,
  ): Promise<SubmitAuthorizationBatchResponse> {
    if (items.length === 0) {
      return { results: [], queued: 0, rejected: 0 }
    }
    if (items.length > MAX_BATCH_SIZE) {
      throw new Error(
        `Batch too large: ${items.length} authorizations (max ${MAX_BATCH_SIZE}, see SettlementHub.MAX_BATCH_SIZE)`,
      )
    }
    return request<SubmitAuthorizationBatchResponse>(this.config, {
      method: 'POST',
      path: '/payment_intents/batch/authorize',
      body: {
        items: items.map((it) => ({
          intent_id: it.intent_id,
          authorization: serializeAuthorization(it.authorization),
        })),
      },
    })
  }

  /**
   * Helper to split a 65-byte signature (e.g. from `walletClient.signTypedData`)
   * into the {v, r, s} triple that `submitAuthorization` expects.
   */
  splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
    return _splitSignature(signature)
  }
}

// ── Wire helpers ────────────────────────────────────────────────────────

/** Convert SignedAuthorization (with bigint fields) to JSON-safe shape. */
function serializeAuthorization(auth: SignedAuthorization): {
  payer: Address
  valid_after: string
  valid_before: string
  nonce: Hex
  signature: Hex
} {
  return {
    payer: auth.payer,
    valid_after: auth.validAfter.toString(),
    valid_before: auth.validBefore.toString(),
    nonce: auth.nonce,
    signature: auth.signature,
  }
}
