/**
 * Criterio 3: Verificación de firma de webhook con la utilidad oficial del SDK.
 * No se permite implementación propia de HMAC.
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('fetch', vi.fn())

import { CoatiPay } from '../../index.js'

const SECRET = 'whsec_official_secret_32chars_ok'

let relay: CoatiPay

beforeEach(() => {
  relay = new CoatiPay({ apiKey: 'sk_test_wh_verify', baseUrl: 'https://testnet.coatipay.com' })
})

function sign(payload: string, secret: string, ts: number): string {
  const sig = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')
  return `t=${ts},v1=${sig}`
}

describe('Criterio 3 — Verificación de firma (utilidad SDK oficial)', () => {
  it('acepta firma válida y retorna el evento parseado', () => {
    const payload = JSON.stringify({
      id: 'evt_ok',
      type: 'payment_intent.settled',
      created: 1,
      data: {},
    })
    const ts = Math.floor(Date.now() / 1000)
    const event = relay.webhooks.verify(payload, sign(payload, SECRET, ts), SECRET)

    expect(event.id).toBe('evt_ok')
    expect(event.type).toBe('payment_intent.settled')
  })

  it('rechaza firma con secret incorrecto', () => {
    const payload = JSON.stringify({
      id: 'evt_bad',
      type: 'payment_intent.created',
      created: 1,
      data: {},
    })
    const ts = Math.floor(Date.now() / 1000)
    const wrongSig = sign(payload, 'wrong_secret_completely', ts)

    expect(() => relay.webhooks.verify(payload, wrongSig, SECRET)).toThrow(
      'Signature verification failed',
    )
  })

  it('rechaza payload adulterado (mismo secret, diferente body)', () => {
    const original = JSON.stringify({
      id: 'evt_tamper',
      type: 'payment_intent.settled',
      created: 1,
      data: { amount: 1000 },
    })
    const ts = Math.floor(Date.now() / 1000)
    const validSig = sign(original, SECRET, ts)

    const tampered = JSON.stringify({
      id: 'evt_tamper',
      type: 'payment_intent.settled',
      created: 1,
      data: { amount: 999999 },
    })

    expect(() => relay.webhooks.verify(tampered, validSig, SECRET)).toThrow(
      'Signature verification failed',
    )
  })

  it('rechaza firma sin timestamp (t=)', () => {
    const payload = '{"id":"evt_nots"}'
    expect(() => relay.webhooks.verify(payload, 'v1=abc123', SECRET)).toThrow(
      'Invalid signature format',
    )
  })

  it('rechaza firma sin componente v1=', () => {
    const payload = '{"id":"evt_nov1"}'
    expect(() => relay.webhooks.verify(payload, 't=1700000000', SECRET)).toThrow(
      'Invalid signature format',
    )
  })

  it('rechaza string de firma vacío', () => {
    const payload = '{"id":"evt_empty"}'
    expect(() => relay.webhooks.verify(payload, '', SECRET)).toThrow('Invalid signature format')
  })

  it('rechaza timestamp modificado (replay con ts diferente)', () => {
    const payload = JSON.stringify({
      id: 'evt_replay_ts',
      type: 'payment_intent.created',
      created: 1,
      data: {},
    })
    const realTs = Math.floor(Date.now() / 1000)
    const realSig = createHmac('sha256', SECRET).update(`${realTs}.${payload}`).digest('hex')

    // Mismo v1 pero timestamp cambiado → firma inválida
    const fakeHeader = `t=${realTs + 300},v1=${realSig}`

    expect(() => relay.webhooks.verify(payload, fakeHeader, SECRET)).toThrow(
      'Signature verification failed',
    )
  })

  it('verifica todos los event types definidos en el protocolo', () => {
    const types = [
      'payment_intent.created',
      'payment_intent.settled',
      'payment_intent.failed',
      'payment_intent.cancelled',
      'dispute.opened',
    ] as const

    for (const type of types) {
      const payload = JSON.stringify({ id: `evt_${type}`, type, created: 1, data: {} })
      const ts = Math.floor(Date.now() / 1000)
      const event = relay.webhooks.verify(payload, sign(payload, SECRET, ts), SECRET)
      expect(event.type).toBe(type)
    }
  })

  it('usa relay.webhooks.verify — no implementación propia', () => {
    // Este test documenta la intención: la verificación de firma DEBE usar
    // el método oficial del SDK, no una reimplementación manual.
    expect(relay.webhooks.verify).toBeTypeOf('function')
    expect(relay.webhooks).toBeDefined()
  })
})
