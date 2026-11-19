import { USDC_BASE_ADDRESS } from '@lacasoft/coatipay-protocol'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoatiPay } from '../../index.js'

/**
 * `x402.middleware()` dentro de un Fastify de verdad, registrado como dice el
 * README. Hasta 0.2.0 el hook devolvía un `Response` y Fastify, en un hook
 * async, ignora lo que se devuelve: la ruta corría sin pago. Las pruebas
 * llamaban a la función a mano y nunca lo vieron; estas miran si la ruta corre.
 */
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const relay = new CoatiPay({
  apiKey: 'sk_test_x402_fastify',
  baseUrl: 'https://api.test',
  merchantWallet: '0xMerchantWallet123',
})
const OPCIONES = { price: 300_000, currency: 'usdc', chain: 'base' } as const

let app: FastifyInstance
let vecesQueCorre: number

async function montar(registro: 'global' | 'ruta'): Promise<FastifyInstance> {
  const a = Fastify()
  const ruta = async () => {
    vecesQueCorre++
    return { secreto: 'contenido de pago' }
  }
  if (registro === 'global') {
    a.addHook('preHandler', relay.x402.middleware(OPCIONES))
    a.get('/datos', ruta)
  } else {
    a.get('/datos', { preHandler: relay.x402.middleware(OPCIONES) }, ruta)
  }
  await a.ready()
  return a
}

const respuestaDeVerify = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  mockFetch.mockReset()
  vecesQueCorre = 0
})
afterEach(async () => {
  await app?.close()
})

for (const registro of ['global', 'ruta'] as const) {
  describe(`x402.middleware() en Fastify (hook ${registro})`, () => {
    beforeEach(async () => {
      app = await montar(registro)
    })

    it('sin X-PAYMENT: 402 con los requisitos de pago, y la ruta no corre', async () => {
      const r = await app.inject({ method: 'GET', url: '/datos?x=1' })
      expect(r.statusCode).toBe(402)
      expect(r.headers['content-type']).toContain('application/json')
      const cuerpo = r.json()
      expect(cuerpo.x402Version).toBe(1)
      expect(cuerpo.accepts).toHaveLength(1)
      expect(cuerpo.accepts[0]).toMatchObject({
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '300000',
        resource: '/datos?x=1',
        description: 'API access',
        mimeType: 'application/json',
        payTo: '0xMerchantWallet123',
        maxTimeoutSeconds: 300,
        asset: USDC_BASE_ADDRESS,
        extra: { name: 'USD Coin', version: '2' },
      })
      expect(r.body).not.toContain('contenido de pago')
      expect(vecesQueCorre).toBe(0)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('X-PAYMENT que la API no verifica: 402 y la ruta no corre', async () => {
      mockFetch.mockResolvedValueOnce(respuestaDeVerify({ verified: false }))
      const r = await app.inject({ method: 'GET', url: '/datos', headers: { 'x-payment': 'basura' } })
      expect(r.statusCode).toBe(402)
      expect(r.json()).toEqual({ error: 'Payment verification failed' })
      expect(vecesQueCorre).toBe(0)
    })

    it('la API responde con error: 402 y la ruta no corre', async () => {
      mockFetch.mockResolvedValueOnce(
        respuestaDeVerify({ error: { code: 'invalid_request', message: 'bad payment' } }, 400),
      )
      const r = await app.inject({ method: 'GET', url: '/datos', headers: { 'x-payment': 'x' } })
      expect(r.statusCode).toBe(402)
      expect(vecesQueCorre).toBe(0)
    })

    it('la API no responde: 402 y la ruta no corre', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))
      const r = await app.inject({ method: 'GET', url: '/datos', headers: { 'x-payment': 'x' } })
      expect(r.statusCode).toBe(402)
      expect(vecesQueCorre).toBe(0)
    })

    it('un 2xx sin verified=true no basta', async () => {
      mockFetch.mockResolvedValueOnce(respuestaDeVerify({ ok: true }))
      const r = await app.inject({ method: 'GET', url: '/datos', headers: { 'x-payment': 'x' } })
      expect(r.statusCode).toBe(402)
      expect(vecesQueCorre).toBe(0)
    })

    it('pago verificado: la ruta corre una vez, y se verificó lo que llegó', async () => {
      mockFetch.mockResolvedValueOnce(respuestaDeVerify({ verified: true }))
      const r = await app.inject({ method: 'GET', url: '/datos', headers: { 'x-payment': 'pago-valido' } })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ secreto: 'contenido de pago' })
      expect(vecesQueCorre).toBe(1)
      const [url, opciones] = mockFetch.mock.calls[0] as [string, { method: string; body: string }]
      expect(url).toBe('https://api.test/v1/x402/verify')
      expect(opciones.method).toBe('POST')
      expect(JSON.parse(opciones.body)).toEqual({ payment: 'pago-valido', amount: 300_000, chain: 'base' })
    })
  })
}

describe('x402.middleware() fuera de Fastify', () => {
  it('sin un reply de Fastify lanza en vez de dejar pasar la petición', async () => {
    const hook = relay.x402.middleware(OPCIONES)
    const req = { url: '/datos', headers: {} }
    await expect(hook(req, undefined as never)).rejects.toThrow(TypeError)
    // Un `res` de Express no tiene `code()`.
    const res = { status: () => res, header: () => res, send: () => res }
    await expect(hook(req, res as never)).rejects.toThrow(/x402\.handler\(\)/)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
