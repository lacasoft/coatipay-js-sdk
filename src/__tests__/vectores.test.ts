import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { type Address, type Hex, hashTypedData } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildReceiveAuthorizationTypedData,
  classifyError,
  CoatiPay,
  CoatiPaySDKError,
  intentIdOf,
  intentRef,
  NetworkError,
  PAYMENT_INTENT_ID_PATTERN,
  signReceiveAuthorization,
  WebhookSignatureError,
} from '../index'

/**
 * Los vectores compartidos entre los SDK de CoatiPay
 * (`@lacasoft/coatipay-protocol/vectors`): el mismo juego de casos que pasan
 * los SDK de Python y PHP. Si este SDK se desvía, falla aquí y no en producción.
 */
// Los del protocolo instalado; en CI, además, los de la última versión
// publicada (COATIPAY_VECTORES), para enterarse de un vector nuevo aunque la
// dependencia no se haya actualizado. CommonJS, como el resto del SDK.
const require = createRequire(__filename)
const DIRECTORIO =
  process.env.COATIPAY_VECTORES ??
  dirname(require.resolve('@lacasoft/coatipay-protocol/vectors/nonce.json'))
const vector = (nombre: string) => JSON.parse(readFileSync(join(DIRECTORIO, nombre), 'utf8'))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)
beforeEach(() => mockFetch.mockReset())

describe('vectores: nonce', () => {
  for (const c of vector('nonce.json').casos) {
    it(`${JSON.stringify(c.intent_id)} · ${c.merchant}`, () => {
      expect(intentRef(c.intent_id)).toBe(c.ref)
      expect(intentIdOf(c.merchant, c.intent_id)).toBe(c.nonce)
    })
  }
  for (const r of vector('nonce.json').rechazados) {
    it(`rechaza ${JSON.stringify(r.intent_id)} · ${r.merchant} (${r.motivo})`, () => {
      expect(() => intentIdOf(r.merchant, r.intent_id)).toThrow(TypeError)
    })
  }
})

describe('vectores: id de cobro en la ruta', () => {
  const ids = vector('ids.json')
  const relay = new CoatiPay({ apiKey: 'sk_test_vectores', baseUrl: 'https://api.test' })
  const auth = {
    payer: '0x0000000000000000000000000000000000000001' as Address,
    validAfter: 0n,
    validBefore: 1n,
    nonce: `0x${'00'.repeat(32)}` as Hex,
    signature: '0x00' as Hex,
  }
  const llamadas = (id: string) => [
    ['GET', `/payment_intents/${id}`, () => relay.paymentIntents.retrieve(id)],
    ['POST', `/payment_intents/${id}/cancel`, () => relay.paymentIntents.cancel(id)],
    ['POST', `/payment_intents/${id}/authorize`, () => relay.paymentIntents.submitAuthorization(id, auth)],
  ] as const

  it('el patrón es el del protocolo', () => {
    expect(ids.patron).toBe(PAYMENT_INTENT_ID_PATTERN.source)
  })
  for (const id of ids.aceptados as string[]) {
    it(`acepta ${JSON.stringify(id)}: la petición va a su ruta`, async () => {
      for (const [metodo, ruta, llamar] of llamadas(id)) {
        mockFetch.mockReset()
        mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }))
        await llamar()
        const [url, opciones] = mockFetch.mock.calls[0] as [string, { method: string }]
        expect(url).toBe(`https://api.test/v1${ruta}`)
        expect(opciones.method).toBe(metodo)
      }
    })
  }
  for (const r of ids.rechazados as { id: string; motivo: string }[]) {
    it(`rechaza ${JSON.stringify(r.id)} (${r.motivo}) sin hacer la petición`, async () => {
      for (const [, , llamar] of llamadas(r.id)) {
        await expect(llamar()).rejects.toThrow(TypeError)
      }
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }
})

