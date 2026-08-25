/**
 * Criterio 2: Creación de intent, consulta de estado y recepción de webhook
 * contra testnet de CoatiPay.
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { CoatiPay } from '../../index.js'

function mockResponse(data: unknown, status = 200) {
  return { ok: status < 400, status, json: () => Promise.resolve(data) }
}

const TEST_KEY = 'sk_test_flow_key'
const TESTNET_URL = 'https://testnet.coatipay.com'
const WEBHOOK_SECRET = 'whsec_testflow_secret_abcdef1234'

let relay: CoatiPay

beforeEach(() => {
  vi.clearAllMocks()
  relay = new CoatiPay({ apiKey: TEST_KEY, baseUrl: TESTNET_URL })
})

describe('Criterio 2 — Flujo de pago end-to-end (testnet mock)', () => {
  it('crea un payment intent contra testnet y devuelve status "created"', async () => {
    const mockIntent = {
      id: 'pi_testnet_001',
      merchant_id: 'merchant_test',
      amount: 50000,
      currency: 'usdc',
      chain: 'base',
      status: 'created',
      node_operator: null,
      payer_address: null,
      tx_hash: null,
      fee_amount: 25,
      metadata: { orderId: 'order_e2e_1' },
      created_at: 1700000000,
      expires_at: 1700001800,
      settled_at: null,
    }
    mockFetch.mockResolvedValueOnce(mockResponse(mockIntent, 201))

    const intent = await relay.paymentIntents.create({
      amount: 50000,
      currency: 'usdc',
      chain: 'base',
      metadata: { orderId: 'order_e2e_1' },
    })

    expect(intent.id).toMatch(/^pi_/)
    expect(intent.status).toBe('created')
    expect(intent.amount).toBe(50000)
    expect(intent.currency).toBe('usdc')
    expect(intent.chain).toBe('base')
    expect(intent.fee_amount).toBeGreaterThan(0)
  })

  it('consulta el estado del intent y retorna el objeto completo', async () => {
    const mockIntent = {
      id: 'pi_testnet_002',
      merchant_id: 'merchant_test',
      amount: 10000,
      currency: 'usdc',
      chain: 'base',
      status: 'created',
      node_operator: '0xNodeitWalletAddress',
      payer_address: null,
      tx_hash: null,
      fee_amount: 5,
      metadata: {},
      created_at: 1700000000,
      expires_at: 1700001800,
      settled_at: null,
    }
    mockFetch.mockResolvedValueOnce(mockResponse(mockIntent))

    const retrieved = await relay.paymentIntents.retrieve('pi_testnet_002')

    expect(retrieved.id).toBe('pi_testnet_002')
    expect(retrieved.status).toBe('created')
    expect(retrieved.node_operator).toBe('0xNodeitWalletAddress')
  })

  it('recibe y parsea un webhook event de payment_intent.settled', () => {
    const eventPayload = JSON.stringify({
      id: 'evt_settled_001',
      type: 'payment_intent.settled',
      created: 1700001500,
      data: {
        id: 'pi_testnet_001',
        status: 'settled',
        tx_hash: '0xabc123settled',
        settled_at: 1700001500,
      },
    })

    const timestamp = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${timestamp}.${eventPayload}`)
      .digest('hex')
    const signature = `t=${timestamp},v1=${sig}`

    const event = relay.webhooks.verify(eventPayload, signature, WEBHOOK_SECRET)

    expect(event.type).toBe('payment_intent.settled')
    expect(event.id).toBe('evt_settled_001')
    expect((event.data as { tx_hash: string }).tx_hash).toBe('0xabc123settled')
  })

  it('el flujo completo: create → retrieve → settle webhook', async () => {
    const createdAt = Math.floor(Date.now() / 1000)
    const piId = 'pi_e2e_complete'

    // 1. Create
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        id: piId,
        amount: 1000,
        currency: 'usdc',
        chain: 'base',
        status: 'created',
        fee_amount: 1,
        created_at: createdAt,
        expires_at: createdAt + 1800,
        settled_at: null,
      }),
    )
    const created = await relay.paymentIntents.create({
      amount: 1000,
      currency: 'usdc',
      chain: 'base',
    })
    expect(created.status).toBe('created')

    // 2. Retrieve (intent created, awaiting authorization)
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        id: piId,
        amount: 1000,
        currency: 'usdc',
        chain: 'base',
        status: 'created',
        node_operator: '0xNodeit123',
        fee_amount: 1,
        created_at: createdAt,
        expires_at: createdAt + 1800,
        settled_at: null,
      }),
    )
    const retrievedIntent = await relay.paymentIntents.retrieve(piId)
    expect(retrievedIntent.status).toBe('created')
    expect(retrievedIntent.node_operator).toBe('0xNodeit123')

    // 3. Webhook settlement
    const settlePayload = JSON.stringify({
      id: 'evt_settle_e2e',
      type: 'payment_intent.settled',
      created: createdAt + 100,
      data: { id: piId, status: 'settled', tx_hash: '0xdeadbeef', settled_at: createdAt + 100 },
    })
    const ts = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${settlePayload}`).digest('hex')
    const event = relay.webhooks.verify(settlePayload, `t=${ts},v1=${sig}`, WEBHOOK_SECRET)

    expect(event.type).toBe('payment_intent.settled')
    expect((event.data as { id: string }).id).toBe(piId)
  })
})
