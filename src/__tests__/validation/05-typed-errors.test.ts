/**
 * Criterio 5: Manejo de errores tipados — NetworkError, AuthError,
 * ValidationError, RoutingError y RateLimitError distinguibles en runtime.
 *
 * Con códigos que la API devuelve de verdad (ERROR_CATALOG de
 * @lacasoft/coatipay-protocol). Antes usaba amount_too_small,
 * amount_too_large, chain_not_supported y no_nodes_available: la API nunca los
 * devolvió, así que los tests validaban un caso que no existe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import {
  AuthError,
  CoatiPay,
  CoatiPaySDKError,
  ERROR_CATALOG,
  NetworkError,
  RateLimitError,
  RoutingError,
  ValidationError,
} from '../../index.js'

function apiErrorResponse(code: string, message: string, status = 400) {
  return {
    ok: false,
    status,
    json: () =>
      Promise.resolve({
        error: {
          code,
          message,
          param: null,
          doc_url: `https://coatipay.com/docs/errors/${code}`,
        },
      }),
  }
}

let relay: CoatiPay

beforeEach(() => {
  vi.clearAllMocks()
  relay = new CoatiPay({ apiKey: 'sk_test_errors', baseUrl: 'https://testnet.coatipay.com' })
})

describe('Criterio 5 — Errores tipados', () => {
  describe('AuthError', () => {
    it('lanza AuthError en código invalid_api_key (401)', async () => {
      mockFetch.mockResolvedValueOnce(
        apiErrorResponse('invalid_api_key', 'Invalid or revoked API key.', 401),
      )

      await expect(relay.paymentIntents.list()).rejects.toBeInstanceOf(AuthError)
    })

    it('lanza AuthError en código insufficient_permissions (403)', async () => {
      mockFetch.mockResolvedValueOnce(
        apiErrorResponse('insufficient_permissions', 'Insufficient permissions.', 403),
      )

      await expect(relay.paymentIntents.retrieve('pi_perm')).rejects.toBeInstanceOf(AuthError)
    })

    it('AuthError es instancia de CoatiPaySDKError', async () => {
      mockFetch.mockResolvedValueOnce(apiErrorResponse('invalid_api_key', 'Bad key', 401))

      try {
        await relay.paymentIntents.list()
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError)
        expect(err).toBeInstanceOf(CoatiPaySDKError)
        expect(err).toBeInstanceOf(Error)
        expect((err as AuthError).name).toBe('AuthError')
        expect((err as AuthError).code).toBe('invalid_api_key')
      }
    })
  })

  describe('ValidationError', () => {
    it('lanza ValidationError en código amount_below_minimum', async () => {
      mockFetch.mockResolvedValueOnce(
        apiErrorResponse('amount_below_minimum', 'Amount is below the minimum payable amount.', 400),
      )

      await expect(
        relay.paymentIntents.create({ amount: 1, currency: 'usdc', chain: 'base' }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('lanza ValidationError en código invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        apiErrorResponse('invalid_request', 'Number must be less than or equal to…', 400),
      )

      await expect(
        relay.paymentIntents.create({ amount: 9999999999, currency: 'usdc', chain: 'base' }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('lanza ValidationError en código invalid_signer', async () => {
      mockFetch.mockResolvedValueOnce(
        apiErrorResponse('invalid_signer', 'The signature is not valid for the claimed payer address.', 400),
      )

      await expect(
        relay.paymentIntents.create({ amount: 1000, currency: 'usdc', chain: 'polygon' }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('ValidationError tiene code y param accesibles', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: {
              code: 'amount_below_minimum',
              message: 'Too small.',
              param: 'amount',
              doc_url: '',
            },
          }),
      })

      try {
        await relay.paymentIntents.create({ amount: 1, currency: 'usdc', chain: 'base' })
        expect.fail('Should throw')
      } catch (err) {
        expect((err as ValidationError).code).toBe('amount_below_minimum')
        expect((err as ValidationError).param).toBe('amount')
        expect((err as ValidationError).name).toBe('ValidationError')
      }
    })
  })

  describe('RoutingError', () => {
    it('lanza RoutingError en código node_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        apiErrorResponse('node_unavailable', 'Bootstrap nodeit unreachable.', 502),
      )

      await expect(
        relay.paymentIntents.create({ amount: 10000, currency: 'usdc', chain: 'base' }),
      ).rejects.toBeInstanceOf(RoutingError)
    })

    it('RoutingError es instancia de CoatiPaySDKError', async () => {
      mockFetch.mockResolvedValueOnce(apiErrorResponse('node_unavailable', 'No route.', 502))

      try {
        await relay.paymentIntents.create({ amount: 10000, currency: 'usdc', chain: 'base' })
        expect.fail('Should throw')
      } catch (err) {
        expect(err).toBeInstanceOf(RoutingError)
        expect(err).toBeInstanceOf(CoatiPaySDKError)
        expect((err as RoutingError).name).toBe('RoutingError')
      }
    })
  })

  describe('RateLimitError', () => {
    it('lanza RateLimitError en código rate_limited (429)', async () => {
      mockFetch.mockResolvedValueOnce(apiErrorResponse('rate_limited', 'Rate limit exceeded.', 429))

      try {
        await relay.paymentIntents.retrieve('pi_rl')
        expect.fail('Should throw')
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError)
        expect(err).toBeInstanceOf(CoatiPaySDKError)
        expect((err as RateLimitError).code).toBe('rate_limited')
      }
    })
  })

  describe('ERROR_CATALOG', () => {
    it('el SDK expone el catálogo: cada código con su HTTP', () => {
      expect(ERROR_CATALOG.rate_limited.http).toBe(429)
      expect(ERROR_CATALOG.intent_not_found.http).toBe(404)
      expect(ERROR_CATALOG).not.toHaveProperty('amount_too_small')
    })
  })

  describe('NetworkError', () => {
    it('lanza NetworkError en fallo de red (TypeError fetch)', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await expect(relay.paymentIntents.retrieve('pi_net')).rejects.toBeInstanceOf(NetworkError)
    })

    it('lanza NetworkError en timeout (AbortError)', async () => {
      const abortError = new Error('signal timed out')
      abortError.name = 'AbortError'
      mockFetch.mockRejectedValueOnce(abortError)

      try {
        await relay.paymentIntents.retrieve('pi_timeout')
        expect.fail('Should throw')
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkError)
        expect((err as NetworkError).name).toBe('NetworkError')
        expect((err as NetworkError).message).toContain('timed out')
      }
    })

    it('NetworkError expone cause original', async () => {
      const cause = new TypeError('ECONNREFUSED')
      mockFetch.mockRejectedValueOnce(cause)

      try {
        await relay.paymentIntents.retrieve('pi_refused')
        expect.fail('Should throw')
      } catch (err) {
        expect((err as NetworkError).cause).toBe(cause)
      }
    })
  })

  describe('Discriminación por instanceof en runtime', () => {
    it('switch por instanceof distingue todos los tipos', async () => {
      const cases: Array<[string, string, number, string]> = [
        ['invalid_api_key', 'Bad key', 401, 'auth'],
        ['amount_below_minimum', 'Too small', 400, 'validation'],
        ['node_unavailable', 'No route', 502, 'routing'],
        ['rate_limited', 'Slow down', 429, 'rate_limit'],
      ]

      for (const [code, msg, status, expected] of cases) {
        mockFetch.mockResolvedValueOnce(apiErrorResponse(code, msg, status))

        try {
          await relay.paymentIntents.retrieve('pi_disc')
          expect.fail('Should throw')
        } catch (err) {
          let classified: string
          if (err instanceof NetworkError) classified = 'network'
          else if (err instanceof AuthError) classified = 'auth'
          else if (err instanceof ValidationError) classified = 'validation'
          else if (err instanceof RoutingError) classified = 'routing'
          else if (err instanceof RateLimitError) classified = 'rate_limit'
          else classified = 'unknown'

          expect(classified).toBe(expected)
        }
      }
    })
  })
})
