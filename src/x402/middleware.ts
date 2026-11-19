import type { X402MiddlewareOptions, X402PaymentRequired } from '@lacasoft/coatipay-protocol'
import {
  USDC_ADDRESSES,
  USDC_DOMAIN_NAMES,
  USDC_DOMAIN_VERSION,
} from '@lacasoft/coatipay-protocol'
import type { CoatiPayConfig } from '../lib/types'
import { request } from '../lib/types'

/**
 * Lo que el hook de `middleware()` usa de la petición de Fastify
 * (`FastifyRequest`). Tipos estructurales: el SDK no depende de Fastify.
 */
export interface X402HookRequest {
  url: string
  headers: Record<string, string | string[] | undefined>
}

/**
 * Lo que el hook de `middleware()` usa de la respuesta de Fastify
 * (`FastifyReply`): `reply.code(402).header(…).send(…)`.
 */
export interface X402HookReply {
  code(statusCode: number): X402HookReply
  header(name: string, value: string): X402HookReply
  send(payload?: unknown): X402HookReply
}

export class X402 {
  constructor(private config: CoatiPayConfig) {}

  /**
   * Returns a Fastify `preHandler` hook: without a verified `X-PAYMENT` it
   * answers 402 and the route does not run. For Web `Request` handlers use
   * `handler()`.
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
  ): (req: X402HookRequest, reply: X402HookReply) => Promise<X402HookReply | undefined> {
    return async (req, reply) => {
      // Sin un `reply` de Fastify no hay cómo cortar la petición: mejor un
      // error (la ruta no corre) que dejarla pasar sin cobrar.
      if (typeof reply?.code !== 'function' || typeof reply.send !== 'function') {
        throw new TypeError('x402.middleware() is a Fastify hook; for Web Request use x402.handler()')
      }
      const rechazo = await this.check(cabeceraDePago(req.headers), req.url, opts)
      // null: pago verificado, sigue la ruta.
      if (rechazo === null) return undefined
      // En un hook async, Fastify ignora lo que se devuelva y sigue con la
      // ruta, salvo que se responda con `reply` y se devuelva `reply`.
      return reply.code(402).header('content-type', 'application/json').send(rechazo)
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

  private async gate(req: Request, opts: X402MiddlewareOptions): Promise<Response | null> {
    // Para `handler()`: un 402 como `Response`, o null si el pago es válido.
    const rechazo = await this.check(cabeceraDePago(req.headers), req.url, opts)
    if (rechazo === null) return null
    return new Response(JSON.stringify(rechazo), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  private async check(
    paymentHeader: string | undefined,
    resource: string,
    opts: X402MiddlewareOptions,
  ): Promise<X402PaymentRequired | { error: string } | null> {
    // Sin `X-PAYMENT`, los requisitos de pago; con él, se verifica en la API.
    // Devuelve el cuerpo del 402, o null si el pago es válido.
    if (!paymentHeader) return this.buildPaymentRequired(opts, resource)
    const valid = await this.verify(paymentHeader, opts)
    return valid ? null : { error: 'Payment verification failed' }
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

/** `X-PAYMENT` de un `Headers` web o de las cabeceras de Node/Fastify. */
function cabeceraDePago(
  headers: Headers | Record<string, string | string[] | undefined>,
): string | undefined {
  if (headers instanceof Headers) return headers.get('x-payment') ?? undefined
  const valor = headers?.['x-payment']
  return Array.isArray(valor) ? valor[0] : valor
}
