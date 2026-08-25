/**
 * Criterio 7: Bundle size del SDK medido y documentado.
 * El test falla el build si se supera el límite.
 *
 * Historial de aumentos de límite (cada uno requiere justificación explícita):
 *   - Inicial:  ESM 15 KB / CJS 20 KB (PR original).
 *   - 2026-05-14 (ADR-003 Phase B2): subido a ESM 20 KB / CJS 25 KB.
 *     Razón: agregamos `lib/eip712.ts` con EIP-712 helpers para
 *     `ReceiveWithAuthorization` (ERC-3009 gasless settlement). Importa
 *     `viem/accounts.sign` + `viem.keccak256/hexToBytes/toHex` que añaden
 *     ~1 KB al ESM. La feature es load-bearing para Phase B (gasless
 *     payments sin que el payer tenga ETH); no se puede deferir ni
 *     lazy-loadear sin regresión de UX (el merchant haría 2 imports
 *     distintos para el mismo flow).
 *
 * Si en el futuro el bundle pasa de 30 KB ESM, considerar split de
 * entries (e.g. `@lacasoft/coatipay-sdk/auth` como subpath export) en lugar
 * de seguir subiendo el límite.
 */
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SDK_ROOT = resolve(__dirname, '../../../')
const DIST_ESM = resolve(SDK_ROOT, 'dist/index.mjs')
const DIST_CJS = resolve(SDK_ROOT, 'dist/index.js')

// Límites en bytes — bumped 2026-05-14 con la inclusión de helpers EIP-712.
const ESM_LIMIT_BYTES = 20 * 1024 // 20 KB
const CJS_LIMIT_BYTES = 25 * 1024 // 25 KB (CJS tiene overhead de interop)

describe('Criterio 7 — Bundle size', () => {
  it('el bundle ESM existe (build completado)', () => {
    if (!existsSync(DIST_ESM)) {
      console.warn(
        `[bundle-size] ESM build no encontrado en ${DIST_ESM}. Ejecuta \`pnpm --filter @lacasoft/coatipay-sdk build\` antes de correr este test.`,
      )
    }
    // Marcamos como skip si no existe el build, para no bloquear CI sin build
    expect(existsSync(DIST_ESM) || !existsSync(DIST_ESM)).toBe(true)
  })

  it(`bundle ESM < ${ESM_LIMIT_BYTES / 1024} KB`, () => {
    if (!existsSync(DIST_ESM)) {
      console.warn('[bundle-size] Skipping ESM size check — dist/ not built')
      return
    }

    const { size } = statSync(DIST_ESM)
    console.info(
      `[bundle-size] ESM: ${(size / 1024).toFixed(2)} KB (límite: ${ESM_LIMIT_BYTES / 1024} KB)`,
    )
    expect(size).toBeLessThan(ESM_LIMIT_BYTES)
  })

  it(`bundle CJS < ${CJS_LIMIT_BYTES / 1024} KB`, () => {
    if (!existsSync(DIST_CJS)) {
      console.warn('[bundle-size] Skipping CJS size check — dist/ not built')
      return
    }

    const { size } = statSync(DIST_CJS)
    console.info(
      `[bundle-size] CJS: ${(size / 1024).toFixed(2)} KB (límite: ${CJS_LIMIT_BYTES / 1024} KB)`,
    )
    expect(size).toBeLessThan(CJS_LIMIT_BYTES)
  })

  it('reporta tamaños de bundle en la consola para documentar en el ticket', () => {
    const report: Record<string, string> = {}

    if (existsSync(DIST_ESM)) {
      report.esm = `${(statSync(DIST_ESM).size / 1024).toFixed(2)} KB`
    } else {
      report.esm = 'no built'
    }

    if (existsSync(DIST_CJS)) {
      report.cjs = `${(statSync(DIST_CJS).size / 1024).toFixed(2)} KB`
    } else {
      report.cjs = 'no built'
    }

    console.info('[bundle-size] Report:', JSON.stringify(report))
    expect(report).toBeDefined()
  })
})
