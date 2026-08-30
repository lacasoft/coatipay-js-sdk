import { MAX_BATCH_SIZE } from '@lacasoft/coatipay-protocol'
import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoatiPay, type SignedAuthorization } from '../index.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockOk(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) }
}

function makeAuth(overrides?: Partial<SignedAuthorization>): SignedAuthorization {
  return {
    payer: '0x2222222222222222222222222222222222222222',
    validAfter: 0n,
    validBefore: 9_999_999_999n,
    nonce: '0xabcd000000000000000000000000000000000000000000000000000000000000' as Hex,
    signature: `0x${'ab'.repeat(65)}` as Hex, // 65-byte EOA blob
    ...overrides,
  }
}

let client: CoatiPay

beforeEach(() => {
  vi.clearAllMocks()
  client = new CoatiPay({ apiKey: 'sk_live_testkey1234567890', baseUrl: 'https://api.test.dev' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('paymentIntents.submitAuthorization', () => {
  it('POSTs the serialized authorization to the correct path', async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({ intent_id: 'pi_test', estimated_settlement_at: null, status: 'queued' }),
    )

    await client.paymentIntents.submitAuthorization('pi_test', makeAuth())

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test.dev/v1/payment_intents/pi_test/authorize')
    expect(opts.method).toBe('POST')

    const body = JSON.parse(opts.body as string)
    // bigints serialize as strings (JSON-safe)
    expect(body.payer).toBe('0x2222222222222222222222222222222222222222')
    expect(body.valid_after).toBe('0')
    expect(body.valid_before).toBe('9999999999')
    expect(body.nonce).toMatch(/^0xabcd/)
    expect(body.signature).toBe(`0x${'ab'.repeat(65)}`)
  })

  it('returns the queued response', async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        intent_id: 'pi_x',
        estimated_settlement_at: '2026-05-14T17:30:00Z',
        status: 'queued',
      }),
    )
    const res = await client.paymentIntents.submitAuthorization('pi_x', makeAuth())
    expect(res.intent_id).toBe('pi_x')
    expect(res.status).toBe('queued')
    expect(res.estimated_settlement_at).toBe('2026-05-14T17:30:00Z')
  })
})

describe('paymentIntents.submitAuthorizationBatch', () => {
  it('returns empty result for empty input without hitting the API', async () => {
    const res = await client.paymentIntents.submitAuthorizationBatch([])
    expect(res.queued).toBe(0)
    expect(res.rejected).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws when batch exceeds MAX_BATCH_SIZE', async () => {
    const items = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
      intent_id: `pi_${i}`,
      authorization: makeAuth(),
    }))
    await expect(client.paymentIntents.submitAuthorizationBatch(items)).rejects.toThrow(
      new RegExp(`Batch too large.*${MAX_BATCH_SIZE + 1}.*max ${MAX_BATCH_SIZE}`),
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('POSTs serialized items array to the batch endpoint', async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        results: [
          { intent_id: 'pi_a', status: 'queued' },
          { intent_id: 'pi_b', status: 'queued' },
        ],
        queued: 2,
        rejected: 0,
      }),
    )

    await client.paymentIntents.submitAuthorizationBatch([
      { intent_id: 'pi_a', authorization: makeAuth() },
      { intent_id: 'pi_b', authorization: makeAuth() },
    ])

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test.dev/v1/payment_intents/batch/authorize')
    const body = JSON.parse(opts.body as string)
    expect(body.items).toHaveLength(2)
    expect(body.items[0].intent_id).toBe('pi_a')
    expect(body.items[0].authorization.payer).toBe('0x2222222222222222222222222222222222222222')
  })

  it('accepts a batch of exactly MAX_BATCH_SIZE (boundary)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        results: Array.from({ length: MAX_BATCH_SIZE }, (_, i) => ({
          intent_id: `pi_${i}`,
          status: 'queued',
        })),
        queued: MAX_BATCH_SIZE,
        rejected: 0,
      }),
    )

    const items = Array.from({ length: MAX_BATCH_SIZE }, (_, i) => ({
      intent_id: `pi_${i}`,
      authorization: makeAuth(),
    }))
    const res = await client.paymentIntents.submitAuthorizationBatch(items)
    expect(res.queued).toBe(MAX_BATCH_SIZE)
  })
})

describe('paymentIntents.signAuthorization (server-side convenience)', () => {
  it('produces a SignedAuthorization that submitAuthorization can consume directly', async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({ intent_id: 'pi_e2e', estimated_settlement_at: null, status: 'queued' }),
    )

    const PRIVKEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
    const auth = await client.paymentIntents.signAuthorization(
      {
        payer: '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23',
        amount: 1_000_000n,
        settlementHub: '0x1111111111111111111111111111111111111111',
        chain: 'base-sepolia',
        intentId: '0xbeef000000000000000000000000000000000000000000000000000000000000' as Hex,
      },
      PRIVKEY,
    )

    await client.paymentIntents.submitAuthorization('pi_e2e', auth)

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    expect(body.payer).toBe('0x2c7536e3605d9c16a7a3d7b1898e529396a65c23')
    // raw 65-byte EOA signature (0x + 130 hex)
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/)
  })
})
