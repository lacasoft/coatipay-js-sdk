import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { CoatiPay } from '../index.js'

const TEST_SECRET = 'whsec_testsecretkey1234567890abcdef'

function buildSignature(payload: string, secret: string, timestamp: number): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  return `t=${timestamp},v1=${sig}`
}

let client: CoatiPay

beforeEach(() => {
  vi.clearAllMocks()
  client = new CoatiPay({
    apiKey: 'sk_live_webhooktest123456',
    baseUrl: 'https://api.test.coatipay.com',
  })
})

describe('Webhooks.verify', () => {
  it('should verify a valid webhook signature and return the parsed event', () => {
    const payload = JSON.stringify({
      id: 'evt_test1',
      type: 'payment_intent.settled',
      created: 1700000000,
      data: { id: 'pi_test1', status: 'settled' },
    })

    const timestamp = Math.floor(Date.now() / 1000)
    const signature = buildSignature(payload, TEST_SECRET, timestamp)

    const event = client.webhooks.verify(payload, signature, TEST_SECRET)

    expect(event.id).toBe('evt_test1')
    expect(event.type).toBe('payment_intent.settled')
    expect(event.created).toBe(1700000000)
    expect(event.data).toEqual({ id: 'pi_test1', status: 'settled' })
  })

  it('should throw when signature format is invalid (missing t=)', () => {
    const payload = '{"id":"evt_bad"}'
    const signature = 'v1=abc123'

    expect(() => client.webhooks.verify(payload, signature, TEST_SECRET)).toThrow(
      'Invalid signature format',
    )
  })

  it('should throw when signature format is invalid (missing v1=)', () => {
    const payload = '{"id":"evt_bad"}'
    const signature = 't=1700000000'

    expect(() => client.webhooks.verify(payload, signature, TEST_SECRET)).toThrow(
      'Invalid signature format',
    )
  })

  it('should throw when HMAC does not match (wrong secret)', () => {
    const payload = JSON.stringify({
      id: 'evt_wrong',
      type: 'payment_intent.created',
      created: 1700000000,
      data: {},
    })

    const timestamp = Math.floor(Date.now() / 1000)
    const signature = buildSignature(payload, 'wrong_secret_key_here', timestamp)

    expect(() => client.webhooks.verify(payload, signature, TEST_SECRET)).toThrow(
      'Signature verification failed',
    )
  })

  it('should throw when payload has been tampered with', () => {
    const originalPayload = JSON.stringify({
      id: 'evt_tamper',
      type: 'payment_intent.settled',
      created: 1700000000,
      data: { amount: 1000 },
    })

    const timestamp = Math.floor(Date.now() / 1000)
    const signature = buildSignature(originalPayload, TEST_SECRET, timestamp)

    const tamperedPayload = JSON.stringify({
      id: 'evt_tamper',
      type: 'payment_intent.settled',
      created: 1700000000,
      data: { amount: 9999999 },
    })

    expect(() => client.webhooks.verify(tamperedPayload, signature, TEST_SECRET)).toThrow(
      'Signature verification failed',
    )
  })

  it('should throw when timestamp has been modified', () => {
    const payload = JSON.stringify({
      id: 'evt_ts',
      type: 'payment_intent.settled',
      created: 1700000000,
      data: {},
    })

    const realTimestamp = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', TEST_SECRET)
      .update(`${realTimestamp}.${payload}`)
      .digest('hex')

    // Modify the timestamp in the signature header
    const fakeTimestamp = realTimestamp + 100
    const signature = `t=${fakeTimestamp},v1=${sig}`

    expect(() => client.webhooks.verify(payload, signature, TEST_SECRET)).toThrow(
      'Signature verification failed',
    )
  })

  it('should verify correctly with different event types', () => {
    const eventTypes = [
      'payment_intent.created',
      'payment_intent.settled',
      'payment_intent.failed',
      'payment_intent.cancelled',
      'dispute.opened',
    ] as const

    for (const type of eventTypes) {
      const payload = JSON.stringify({
        id: `evt_${type}`,
        type,
        created: 1700000000,
        data: {},
      })

      const timestamp = Math.floor(Date.now() / 1000)
      const signature = buildSignature(payload, TEST_SECRET, timestamp)

      const event = client.webhooks.verify(payload, signature, TEST_SECRET)
      expect(event.type).toBe(type)
    }
  })

  it('should handle empty string signature', () => {
    const payload = '{"id":"evt_empty"}'

    expect(() => client.webhooks.verify(payload, '', TEST_SECRET)).toThrow(
      'Invalid signature format',
    )
  })
})

describe('webhook signature construction', () => {
  it('should use HMAC-SHA256 with format: timestamp.payload', () => {
    const payload = '{"test":"data"}'
    // Use a fresh timestamp because verify() now enforces tolerance window.
    const timestamp = Math.floor(Date.now() / 1000)
    const secret = 'test_signing_secret'

    const expectedSig = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')

    const signature = `t=${timestamp},v1=${expectedSig}`
    const event = client.webhooks.verify(payload, signature, secret)

    expect(event).toEqual({ test: 'data' })
  })

  it('should produce a 64-character hex HMAC signature', () => {
    const payload = '{"id":"evt_hex"}'
    const timestamp = 1700000000

    const sig = createHmac('sha256', TEST_SECRET).update(`${timestamp}.${payload}`).digest('hex')

    expect(sig).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('Webhooks.register', () => {
  it('should send POST to /v1/webhooks with url and events', async () => {
    const mockResponse = {
      id: 'we_new1',
      url: 'https://example.com/hook',
      secret: 'whsec_newsecret123',
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(mockResponse),
    })

    const result = await client.webhooks.register('https://example.com/hook', [
      'payment_intent.settled',
      'payment_intent.failed',
    ])

    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.test.coatipay.com/v1/webhooks')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.url).toBe('https://example.com/hook')
    expect(body.events).toEqual(['payment_intent.settled', 'payment_intent.failed'])
    expect(result.id).toBe('we_new1')
    expect(result.secret).toBe('whsec_newsecret123')
  })
})
