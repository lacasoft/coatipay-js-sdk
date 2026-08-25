/**
 * Runtime C — Serverless Handler (Fly.io Machines / Lambda-style)
 *
 * Valida que el SDK funcione en handlers sin estado entre invocaciones:
 * - Handler es una función pura: (Request) => Promise<Response>
 * - SDK puede re-inicializarse por invocación o usar singleton seguro
 * - Sin estado mutable compartido entre requests
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import type { LogEntry } from '../../../index.js'
import { NetworkError, CoatiPay } from '../../../index.js'

// ── Patrón de handler serverless puro ─────────────────────────────────────

interface ServerlessEnv {
  COATIPAY_API_KEY: string
  COATIPAY_BASE_URL?: string
  COATIPAY_WEBHOOK_SECRET?: string
}

function createPaymentHandler(env: ServerlessEnv) {
  // El SDK se instancia fuera del handler → singleton seguro (sin estado por request)
  const relay = new CoatiPay({
    apiKey: env.COATIPAY_API_KEY,
    baseUrl: env.COATIPAY_BASE_URL ?? 'https://api.coatipay.com',
  })

  return async function handler(requestBody: {
    amount: number
    currency: string
    chain: string
    idempotency_key?: string
  }) {
    const intent = await relay.paymentIntents.create({
      amount: requestBody.amount,
      currency: requestBody.currency as 'usdc',
      chain: requestBody.chain as 'base',
      // Conditional spread: avoid passing `idempotency_key: undefined` literally
      // (exactOptionalPropertyTypes rejects explicit-undefined for optional fields).
      ...(requestBody.idempotency_key && { idempotency_key: requestBody.idempotency_key }),
    })

    return {
      statusCode: 201,
      body: JSON.stringify(intent),
    }
  }
}

function createWebhookHandler(relay: CoatiPay, webhookSecret: string) {
  return function handler(rawBody: string, signature: string) {
    const event = relay.webhooks.verify(rawBody, signature, webhookSecret)
    return { statusCode: 200, body: JSON.stringify({ received: true, type: event.type }) }
  }
}

function mockIntent(id: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 201,
    json: () =>
      Promise.resolve({
        id,
        merchant_id: 'merchant_serverless',
        amount: 3000,
        currency: 'usdc',
        chain: 'base',
        status: 'created',
        node_operator: null,
        payer_address: null,
        tx_hash: null,
        fee_amount: 2,
        metadata: {},
        created_at: 1700000000,
        expires_at: 1700001800,
        settled_at: null,
        ...extra,
      }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Runtime C — Serverless Handler', () => {
  describe('inicialización por invocación vs singleton', () => {
    it('el SDK puede inicializarse como singleton fuera del handler', () => {
      const handler = createPaymentHandler({ COATIPAY_API_KEY: 'sk_test_sl_singleton' })
      expect(handler).toBeTypeOf('function')
    })

    it('múltiples invocaciones del handler usan la misma instancia del SDK', async () => {
      const handler = createPaymentHandler({
        COATIPAY_API_KEY: 'sk_test_sl_multi',
        COATIPAY_BASE_URL: 'https://testnet.coatipay.com',
      })

      mockFetch.mockResolvedValueOnce(mockIntent('pi_sl_inv1'))
      mockFetch.mockResolvedValueOnce(mockIntent('pi_sl_inv2'))

      await handler({ amount: 3000, currency: 'usdc', chain: 'base' })
      await handler({ amount: 3000, currency: 'usdc', chain: 'base' })

      // Ambas invocaciones llegan al mismo endpoint (mismo SDK)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch.mock.calls[0]![0]).toBe(mockFetch.mock.calls[1]![0])
    })

    it('no hay estado de request filtrado entre invocaciones', async () => {
      const handler = createPaymentHandler({
        COATIPAY_API_KEY: 'sk_test_sl_stateless',
        COATIPAY_BASE_URL: 'https://testnet.coatipay.com',
      })

      mockFetch.mockResolvedValueOnce(mockIntent('pi_inv_a'))
      mockFetch.mockResolvedValueOnce(mockIntent('pi_inv_b'))

      const _r1 = await handler({
        amount: 1000,
        currency: 'usdc',
        chain: 'base',
        idempotency_key: 'key-a',
      })
      const _r2 = await handler({
        amount: 2000,
        currency: 'usdc',
        chain: 'base',
        idempotency_key: 'key-b',
      })

      // Las claves de idempotencia son independientes entre invocaciones
      expect(mockFetch.mock.calls[0]![1].headers['Idempotency-Key']).toBe('key-a')
      expect(mockFetch.mock.calls[1]![1].headers['Idempotency-Key']).toBe('key-b')

      // Los bodies no se filtran entre requests
      const body1 = JSON.parse(mockFetch.mock.calls[0]![1].body)
      const body2 = JSON.parse(mockFetch.mock.calls[1]![1].body)
      expect(body1.amount).toBe(1000)
      expect(body2.amount).toBe(2000)
    })
  })

  describe('handler de payment (cold start)', () => {
    it('responde correctamente en la primera invocación (cold start)', async () => {
      mockFetch.mockResolvedValueOnce(mockIntent('pi_cold_001'))

      const handler = createPaymentHandler({
        COATIPAY_API_KEY: 'sk_test_sl_cold',
        COATIPAY_BASE_URL: 'https://testnet.coatipay.com',
      })

      const result = await handler({ amount: 3000, currency: 'usdc', chain: 'base' })

      expect(result.statusCode).toBe(201)
      const body = JSON.parse(result.body)
      expect(body.id).toBe('pi_cold_001')
      expect(body.status).toBe('created')
    })

    it('pasa idempotency_key como header en el handler serverless', async () => {
      mockFetch.mockResolvedValueOnce(mockIntent('pi_sl_idem'))

      const handler = createPaymentHandler({
        COATIPAY_API_KEY: 'sk_test_sl_idem',
        COATIPAY_BASE_URL: 'https://testnet.coatipay.com',
      })

      await handler({
        amount: 3000,
        currency: 'usdc',
        chain: 'base',
        idempotency_key: 'sl-order-42',
      })

      expect(mockFetch.mock.calls[0]![1].headers['Idempotency-Key']).toBe('sl-order-42')
    })
  })

  describe('handler de webhook (sin estado)', () => {
    const WEBHOOK_SECRET = 'whsec_serverless_secret'

    it('verifica signature en cada invocación independientemente', () => {
      const relay = new CoatiPay({
        apiKey: 'sk_test_sl_webhook',
        baseUrl: 'https://testnet.coatipay.com',
      })
      const webhookHandler = createWebhookHandler(relay, WEBHOOK_SECRET)

      const payload = JSON.stringify({
        id: 'evt_sl_001',
        type: 'payment_intent.settled',
        created: Math.floor(Date.now() / 1000),
        data: { id: 'pi_sl_001', status: 'settled' },
      })

      const ts = Math.floor(Date.now() / 1000)
      const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex')

      const result = webhookHandler(payload, `t=${ts},v1=${sig}`)
      const body = JSON.parse(result.body)

      expect(result.statusCode).toBe(200)
      expect(body.received).toBe(true)
      expect(body.type).toBe('payment_intent.settled')
    })
  })

  describe('logging estructurado en contexto serverless', () => {
    it('el logger recibe entradas con latency y request_id por invocación', async () => {
      const logs: LogEntry[] = []
      const relay = new CoatiPay({
        apiKey: 'sk_test_sl_log',
        baseUrl: 'https://testnet.coatipay.com',
        logger: (e) => logs.push(e),
      })

      mockFetch.mockResolvedValueOnce(mockIntent('pi_sl_log'))
      await relay.paymentIntents.create({ amount: 3000, currency: 'usdc', chain: 'base' })

      expect(logs).toHaveLength(1)
      expect(logs[0]!.request_id).toMatch(/^[0-9a-f-]{36}$/)
      expect(logs[0]!.latency_ms).toBeGreaterThanOrEqual(0)
      expect(logs[0]!.method).toBe('POST')
    })
  })

  describe('comportamiento en condiciones de error', () => {
    it('lanza NetworkError en timeout — el handler serverless debe capturarlo', async () => {
      const abortErr = new Error('signal timed out')
      abortErr.name = 'AbortError'
      mockFetch.mockRejectedValueOnce(abortErr)

      const relay = new CoatiPay({ apiKey: 'sk_test_sl_timeout', timeout: 100 })

      await expect(
        relay.paymentIntents.create({ amount: 1000, currency: 'usdc', chain: 'base' }),
      ).rejects.toBeInstanceOf(NetworkError)
    })
  })
})
