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
  intentIdToBytes32,
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
    it(`${JSON.stringify(c.intent_id)}`, () => {
      expect(intentIdToBytes32(c.intent_id)).toBe(c.nonce)
    })
  }
  for (const r of vector('nonce.json').rechazados) {
    it(`rechaza ${JSON.stringify(r.intent_id)} (${r.motivo})`, () => {
      expect(() => intentIdToBytes32(r.intent_id)).toThrow(TypeError)
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
