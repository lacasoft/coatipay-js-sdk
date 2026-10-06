import type { WebhookEventType } from '@lacasoft/coatipay-protocol'
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
      'payment_intent.expired',
      'payment_intent.cancelled',
    ] as const satisfies readonly WebhookEventType[]

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
      'payment_intent.cancelled',
    ])

    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.test.coatipay.com/v1/webhooks')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.url).toBe('https://example.com/hook')
    expect(body.events).toEqual(['payment_intent.settled', 'payment_intent.cancelled'])
    expect(result.id).toBe('we_new1')
    expect(result.secret).toBe('whsec_newsecret123')
  })
})

describe('Webhooks.rotateSecret', () => {
  const rotado = {
    id: 'we_1',
    url: 'https://example.com/hook',
    events: ['payment_intent.settled'],
    secret: 'whsec_nuevo',
    previous_secret_expires_at: 1_790_086_400,
  }

  it('pide POST /webhooks/:id/rotate_secret, sin cuerpo: el plazo lo pone la API (24 h)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(rotado) })
    const r = await client.webhooks.rotateSecret('we_1')

    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.test.coatipay.com/v1/webhooks/we_1/rotate_secret')
    expect(opts.method).toBe('POST')
    expect(opts.body).toBeUndefined()
    // Sin cuerpo no se declara JSON: la API rechazaría un cuerpo vacío.
    expect(opts.headers['Content-Type']).toBeUndefined()
    expect(r).toEqual(rotado)
  })

  it('con keepPreviousFor manda keep_previous_for, también cuando es 0', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...rotado, previous_secret_expires_at: null }),
    })
    const r = await client.webhooks.rotateSecret('we_1', { keepPreviousFor: 0 })
    await client.webhooks.rotateSecret('we_1', { keepPreviousFor: 3600 })

    const cuerpos = mockFetch.mock.calls.map(([, opts]) => JSON.parse(opts.body))
    expect(cuerpos).toEqual([{ keep_previous_for: 0 }, { keep_previous_for: 3600 }])
    expect(mockFetch.mock.calls[0]![1].headers['Content-Type']).toBe('application/json')
    expect(r.previous_secret_expires_at).toBeNull()
  })

  it('el id va escapado en la ruta', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(rotado) })
    await client.webhooks.rotateSecret('we_1/../otra')
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://api.test.coatipay.com/v1/webhooks/we_1%2F..%2Fotra/rotate_secret',
    )
  })

  it('durante la ventana, verify acepta la entrega con el secreto nuevo y con el anterior', () => {
    const payload = JSON.stringify({ id: 'evt_r', type: 'payment_intent.settled', data: {} })
    const t = Math.floor(Date.now() / 1000)
    const firma = (secreto: string) =>
      createHmac('sha256', secreto).update(`${t}.${payload}`).digest('hex')
    // Como la manda la API tras rotar: primero la del nuevo, después la del anterior.
    const cabecera = `t=${t},v1=${firma('whsec_nuevo')},v1=${firma('whsec_anterior')}`

    expect(client.webhooks.verify(payload, cabecera, 'whsec_nuevo').id).toBe('evt_r')
    expect(client.webhooks.verify(payload, cabecera, 'whsec_anterior').id).toBe('evt_r')
    expect(() => client.webhooks.verify(payload, cabecera, 'whsec_otro')).toThrow(
      expect.objectContaining({ reason: 'no_matching_signature' }),
    )
  })
})

describe('Webhooks — DLQ', () => {
  const entrega = {
    id: 'dlq_1',
    endpoint_id: 'we_1',
    endpoint_url: 'https://example.com/hook',
    event_id: 'evt_1',
    event_type: 'payment_intent.settled',
    delivery_id: 'whd_1',
    attempts: 6,
    last_error: 'HTTP 500',
    last_attempted_at: 1_790_000_000,
    created_at: 1_790_000_000,
    replayed_at: null,
    payload: { id: 'evt_1' },
  }

  it('listDeadLetters pide GET /webhooks/dead_letters, con el límite si se da', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [entrega], has_more: false }),
    })
    const r = await client.webhooks.listDeadLetters({ limit: 5 })
    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.test.coatipay.com/v1/webhooks/dead_letters?limit=5')
    expect(opts.method).toBe('GET')
    expect(r.data[0]?.delivery_id).toBe('whd_1')
  })

  it('replayDeadLetter pide POST /webhooks/dead_letters/:id/replay', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ ...entrega, replayed_at: 1_790_000_100 }),
    })
    const r = await client.webhooks.replayDeadLetter('dlq_1')
    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.test.coatipay.com/v1/webhooks/dead_letters/dlq_1/replay')
    expect(opts.method).toBe('POST')
    expect(r.replayed_at).toBe(1_790_000_100)
  })
})
