/**
 * Criterio 4: Idempotencia — mismo idempotency_key no genera doble cobro.
 * El SDK debe enviar Idempotency-Key como header HTTP.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { CoatiPay } from '../../index.js'

function mockOkIntent(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 201,
    json: () =>
      Promise.resolve({
        id: 'pi_idem_001',
        amount: 5000,
        currency: 'usdc',
        chain: 'base',
        status: 'created',
        fee_amount: 3,
        node_operator: null,
        created_at: 1700000000,
        expires_at: 1700001800,
        settled_at: null,
        ...overrides,
      }),
  }
}

let relay: CoatiPay

beforeEach(() => {
  vi.clearAllMocks()
  relay = new CoatiPay({ apiKey: 'sk_test_idem', baseUrl: 'https://testnet.coatipay.com' })
})

describe('Criterio 4 — Idempotencia', () => {
  it('envía Idempotency-Key header cuando se pasa idempotency_key', async () => {
    mockFetch.mockResolvedValueOnce(mockOkIntent())

    await relay.paymentIntents.create({
      amount: 5000,
      currency: 'usdc',
      chain: 'base',
      idempotency_key: 'order-xyz-001',
    })

    const [, opts] = mockFetch.mock.calls[0]!
    expect(opts.headers['Idempotency-Key']).toBe('order-xyz-001')
  })

  it('no envía Idempotency-Key cuando no se especifica idempotency_key', async () => {
    mockFetch.mockResolvedValueOnce(mockOkIntent())

    await relay.paymentIntents.create({ amount: 5000, currency: 'usdc', chain: 'base' })

    const [, opts] = mockFetch.mock.calls[0]!
    expect(opts.headers['Idempotency-Key']).toBeUndefined()
  })

  it('no incluye idempotency_key en el body de la petición', async () => {
    mockFetch.mockResolvedValueOnce(mockOkIntent())

    await relay.paymentIntents.create({
      amount: 5000,
      currency: 'usdc',
      chain: 'base',
      idempotency_key: 'order-no-body',
    })

    const [, opts] = mockFetch.mock.calls[0]!
    const body = JSON.parse(opts.body)
    expect(body.idempotency_key).toBeUndefined()
    expect(body.amount).toBe(5000)
  })

  it('segunda llamada con mismo idempotency_key retorna el mismo intent (sin doble cobro)', async () => {
    const intentData = mockOkIntent()

    // El servidor devuelve el mismo intent en ambas llamadas (comportamiento testnet)
    mockFetch.mockResolvedValueOnce(intentData)
    mockFetch.mockResolvedValueOnce(intentData)

    const result1 = await relay.paymentIntents.create({
      amount: 5000,
      currency: 'usdc',
      chain: 'base',
      idempotency_key: 'same-key-no-double-charge',
    })

    const result2 = await relay.paymentIntents.create({
      amount: 5000,
      currency: 'usdc',
      chain: 'base',
      idempotency_key: 'same-key-no-double-charge',
    })

    // Ambas llamadas envían el mismo header de idempotencia
    const key1 = mockFetch.mock.calls[0]![1].headers['Idempotency-Key']
    const key2 = mockFetch.mock.calls[1]![1].headers['Idempotency-Key']
    expect(key1).toBe('same-key-no-double-charge')
    expect(key2).toBe('same-key-no-double-charge')

    // El servidor retorna el mismo ID (idempotencia real la garantiza el backend)
    expect(result1.id).toBe(result2.id)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('claves distintas producen requests independientes', async () => {
    mockFetch.mockResolvedValueOnce({
      ...mockOkIntent(),
      json: () => Promise.resolve({ ...mockOkIntent().json(), id: 'pi_a' }),
    })
    mockFetch.mockResolvedValueOnce({
      ...mockOkIntent(),
      json: () => Promise.resolve({ ...mockOkIntent().json(), id: 'pi_b' }),
    })

    await relay.paymentIntents.create({
      amount: 5000,
      currency: 'usdc',
      chain: 'base',
      idempotency_key: 'key-a',
    })
    await relay.paymentIntents.create({
      amount: 5000,
      currency: 'usdc',
      chain: 'base',
      idempotency_key: 'key-b',
    })

    expect(mockFetch.mock.calls[0]![1].headers['Idempotency-Key']).toBe('key-a')
    expect(mockFetch.mock.calls[1]![1].headers['Idempotency-Key']).toBe('key-b')
  })
})
