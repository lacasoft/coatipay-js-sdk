import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { USDC_BASE_ADDRESS } from '@lacasoft/coatipay-protocol'
import { CoatiPay } from '../../index.js'

function mockFetchResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  }
}

let client: CoatiPay

beforeEach(() => {
  vi.clearAllMocks()
  client = new CoatiPay({
    apiKey: 'sk_live_x402test123456',
    baseUrl: 'https://api.test.coatipay.com',
    merchantWallet: '0xMerchantWallet123',
  })
})

// x402.middleware() se prueba dentro de un Fastify de verdad: fastify.test.ts.

describe('X402 handler', () => {
  it('should return a function', () => {
    const handler = client.x402.handler({
      price: 1000,
      currency: 'usdc',
      chain: 'base',
      handler: async () => Response.json({ data: 'protected' }),
    })

    expect(handler).toBeTypeOf('function')
  })

  it('should return 402 when no payment header', async () => {
    const handler = client.x402.handler({
      price: 2000,
      currency: 'usdc',
      chain: 'base',
      description: 'Data endpoint',
      handler: async () => Response.json({ data: 'secret' }),
    })

    const req = new Request('https://api.example.com/data', { method: 'GET' })
    const result = await handler(req)

    expect(result.status).toBe(402)
    const body = (await result.json()) as any
    expect(body.x402Version).toBe(1)
    expect(body.accepts[0].maxAmountRequired).toBe('2000')
    expect(body.accepts[0].description).toBe('Data endpoint')
  })

  it('should call inner handler when payment is verified (Fastify-style request)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchResponse({
        verified: true,
        tx_hash: '0xValidTx',
      }),
    )

    const innerHandler = vi.fn(async () => Response.json({ data: 'secret_data' }))

    const handler = client.x402.handler({
      price: 1000,
      currency: 'usdc',
      chain: 'base',
      handler: innerHandler,
    })

    // Use Fastify-style request where headers is a plain object
    const req = {
      url: 'https://api.example.com/data',
      headers: { 'x-payment': 'validpayment123' },
    } as unknown as Request

    const result = await handler(req)

    expect(innerHandler).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(200)
    const body = (await result.json()) as any
    expect(body.data).toBe('secret_data')
  })

  it('should return 402 when payment verification fails in handler (Fastify-style request)', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse({ error: 'bad' }, 402))

    const innerHandler = vi.fn(async () => Response.json({ data: 'nope' }))

    const handler = client.x402.handler({
      price: 1000,
      currency: 'usdc',
      chain: 'base',
      handler: innerHandler,
    })

    const req = {
      url: 'https://api.example.com/data',
      headers: { 'x-payment': 'badpayment' },
    } as unknown as Request

    const result = await handler(req)

    expect(innerHandler).not.toHaveBeenCalled()
    expect(result.status).toBe(402)
  })

  it('should include resource URL in payment requirements', async () => {
    const handler = client.x402.handler({
      price: 500,
      currency: 'usdc',
      chain: 'base',
      handler: async () => Response.json({}),
    })

    const req = new Request('https://api.example.com/v1/resource/123', { method: 'GET' })
    const result = await handler(req)

    const body = (await result.json()) as any
    expect(body.accepts[0].resource).toBe('https://api.example.com/v1/resource/123')
  })

  it('should set payTo to empty string when merchantWallet is not configured', async () => {
    const noWalletClient = new CoatiPay({
      apiKey: 'sk_live_nowallet123',
      baseUrl: 'https://api.test.coatipay.com',
    })

    const handler = noWalletClient.x402.handler({
      price: 1000,
      currency: 'usdc',
      chain: 'base',
      handler: async () => Response.json({}),
    })

    const req = new Request('https://api.example.com/resource', { method: 'GET' })
    const result = await handler(req)
    const body = (await result.json()) as any

    expect(body.accepts[0].payTo).toBe('')
  })
})
