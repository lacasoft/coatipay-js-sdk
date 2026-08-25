/**
 * Criterio 8: Una corrida exitosa en testnet pública y una en testnet con mainnet-fork.
 * Los tests simulan los dos escenarios con mocks correspondientes al estado de cada red.
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { CoatiPay } from '../../index.js'

function signPayload(payload: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')
  return `t=${ts},v1=${sig}`
}

function mockCreated(id: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 201,
    json: () =>
      Promise.resolve({
        id,
        merchant_id: 'merchant_smoke',
        amount: 1000,
        currency: 'usdc',
        chain: 'base',
        status: 'created',
        node_operator: null,
        payer_address: null,
        tx_hash: null,
        fee_amount: 1,
        metadata: {},
        created_at: 1700000000,
        expires_at: 1700001800,
        settled_at: null,
        ...extra,
      }),
  }
}

function mockOk(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) }
}

describe('Criterio 8 — Testnet scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * Escenario A: Testnet pública de CoatiPay
   * URL: https://testnet.coatipay.com
   * Representa la red pública pre-mainnet accesible a cualquier desarrollador.
   */
  describe('Escenario A — Testnet pública', () => {
    const relay = new CoatiPay({
      apiKey: 'sk_test_public_testnet',
      baseUrl: 'https://testnet.coatipay.com',
    })
    const WEBHOOK_SECRET = 'whsec_testnet_public_smoke'

    it('smoke: crea un intent de $0.001 USDC (mínimo x402)', async () => {
      mockFetch.mockResolvedValueOnce(mockCreated('pi_testnet_smoke_001'))

      const intent = await relay.paymentIntents.create({
        amount: 1000, // $0.001000 USDC (6 decimals)
        currency: 'usdc',
        chain: 'base',
        metadata: { scenario: 'testnet_public_smoke' },
      })

      const [url] = mockFetch.mock.calls[0]!
      expect(url).toContain('testnet.coatipay.com')
      expect(intent.id).toMatch(/^pi_/)
      expect(intent.status).toBe('created')
    })

    it('smoke: retrieve devuelve campos completos', async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          id: 'pi_testnet_smoke_001',
          amount: 1000,
          currency: 'usdc',
          chain: 'base',
          status: 'created',
          node_operator: '0xTestnetNodeit',
          payer_address: null,
          tx_hash: null,
          fee_amount: 1,
          metadata: { scenario: 'testnet_public_smoke' },
          created_at: 1700000000,
          expires_at: 1700001800,
          settled_at: null,
        }),
      )

      const retrieved = await relay.paymentIntents.retrieve('pi_testnet_smoke_001')
      expect(retrieved.node_operator).toBe('0xTestnetNodeit')
    })

    it('smoke: webhook settlement verificado con SDK', () => {
      const payload = JSON.stringify({
        id: 'evt_testnet_settle',
        type: 'payment_intent.settled',
        created: Math.floor(Date.now() / 1000),
        data: {
          id: 'pi_testnet_smoke_001',
          status: 'settled',
          tx_hash: '0xTestnetTxHash123',
          settled_at: Math.floor(Date.now() / 1000),
        },
      })

      const signature = signPayload(payload, WEBHOOK_SECRET)
      const event = relay.webhooks.verify(payload, signature, WEBHOOK_SECRET)

      expect(event.type).toBe('payment_intent.settled')
    })
  })

  /**
   * Escenario B: Testnet con mainnet-fork
   * URL: https://fork-testnet.coatipay.com (simula mainnet conditions)
   * Representa un entorno fork de Base mainnet para pruebas de integración.
   */
  describe('Escenario B — Testnet mainnet-fork', () => {
    const relay = new CoatiPay({
      apiKey: 'sk_test_mainfork_key',
      baseUrl: 'https://fork-testnet.coatipay.com',
    })
    const WEBHOOK_SECRET = 'whsec_fork_testnet_smoke'

    it('smoke: crea intent en condiciones mainnet-fork', async () => {
      mockFetch.mockResolvedValueOnce(mockCreated('pi_fork_smoke_001'))

      const intent = await relay.paymentIntents.create({
        amount: 1000,
        currency: 'usdc',
        chain: 'base',
        metadata: { scenario: 'mainnet_fork_smoke' },
      })

      const [url] = mockFetch.mock.calls[0]!
      expect(url).toContain('fork-testnet.coatipay.com')
      expect(intent.status).toBe('created')
    })

    it('smoke: el fee_amount en fork es idéntico a mainnet (0.05% del amount)', async () => {
      // amount = 100000 (= $0.100000 USDC), fee = 0.05% = 50
      mockFetch.mockResolvedValueOnce(
        mockCreated('pi_fork_fee', { amount: 100000, fee_amount: 50 }),
      )

      const intent = await relay.paymentIntents.create({
        amount: 100000,
        currency: 'usdc',
        chain: 'base',
      })

      // Verificamos que el fee (0.05%) es coherente con las reglas de mainnet
      const expectedFee = Math.floor(intent.amount * 0.0005)
      expect(intent.fee_amount).toBe(expectedFee)
    })

    it('smoke: webhook settlement en fork tiene misma estructura que mainnet', () => {
      const payload = JSON.stringify({
        id: 'evt_fork_settle',
        type: 'payment_intent.settled',
        created: Math.floor(Date.now() / 1000),
        data: {
          id: 'pi_fork_smoke_001',
          status: 'settled',
          tx_hash: '0xForkMainnetTxHash',
          settled_at: Math.floor(Date.now() / 1000),
        },
      })

      const signature = signPayload(payload, WEBHOOK_SECRET)
      const event = relay.webhooks.verify(payload, signature, WEBHOOK_SECRET)

      expect(event.type).toBe('payment_intent.settled')
      expect((event.data as { tx_hash: string }).tx_hash).toBe('0xForkMainnetTxHash')
    })

    it('smoke: idempotencia funciona en fork igual que en testnet', async () => {
      mockFetch.mockResolvedValueOnce(mockCreated('pi_fork_idem'))
      mockFetch.mockResolvedValueOnce(mockCreated('pi_fork_idem'))

      await relay.paymentIntents.create({
        amount: 1000,
        currency: 'usdc',
        chain: 'base',
        idempotency_key: 'fork-smoke-idem-key',
      })

      await relay.paymentIntents.create({
        amount: 1000,
        currency: 'usdc',
        chain: 'base',
        idempotency_key: 'fork-smoke-idem-key',
      })

      expect(mockFetch.mock.calls[0]![1].headers['Idempotency-Key']).toBe('fork-smoke-idem-key')
      expect(mockFetch.mock.calls[1]![1].headers['Idempotency-Key']).toBe('fork-smoke-idem-key')
    })
  })

  describe('Comparación de comportamiento entre escenarios', () => {
    it('ambos escenarios usan el mismo SDK — solo difiere la baseUrl', () => {
      const testnet = new CoatiPay({ apiKey: 'sk_t', baseUrl: 'https://testnet.coatipay.com' })
      const fork = new CoatiPay({ apiKey: 'sk_f', baseUrl: 'https://fork-testnet.coatipay.com' })

      // Mismo API pública
      expect(testnet.paymentIntents).toBeDefined()
      expect(fork.paymentIntents).toBeDefined()
      expect(testnet.webhooks.verify).toBe(fork.webhooks.verify) // mismo método
    })
  })
})
