/**
 * Criterio 6: Logs estructurados de cada llamada al SDK con
 * request_id, latencia y ruta seleccionada por CoatiPay.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import type { LogEntry } from '../../index.js'
import { CoatiPay } from '../../index.js'

function mockOk(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) }
}

function mockCreated(data: unknown) {
  return { ok: true, status: 201, json: () => Promise.resolve(data) }
}

function mockErr(code: string, status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: { code, message: 'err', param: null, doc_url: '' } }),
  }
}

describe('Criterio 6 — Logging estructurado', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('invoca el logger con los campos requeridos tras una petición exitosa', async () => {
    const logs: LogEntry[] = []
    const relay = new CoatiPay({
      apiKey: 'sk_test_log',
      baseUrl: 'https://testnet.coatipay.com',
      logger: (e) => logs.push(e),
    })

    const intentData = {
      id: 'pi_log_001',
      amount: 1000,
      currency: 'usdc',
      chain: 'base',
      status: 'created',
      node_operator: null,
      fee_amount: 1,
      created_at: 1700000000,
      expires_at: 1700001800,
      settled_at: null,
    }
    mockFetch.mockResolvedValueOnce(mockCreated(intentData))

    await relay.paymentIntents.create({ amount: 1000, currency: 'usdc', chain: 'base' })

    expect(logs).toHaveLength(1)
    const entry = logs[0]!
    expect(entry.request_id).toMatch(/^[0-9a-f-]{36}$/) // UUID v4
    expect(entry.method).toBe('POST')
    expect(entry.path).toBe('/payment_intents')
    expect(entry.status).toBe(201)
    expect(entry.latency_ms).toBeGreaterThanOrEqual(0)
    expect(entry.node_route).toBeNull()
  })

  it('captura node_route cuando la API devuelve node_operator', async () => {
    const logs: LogEntry[] = []
    const relay = new CoatiPay({
      apiKey: 'sk_test_log_route',
      baseUrl: 'https://testnet.coatipay.com',
      logger: (e) => logs.push(e),
    })

    mockFetch.mockResolvedValueOnce(
      mockOk({
        id: 'pi_routed',
        amount: 5000,
        status: 'created',
        node_operator: '0xNodeitWallet42',
      }),
    )

    await relay.paymentIntents.retrieve('pi_routed')

    expect(logs[0]!.node_route).toBe('0xNodeitWallet42')
  })

  it('loguea cada petición con request_id único', async () => {
    const logs: LogEntry[] = []
    const relay = new CoatiPay({
      apiKey: 'sk_test_log_unique',
      baseUrl: 'https://testnet.coatipay.com',
      logger: (e) => logs.push(e),
    })

    mockFetch.mockResolvedValue(mockOk({ id: 'pi_x', amount: 100 }))

    await relay.paymentIntents.retrieve('pi_a')
    await relay.paymentIntents.retrieve('pi_b')

    expect(logs).toHaveLength(2)
    expect(logs[0]!.request_id).not.toBe(logs[1]!.request_id)
  })

  it('loguea también peticiones con error de API (status no-ok)', async () => {
    const logs: LogEntry[] = []
    const relay = new CoatiPay({
      apiKey: 'sk_test_log_err',
      baseUrl: 'https://testnet.coatipay.com',
      logger: (e) => logs.push(e),
    })

    mockFetch.mockResolvedValueOnce(mockErr('invalid_api_key', 401))

    try {
      await relay.paymentIntents.retrieve('pi_err')
    } catch {
      // esperado
    }

    expect(logs).toHaveLength(1)
    expect(logs[0]!.status).toBe(401)
    expect(logs[0]!.path).toBe('/payment_intents/pi_err')
  })

  it('no invoca logger en errores de red (NetworkError — fetch falla antes)', async () => {
    const logs: LogEntry[] = []
    const relay = new CoatiPay({
      apiKey: 'sk_test_log_net',
      baseUrl: 'https://testnet.coatipay.com',
      logger: (e) => logs.push(e),
    })

    mockFetch.mockRejectedValueOnce(new TypeError('ECONNREFUSED'))

    try {
      await relay.paymentIntents.retrieve('pi_net')
    } catch {
      // esperado NetworkError
    }

    // El logger no se llama porque fetch lanzó antes de que hubiera respuesta
    expect(logs).toHaveLength(0)
  })

  it('no requiere logger — funciona sin configurarlo', async () => {
    const relay = new CoatiPay({
      apiKey: 'sk_test_nolog',
      baseUrl: 'https://testnet.coatipay.com',
    })

    mockFetch.mockResolvedValueOnce(mockOk({ data: [], has_more: false }))

    // No debe lanzar aunque no haya logger configurado
    await expect(relay.paymentIntents.list()).resolves.toBeDefined()
  })

  it('el X-Request-Id enviado al servidor coincide con el request_id logueado', async () => {
    const logs: LogEntry[] = []
    const relay = new CoatiPay({
      apiKey: 'sk_test_reqid',
      baseUrl: 'https://testnet.coatipay.com',
      logger: (e) => logs.push(e),
    })

    mockFetch.mockResolvedValueOnce(mockOk({ id: 'pi_rid', amount: 100 }))

    await relay.paymentIntents.retrieve('pi_rid')

    const sentHeaders = mockFetch.mock.calls[0]![1].headers
    expect(sentHeaders['X-Request-Id']).toBe(logs[0]!.request_id)
  })
})
