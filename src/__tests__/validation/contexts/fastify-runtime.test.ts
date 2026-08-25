/**
 * Runtime A — Fastify/Node.js (stack real del backend CoatiPay)
 *
 * Valida que el SDK funcione correctamente integrado como plugin de Fastify:
 * - inicialización desde env vars
 * - decorator accesible en route handlers
 * - flujo completo create → retrieve → cancel
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { CoatiPay } from '../../../index.js'

// ── Simulación del plugin Fastify ──────────────────────────────────────────
// En producción: fastify.decorate('coatipay', new CoatiPay({ apiKey: process.env.COATIPAY_API_KEY! }))

function createFastifyPlugin(env: Record<string, string>) {
  if (!env.COATIPAY_API_KEY) throw new Error('COATIPAY_API_KEY is required')

  const relay = new CoatiPay({
    apiKey: env.COATIPAY_API_KEY,
    baseUrl: env.COATIPAY_BASE_URL ?? 'https://api.coatipay.com',
    // Conditional spread: don't pass `logger: undefined` literally because
    // exactOptionalPropertyTypes rejects explicit-undefined for optional fields.
    ...(env.COATIPAY_LOG === 'true' && {
      logger: (entry: unknown) => console.info('[coatipay]', JSON.stringify(entry)),
    }),
  })

  // Simula el decorator de Fastify: fastify.coatipay = relay
  return { coatipay: relay }
}

function mockIntent(id: string, status = 'created', extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: status === 'created' ? 201 : 200,
    json: () =>
      Promise.resolve({
        id,
        merchant_id: 'merchant_fastify',
        amount: 25000,
        currency: 'usdc',
        chain: 'base',
        status,
        node_operator: null,
        payer_address: null,
        tx_hash: null,
        fee_amount: 13,
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

describe('Runtime A — Fastify/Node.js', () => {
  describe('inicialización del plugin', () => {
    it('inicializa el SDK desde variables de entorno', () => {
      const plugin = createFastifyPlugin({
        COATIPAY_API_KEY: 'sk_test_fastify_env',
        COATIPAY_BASE_URL: 'https://testnet.coatipay.com',
      })

      expect(plugin.coatipay).toBeInstanceOf(CoatiPay)
      expect(plugin.coatipay.paymentIntents).toBeDefined()
    })

    it('lanza error si COATIPAY_API_KEY no está configurada', () => {
      expect(() => createFastifyPlugin({})).toThrow('COATIPAY_API_KEY is required')
    })

    it('usa baseUrl de prod cuando no se especifica COATIPAY_BASE_URL', () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [], has_more: false }),
      })

      const { coatipay } = createFastifyPlugin({ COATIPAY_API_KEY: 'sk_test_prod_url' })
      void coatipay.paymentIntents.list()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('api.coatipay.com'),
        expect.anything(),
      )
    })
  })

  describe('handler de checkout (POST /checkout)', () => {
    it('crea un payment intent desde un Fastify route handler', async () => {
      mockFetch.mockResolvedValueOnce(mockIntent('pi_fastify_001'))

      const { coatipay } = createFastifyPlugin({
        COATIPAY_API_KEY: 'sk_test_fastify_handler',
        COATIPAY_BASE_URL: 'https://testnet.coatipay.com',
      })

      // Simula el handler: relay.paymentIntents.create(req.body)
      const intent = await coatipay.paymentIntents.create({
        amount: 25000,
        currency: 'usdc',
        chain: 'base',
        metadata: { orderId: 'fastify-order-1' },
      })

      expect(intent.id).toBe('pi_fastify_001')
      expect(intent.status).toBe('created')
    })

    it('consulta el estado del intent desde un GET handler', async () => {
      mockFetch.mockResolvedValueOnce(
        mockIntent('pi_fastify_001', 'created', { node_operator: '0xFastifyNode' }),
      )

      const { coatipay } = createFastifyPlugin({ COATIPAY_API_KEY: 'sk_test_fastify_get' })
      const intent = await coatipay.paymentIntents.retrieve('pi_fastify_001')

      expect(intent.status).toBe('created')
      expect(intent.node_operator).toBe('0xFastifyNode')
    })
  })

  describe('handler de webhook (POST /webhooks)', () => {
    it('verifica firma en el handler de webhook de Fastify', () => {
      const { coatipay } = createFastifyPlugin({ COATIPAY_API_KEY: 'sk_test_fastify_wh' })
      const secret = 'whsec_fastify_plugin_secret'

      // Simula los datos que llegan al handler de Fastify
      const rawBody = JSON.stringify({
        id: 'evt_fastify_001',
        type: 'payment_intent.settled',
        created: 1700001000,
        data: { id: 'pi_fastify_001', status: 'settled' },
      })

      const ts = Math.floor(Date.now() / 1000)
      const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
      const signature = `t=${ts},v1=${sig}`

      // En el handler real: const event = fastify.coatipay.webhooks.verify(rawBody, req.headers['x-signature'], secret)
      const event = coatipay.webhooks.verify(rawBody, signature, secret)

      expect(event.type).toBe('payment_intent.settled')
    })
  })

  describe('flujo completo: create → retrieve → cancel', () => {
    it('ejecuta el flujo de lifecycle de un payment intent en Fastify', async () => {
      const { coatipay } = createFastifyPlugin({
        COATIPAY_API_KEY: 'sk_test_fastify_lifecycle',
        COATIPAY_BASE_URL: 'https://testnet.coatipay.com',
      })

      mockFetch
        .mockResolvedValueOnce(mockIntent('pi_lifecycle', 'created'))
        .mockResolvedValueOnce(mockIntent('pi_lifecycle', 'created'))
        .mockResolvedValueOnce(mockIntent('pi_lifecycle', 'cancelled'))

      const created = await coatipay.paymentIntents.create({
        amount: 25000,
        currency: 'usdc',
        chain: 'base',
      })
      expect(created.status).toBe('created')

      const retrieved = await coatipay.paymentIntents.retrieve(created.id)
      expect(retrieved.status).toBe('created')

      const cancelled = await coatipay.paymentIntents.cancel(created.id)
      expect(cancelled.status).toBe('cancelled')
    })
  })
})
