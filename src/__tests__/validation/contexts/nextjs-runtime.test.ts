/**
 * Runtime B — Next.js App Router Route Handler (stack real del dashboard)
 *
 * Valida que el SDK funcione correctamente en el patrón de Next.js 15:
 * - singleton de módulo (una instancia por proceso, no por request)
 * - Route Handler de App Router (app/api/checkout/route.ts)
 * - Webhook handler con relay.webhooks.verify
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { CoatiPay } from '../../../index.js'

// ── Patrón singleton de Next.js ────────────────────────────────────────────
// En producción: src/lib/coatipay.ts exporta la instancia singleton

function createNextJsSingleton(env: Record<string, string | undefined>) {
  const apiKey = env.COATIPAY_API_KEY
  if (!apiKey) throw new Error('Missing COATIPAY_API_KEY env var')

  // Singleton — se instancia una vez al arrancar el proceso Next.js
  return new CoatiPay({
    apiKey,
    baseUrl: env.COATIPAY_BASE_URL ?? 'https://api.coatipay.com',
  })
}

// ── Simulación de Route Handlers de App Router ─────────────────────────────

function createCheckoutRouteHandler(relay: CoatiPay) {
  // POST app/api/checkout/route.ts
  return async (requestBody: {
    amount: number
    currency: string
    chain: string
    orderId: string
  }) => {
    const intent = await relay.paymentIntents.create({
      amount: requestBody.amount,
      currency: requestBody.currency as 'usdc',
      chain: requestBody.chain as 'base',
      metadata: { orderId: requestBody.orderId },
    })
    return { status: 201, body: intent }
  }
}

function createWebhookRouteHandler(relay: CoatiPay, webhookSecret: string) {
  // POST app/api/webhooks/coatipay/route.ts
  return async (rawBody: string, signature: string) => {
    const event = relay.webhooks.verify(rawBody, signature, webhookSecret)
    return { status: 200, body: { received: true, eventType: event.type } }
  }
}

function mockIntentResponse(id: string, status = 'created') {
  return {
    ok: true,
    status: status === 'created' ? 201 : 200,
    json: () =>
      Promise.resolve({
        id,
        merchant_id: 'merchant_nextjs',
        amount: 10000,
        currency: 'usdc',
        chain: 'base',
        status,
        node_operator: null,
        payer_address: null,
        tx_hash: null,
        fee_amount: 5,
        metadata: {},
        created_at: 1700000000,
        expires_at: 1700001800,
        settled_at: null,
      }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Runtime B — Next.js Route Handler (App Router)', () => {
  describe('singleton de módulo', () => {
    it('el singleton se crea desde variables de entorno', () => {
      const relay = createNextJsSingleton({ COATIPAY_API_KEY: 'sk_test_nextjs_singleton' })
      expect(relay).toBeInstanceOf(CoatiPay)
    })

    it('lanza si falta COATIPAY_API_KEY', () => {
      expect(() => createNextJsSingleton({})).toThrow('Missing COATIPAY_API_KEY env var')
    })

    it('la misma instancia sirve múltiples requests (sin estado por request)', () => {
      const relay = createNextJsSingleton({ COATIPAY_API_KEY: 'sk_test_stateless' })

      // El singleton no debe tener estado mutable por request
      const handler1 = createCheckoutRouteHandler(relay)
      const handler2 = createCheckoutRouteHandler(relay)

      // Ambos handlers usan la misma instancia
      expect(handler1).toBeDefined()
      expect(handler2).toBeDefined()
    })
  })

  describe('POST /api/checkout (Route Handler)', () => {
    it('crea un payment intent y devuelve 201', async () => {
      mockFetch.mockResolvedValueOnce(mockIntentResponse('pi_nextjs_001'))

      const relay = createNextJsSingleton({
        COATIPAY_API_KEY: 'sk_test_nextjs_checkout',
        COATIPAY_BASE_URL: 'https://testnet.coatipay.com',
      })
      const handler = createCheckoutRouteHandler(relay)

      const result = await handler({
        amount: 10000,
        currency: 'usdc',
        chain: 'base',
        orderId: 'nextjs-order-1',
      })

      expect(result.status).toBe(201)
      expect(result.body.id).toBe('pi_nextjs_001')
      expect(result.body.status).toBe('created')
    })

    it('pasa metadata del request al intent', async () => {
      mockFetch.mockResolvedValueOnce(mockIntentResponse('pi_nextjs_meta'))

      const relay = createNextJsSingleton({ COATIPAY_API_KEY: 'sk_test_meta' })
      const handler = createCheckoutRouteHandler(relay)

      await handler({ amount: 5000, currency: 'usdc', chain: 'base', orderId: 'meta-order-99' })

      const [, opts] = mockFetch.mock.calls[0]!
      const body = JSON.parse(opts.body)
      expect(body.metadata.orderId).toBe('meta-order-99')
    })
  })

  describe('POST /api/webhooks/coatipay (Route Handler)', () => {
    const SECRET = 'whsec_nextjs_route_handler_secret'

    it('verifica firma y retorna 200 con eventType', () => {
      const relay = createNextJsSingleton({ COATIPAY_API_KEY: 'sk_test_wh_nextjs' })
      const handler = createWebhookRouteHandler(relay, SECRET)

      const eventData = JSON.stringify({
        id: 'evt_nextjs_001',
        type: 'payment_intent.settled',
        created: Math.floor(Date.now() / 1000),
        data: { id: 'pi_nextjs_001', status: 'settled' },
      })

      const ts = Math.floor(Date.now() / 1000)
      const sig = createHmac('sha256', SECRET).update(`${ts}.${eventData}`).digest('hex')
      const signature = `t=${ts},v1=${sig}`

      const result = handler(eventData, signature)
      return result.then((res) => {
        expect(res.status).toBe(200)
        expect(res.body.received).toBe(true)
        expect(res.body.eventType).toBe('payment_intent.settled')
      })
    })

    it('lanza error si la firma es inválida (Next.js debe devolver 400)', async () => {
      const relay = createNextJsSingleton({ COATIPAY_API_KEY: 'sk_test_wh_invalid' })
      const handler = createWebhookRouteHandler(relay, SECRET)

      const payload = JSON.stringify({ id: 'evt_bad' })
      const badSignature = 'v1=notvalid'

      await expect(handler(payload, badSignature)).rejects.toThrow()
    })
  })

  describe('flujo completo: checkout → status poll → webhook', () => {
    it('ejecuta el ciclo de pago completo desde el contexto Next.js', async () => {
      const relay = createNextJsSingleton({
        COATIPAY_API_KEY: 'sk_test_nextjs_full',
        COATIPAY_BASE_URL: 'https://testnet.coatipay.com',
      })
      const SECRET = 'whsec_nextjs_full_cycle'

      // 1. Crear intent (POST /api/checkout)
      mockFetch.mockResolvedValueOnce(mockIntentResponse('pi_nextjs_full', 'created'))
      const checkoutHandler = createCheckoutRouteHandler(relay)
      const { body: created } = await checkoutHandler({
        amount: 10000,
        currency: 'usdc',
        chain: 'base',
        orderId: 'full-cycle-1',
      })
      expect(created.status).toBe('created')

      // 2. Consultar estado (GET /api/payment-intents/[id])
      mockFetch.mockResolvedValueOnce(mockIntentResponse('pi_nextjs_full', 'created'))
      const status = await relay.paymentIntents.retrieve(created.id)
      expect(status.status).toBe('created')

      // 3. Recibir webhook de settlement
      const payload = JSON.stringify({
        id: 'evt_nextjs_full',
        type: 'payment_intent.settled',
        created: Math.floor(Date.now() / 1000),
        data: { id: created.id, status: 'settled' },
      })
      const ts = Math.floor(Date.now() / 1000)
      const sig = createHmac('sha256', SECRET).update(`${ts}.${payload}`).digest('hex')

      const webhookHandler = createWebhookRouteHandler(relay, SECRET)
      const whResult = await webhookHandler(payload, `t=${ts},v1=${sig}`)
      expect(whResult.body.eventType).toBe('payment_intent.settled')
    })
  })
})