describe('vectores: autorización ERC-3009', () => {
  for (const c of vector('autorizacion.json').casos) {
    const e = c.esperado
    const params = {
      payer: e.api_body.payer as Address,
      amount: BigInt(c.entrada.amount),
      settlementHub: c.entrada.settlement_hub as Address,
      chain: c.entrada.chain,
      intentId: c.entrada.intent_id,
      merchant: c.entrada.merchant,
      validAfter: BigInt(c.entrada.valid_after),
      validBefore: BigInt(c.entrada.valid_before),
    }

    it(`${c.entrada.chain} · ${c.entrada.intent_id}: dominio, mensaje y digest`, () => {
      const tipado = buildReceiveAuthorizationTypedData(params)
      expect(tipado.domain).toEqual(e.domain)
      expect({
        ...tipado.message,
        value: tipado.message.value.toString(),
        validAfter: tipado.message.validAfter.toString(),
        validBefore: tipado.message.validBefore.toString(),
      }).toEqual(e.message)
      expect(hashTypedData(tipado as unknown as Parameters<typeof hashTypedData>[0])).toBe(e.digest)
    })

    it(`${c.entrada.chain} · ${c.entrada.intent_id}: firma y cuerpo de la API`, async () => {
      const firmada = await signReceiveAuthorization(params, c.entrada.payer_private_key as Hex)
      expect(firmada.signature).toBe(e.signature)

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ intent_id: c.entrada.intent_id, status: 'queued' }),
      })
      const relay = new CoatiPay({ apiKey: 'sk_test_vectores', baseUrl: 'https://api.test' })
      await relay.paymentIntents.submitAuthorization(c.entrada.intent_id, firmada)
      const [, opciones] = mockFetch.mock.calls[0] as [string, { body: string }]
      expect(JSON.parse(opciones.body)).toEqual(e.api_body)
    })
  }
})

describe('vectores: webhooks', () => {
  const w = vector('webhooks.json')
  const relay = new CoatiPay({ apiKey: 'sk_test_vectores', baseUrl: 'https://api.test' })

  for (const c of w.casos) {
    it(c.nombre, () => {
      const verificar = () =>
        relay.webhooks.verify(c.cuerpo ?? w.cuerpo, c.cabecera, w.secreto, {
          now: w.ahora,
          ...(c.tolerancia !== undefined ? { tolerance: c.tolerancia } : {}),
        })
      if (c.esperado.valida) {
        const evento = verificar()
        if (c.cuerpo === undefined) expect(evento).toEqual(w.evento)
      } else {
        let error: unknown
        try {
          verificar()
        } catch (e) {
          error = e
        }
        expect(error).toBeInstanceOf(WebhookSignatureError)
        expect((error as WebhookSignatureError).reason).toBe(c.esperado.motivo)
      }
    })
  }
})

describe('vectores: errores', () => {
  const v = vector('errores.json')
  const clase = (code: string) =>
    classifyError({ code: code as never, message: 'm', param: null, doc_url: 'https://coatipay.com/docs' })

  it('cada código del catálogo, con su clase', () => {
    for (const [code, { clase: esperada }] of Object.entries(v.codigos) as [string, { clase: string }][]) {
      const e = clase(code)
      expect(e.name, code).toBe(esperada)
      expect(e).toBeInstanceOf(CoatiPaySDKError)
    }
  })

  it('un código desconocido es CoatiPaySDKError, nunca un fallo', () => {
    expect(clase(v.desconocido.code).name).toBe(v.desconocido.clase)
  })
})

describe('vectores: respuestas de la API', () => {
  const relay = new CoatiPay({ apiKey: 'sk_test_vectores', baseUrl: 'https://api.test' })

  for (const c of vector('errores.json').respuestas.casos) {
    it(c.nombre, async () => {
      if (c.respuesta === null) mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))
      else mockFetch.mockResolvedValueOnce(new Response(c.respuesta.cuerpo, { status: c.respuesta.status }))

      const llamada = relay.paymentIntents.retrieve('pi_vector')
      const e = c.esperado
      if (e.ok) {
        await expect(llamada).resolves.toEqual(JSON.parse(c.respuesta.cuerpo))
        return
      }
      const error = await llamada.then(
        () => expect.fail('debía lanzar'),
        (err: unknown) => err,
      )
      expect(error).toBeInstanceOf(CoatiPaySDKError)
      const sdk = error as CoatiPaySDKError
      expect(sdk.name).toBe(e.clase)
      expect({ code: sdk.code, param: sdk.param, doc_url: sdk.doc_url }).toEqual({
        code: e.code,
        param: e.param,
        doc_url: e.doc_url,
      })
      if (e.clase === 'NetworkError') {
        expect(error).toBeInstanceOf(NetworkError)
        expect((error as NetworkError).status).toBe(e.status)
      }
    })
  }
})
