import type { X402MiddlewareOptions, X402PaymentRequired } from '@lacasoft/coatipay-protocol'
import {
  USDC_ADDRESSES,
  USDC_DOMAIN_NAMES,
  USDC_DOMAIN_VERSION,
} from '@lacasoft/coatipay-protocol'
import type { CoatiPayConfig } from '../lib/types'
import { request } from '../lib/types'

export class X402 {
  constructor(private config: CoatiPayConfig) {}

  /**
   * Returns a Fastify preHandler hook that requires x402 payment.
   *
   * @example
   * app.addHook('preHandler', relay.x402.middleware({
   *   price: 1000,       // $0.001 USDC
   *   currency: 'usdc',
   *   chain: 'base',
   * }))
   */
  middleware(
    opts: X402MiddlewareOptions,
  ): (req: Request, reply: Response) => Promise<Response | undefined> {
    return async (req: Request, _reply: Response): Promise<Response | undefined> => {
      const challenge = await this.gate(req, opts)
      // challenge === null means payment was verified — let the request continue
      return challenge ?? undefined
    }
  }

  /**
   * Returns a Next.js App Router compatible handler that wraps a route with x402.
   *
   * @example
   * export const GET = relay.x402.handler({
   *   price: 1000,
   *   handler: async (req) => Response.json({ data: 'protected' })
   * })
   */
  handler(opts: X402MiddlewareOptions & { handler: (req: Request) => Promise<Response> }) {
    return async (req: Request): Promise<Response> => {
      const challenge = await this.gate(req, opts)
      if (challenge) return challenge
      return opts.handler(req)
    }
  }

  /**
   * Shared gate: extract X-PAYMENT, verify against the API, and either
   * return a 402 Response (challenge or rejection) or null when payment
   * is valid and the caller should proceed.
   */
  private async gate(req: Request, opts: X402MiddlewareOptions): Promise<Response | null> {
    const paymentHeader =
      req.headers instanceof Headers
        ? req.headers.get('x-payment')
        : (req.headers as unknown as Record<string, string>)['x-payment']

    if (!paymentHeader) {
      const body = this.buildPaymentRequired(opts, req.url)
      return new Response(JSON.stringify(body), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const valid = await this.verify(paymentHeader, opts)
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Payment verification failed' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return null
  }

  private buildPaymentRequired(opts: X402MiddlewareOptions, resource: string): X402PaymentRequired {
    return {
      x402Version: 1,
      accepts: [
        {
          scheme: 'exact',
          network: opts.chain === 'base' ? 'base' : opts.chain,
          maxAmountRequired: String(opts.price),
          resource,
          description: opts.description ?? 'API access',
          mimeType: 'application/json',
          payTo: this.config.merchantWallet ?? '',
          maxTimeoutSeconds: 300,
          // Derived from the chain (not hardcoded): USDC's address and EIP-712
          // domain name differ per chain — Base mainnet's name is "USD Coin",
          // Base Sepolia's is "USDC". A wrong `extra.name` makes the payer sign
          // the wrong domain → USDC rejects the settlement.
          asset: USDC_ADDRESSES[opts.chain],
          extra: { name: USDC_DOMAIN_NAMES[opts.chain], version: USDC_DOMAIN_VERSION },
        },
      ],
    }
  }

  private async verify(paymentHeader: string, opts: X402MiddlewareOptions): Promise<boolean> {
    try {
      const data = await request<{ verified?: boolean }>(this.config, {
        method: 'POST',
        path: '/x402/verify',
        body: { payment: paymentHeader, amount: opts.price, chain: opts.chain },
      })
      // Require an explicit verified=true (not just a 2xx) so a future API
      // response without verification can't slip a request through.
      return data?.verified === true
    } catch {
      // Verification request failed (network error or non-2xx response) — treat as unverified
      return false
    }
  }
}
