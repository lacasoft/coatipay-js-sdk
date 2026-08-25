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

describe('X402 middleware', () => {
  it('should return a function (middleware)', () => {
    const mw = client.x402.middleware({
      price: 1000,
      currency: 'usdc',
      chain: 'base',
    })

    expect(mw).toBeTypeOf('function')
  })

  it('should return 402 with payment requirements when no X-PAYMENT header', async () => {
    const mw = client.x402.middleware({
      price: 5000,
      currency: 'usdc',
      chain: 'base',
      description: 'Premium API access',
    })

    const mockReq = new Request('https://api.example.com/protected', {
      method: 'GET',
    })

    const result = await mw(mockReq, undefined as any)

    expect(result).toBeInstanceOf(Response)
    expect(result?.status).toBe(402)

    const body = (await result?.json()) as any
    expect(body.x402Version).toBe(1)
    expect(body.accepts).toHaveLength(1)
    expect(body.accepts[0].scheme).toBe('exact')
    expect(body.accepts[0].network).toBe('base')
    expect(body.accepts[0].maxAmountRequired).toBe('5000')
    expect(body.accepts[0].description).toBe('Premium API access')
    expect(body.accepts[0].payTo).toBe('0xMerchantWallet123')
    expect(body.accepts[0].asset).toBe(USDC_BASE_ADDRESS)
    expect(body.accepts[0].maxTimeoutSeconds).toBe(300)
    expect(body.accepts[0].mimeType).toBe('application/json')
  })

  it('should use default description when not provided', async () => {
    const mw = client.x402.middleware({
      price: 1000,
      currency: 'usdc',
      chain: 'base',
    })

    const mockReq = new Request('https://api.example.com/resource', {
      method: 'GET',
    })

    const result = await mw(mockReq, undefined as any)
    const body = (await result?.json()) as any

    expect(body.accepts[0].description).toBe('API access')
  })

  it('derives the USDC asset + EIP-712 domain name from the chain', async () => {
    const mw = client.x402.middleware({ price: 1000, currency: 'usdc', chain: 'base' })
    const result = await mw(new Request('https://api.example.com/x'), undefined as any)
    const body = (await result?.json()) as any

    // Base mainnet: asset = mainnet USDC, domain name = "USD Coin" (NOT "USDC")
    expect(body.accepts[0].asset).toBe(USDC_BASE_ADDRESS)
    expect(body.accepts[0].extra).toEqual({ name: 'USD Coin', version: '2' })
  })

  // NOTE: The source code accesses headers via (req.headers as Record<string, string>)['x-payment']
  // but Web API Request.headers is a Headers object, not a plain record. Bracket access returns
  // undefined. This means the middleware always takes the "no payment" path with standard Request
  // objects. The tests below document the actual behavior with a Fastify-style request object
  // where headers IS a plain record (as the middleware was designed for).

  it('should verify payment when X-PAYMENT header is present and valid (Fastify-style request)', async () => {
    const mw = client.x402.middleware({
      price: 1000,
      currency: 'usdc',
      chain: 'base',
    })

    // Mock the verification API call
    mockFetch.mockResolvedValueOnce(
      mockFetchResponse({
        verified: true,
        tx_hash: '0xValidTx',
        amount_received: 1000,
      }),
    )

    // Simulate a Fastify-style request where headers is a plain object
    const mockReq = {
      url: 'https://api.example.com/protected',
      headers: { 'x-payment': 'base64encodedpaymentdata' },
    } as unknown as Request

    const result = await mw(mockReq, undefined as any)

    // When payment is valid, middleware should return undefined (pass through)
    expect(result).toBeUndefined()

    // Verify it called the API to verify the payment
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.test.coatipay.com/v1/x402/verify')
    expect(opts.method).toBe('POST')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody.payment).toBe('base64encodedpaymentdata')
    expect(sentBody.amount).toBe(1000)
    expect(sentBody.chain).toBe('base')
  })

  it('should return 402 when payment verification fails (Fastify-style request)', async () => {
    const mw = client.x402.middleware({
      price: 1000,
      currency: 'usdc',
      chain: 'base',
    })

    // Mock the verification API call to fail
    mockFetch.mockResolvedValueOnce(
      mockFetchResponse(
        { error: { code: 'insufficient_payment', message: 'Insufficient payment' } },
        402,
      ),
    )

    // Simulate a Fastify-style request where headers is a plain object
    const mockReq = {
      url: 'https://api.example.com/protected',
      headers: { 'x-payment': 'invalidpayment' },
    } as unknown as Request

    const result = await mw(mockReq, undefined as any)

    expect(result).toBeInstanceOf(Response)
    expect(result?.status).toBe(402)
    const body = (await result?.json()) as any
    expect(body.error).toBe('Payment verification failed')
  })

  it('should return 402 when API call throws an error (Fastify-style request)', async () => {
    const mw = client.x402.middleware({
      price: 1000,
      currency: 'usdc',
      chain: 'base',
    })

    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const mockReq = {
      url: 'https://api.example.com/protected',
      headers: { 'x-payment': 'somepayment' },
    } as unknown as Request

    const result = await mw(mockReq, undefined as any)

    expect(result).toBeInstanceOf(Response)
    expect(result?.status).toBe(402)
  })

  it('should detect x-payment header from standard Web Request via Headers.get()', async () => {
    // Regression test: the middleware now correctly handles Web API Request objects
    // by calling headers.get() when headers is a Headers instance.
    const mw = client.x402.middleware({
      price: 1000,
      currency: 'usdc',
      chain: 'base',
    })

    mockFetch.mockResolvedValueOnce(mockFetchResponse({ verified: true, tx_hash: '0xAbc' }))

    const webReq = new Request('https://api.example.com/protected', {
      method: 'GET',
      headers: { 'x-payment': 'validpayment' },
    })

    const result = await mw(webReq, undefined as any)

    // Header detected → verify was called → pass-through (undefined)
    expect(result).toBeUndefined()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

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
