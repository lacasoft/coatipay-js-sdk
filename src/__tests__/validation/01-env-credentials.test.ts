/**
 * Criterio 1: SDK inicializado con credenciales por entorno (dev/staging/prod).
 * Las credenciales nunca deben estar hardcodeadas; deben venir de process.env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { CoatiPay } from '../../index.js'

function mockOk(data: unknown = {}) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) }
}

describe('Criterio 1 — Credenciales por entorno', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('falla cuando la apiKey está vacía (nunca hardcodear vacío)', () => {
    expect(() => new CoatiPay({ apiKey: '' })).toThrow('apiKey is required')
  })

  it('inicializa desde env COATIPAY_API_KEY (patrón dev)', () => {
    process.env.COATIPAY_API_KEY = 'sk_test_dev_key'
    process.env.COATIPAY_BASE_URL = 'https://testnet.coatipay.com'

    const apiKey = process.env.COATIPAY_API_KEY
    const baseUrl = process.env.COATIPAY_BASE_URL
    expect(apiKey).toBeTruthy()

    const relay = new CoatiPay({ apiKey: apiKey!, baseUrl })
    expect(relay.paymentIntents).toBeDefined()
  })

  it('env dev usa testnet URL', () => {
    process.env.COATIPAY_ENV = 'dev'
    process.env.COATIPAY_API_KEY = 'sk_test_dev_abc'
    process.env.COATIPAY_BASE_URL = 'https://testnet.coatipay.com'

    mockFetch.mockResolvedValueOnce(mockOk({ data: [], has_more: false }))

    const relay = new CoatiPay({
      apiKey: process.env.COATIPAY_API_KEY!,
      baseUrl: process.env.COATIPAY_BASE_URL,
    })

    void relay.paymentIntents.list()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('testnet.coatipay.com'),
      expect.anything(),
    )
  })

  it('env staging usa staging URL', () => {
    process.env.COATIPAY_ENV = 'staging'
    process.env.COATIPAY_API_KEY = 'sk_staging_key_xyz'
    process.env.COATIPAY_BASE_URL = 'https://staging-api.coatipay.com'

    mockFetch.mockResolvedValueOnce(mockOk({ data: [], has_more: false }))

    const relay = new CoatiPay({
      apiKey: process.env.COATIPAY_API_KEY!,
      baseUrl: process.env.COATIPAY_BASE_URL,
    })

    void relay.paymentIntents.list()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('staging-api.coatipay.com'),
      expect.anything(),
    )
  })

  it('env prod usa production URL por defecto', () => {
    process.env.COATIPAY_ENV = 'prod'
    process.env.COATIPAY_API_KEY = 'sk_live_prod_key'

    mockFetch.mockResolvedValueOnce(mockOk({ data: [], has_more: false }))

    // prod no pasa baseUrl → usa el default del SDK
    const relay = new CoatiPay({ apiKey: process.env.COATIPAY_API_KEY! })

    void relay.paymentIntents.list()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api.coatipay.com'),
      expect.anything(),
    )
  })

  it('envía Authorization header con la key del entorno', async () => {
    process.env.COATIPAY_API_KEY = 'sk_test_header_check'

    mockFetch.mockResolvedValueOnce(mockOk({ id: 'pi_1', amount: 1000, status: 'created' }))

    const relay = new CoatiPay({
      apiKey: process.env.COATIPAY_API_KEY!,
      baseUrl: 'https://testnet.coatipay.com',
    })

    await relay.paymentIntents.retrieve('pi_1')

    const [, opts] = mockFetch.mock.calls[0]!
    expect(opts.headers.Authorization).toBe('Bearer sk_test_header_check')
  })
})
