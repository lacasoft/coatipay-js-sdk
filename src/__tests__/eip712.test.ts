import { type Hex, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  buildReceiveAuthorizationTypedData,
  intentIdToBytes32,
  signReceiveAuthorization,
  splitSignature,
  USDC_ADDRESSES,
} from '../lib/eip712'

const HUB = '0x1111111111111111111111111111111111111111' as const
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const PAYER_ADDR = privateKeyToAccount(PAYER_KEY).address

describe('buildReceiveAuthorizationTypedData', () => {
  it('builds the canonical Centre USDC v2 EIP-712 structure', () => {
    const typed = buildReceiveAuthorizationTypedData({
      payer: PAYER_ADDR,
      amount: 5_000_000n,
      settlementHub: HUB,
      chain: 'base-sepolia',
      intentId: 'pi_test_001',
      validAfter: 0n,
      validBefore: 1_700_001_000n,
    })

    expect(typed.domain.name).toBe('USDC')
    expect(typed.domain.version).toBe('2')
    expect(typed.domain.chainId).toBe(84532)
    expect(typed.domain.verifyingContract).toBe(USDC_ADDRESSES['base-sepolia'])
    expect(typed.primaryType).toBe('ReceiveWithAuthorization')

    expect(typed.message).toEqual({
      from: PAYER_ADDR,
      to: HUB,
      value: 5_000_000n,
      validAfter: 0n,
      validBefore: 1_700_001_000n,
      nonce: intentIdToBytes32('pi_test_001'),
    })

    // Field types match the ERC-3009 spec exactly
    const fieldTypes = typed.types.ReceiveWithAuthorization.map((f) => `${f.name}:${f.type}`).join(
      ',',
    )
    expect(fieldTypes).toBe(
      'from:address,to:address,value:uint256,validAfter:uint256,validBefore:uint256,nonce:bytes32',
    )
  })

  it('uses Base mainnet USDC address + chainId for chain="base"', () => {
    const typed = buildReceiveAuthorizationTypedData({
      payer: PAYER_ADDR,
      amount: 1n,
      settlementHub: HUB,
      chain: 'base',
      intentId: 'pi_test_001',
    })
    expect(typed.domain.chainId).toBe(8453)
    expect(typed.domain.name).toBe('USD Coin')
    expect(typed.domain.verifyingContract).toBe(USDC_ADDRESSES.base)
  })

  it('deriva el nonce del id textual, sin que nadie calcule el hash', () => {
    const td = buildReceiveAuthorizationTypedData({
      payer: PAYER_ADDR,
      amount: 5_000_000n,
      settlementHub: HUB,
      chain: 'base-sepolia',
      intentId: 'pi_abc123',
    })
    expect(td.message.nonce).toBe(intentIdToBytes32('pi_abc123'))
    expect(td.message.nonce).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('ata el nonce al intent, para que la firma solo sirva para ese pago', () => {
    const intentId = 'pi_dead_beef'
    const td = buildReceiveAuthorizationTypedData({
      payer: PAYER_ADDR,
      amount: 5_000_000n,
      settlementHub: HUB,
      chain: 'base-sepolia',
      intentId,
    })
    expect(td.message.nonce).toBe(intentIdToBytes32(intentId))
  })

  it('defaults validAfter=0 and validBefore≈now+30min', () => {
    const before = Math.floor(Date.now() / 1000)
    const typed = buildReceiveAuthorizationTypedData({
      payer: PAYER_ADDR,
      amount: 1n,
      settlementHub: HUB,
      chain: 'base-sepolia',
      intentId: 'pi_test_001',
    })
    const after = Math.floor(Date.now() / 1000)

    expect(typed.message.validAfter).toBe(0n)
    expect(typed.message.validBefore).toBeGreaterThanOrEqual(BigInt(before + 30 * 60))
    expect(typed.message.validBefore).toBeLessThanOrEqual(BigInt(after + 30 * 60))
  })
})

describe('signReceiveAuthorization', () => {
  it('produces a signature that recovers to the payer (EIP-712 round-trip)', async () => {
    const params = {
      payer: PAYER_ADDR,
      amount: 5_000_000n,
      settlementHub: HUB,
      chain: 'base-sepolia' as const,
      intentId: 'pi_test_001',
      validAfter: 0n,
      validBefore: 9_999_999_999n,
    }
    const auth = await signReceiveAuthorization(params, PAYER_KEY)

    // `auth.signature` is the raw 65-byte EOA blob — recover directly.
    const typed = buildReceiveAuthorizationTypedData(params)
    const recovered = await recoverTypedDataAddress({
      domain: typed.domain,
      types: { ReceiveWithAuthorization: typed.types.ReceiveWithAuthorization },
      primaryType: 'ReceiveWithAuthorization',
      message: typed.message as unknown as Record<string, unknown>,
      signature: auth.signature,
    })
    expect(recovered.toLowerCase()).toBe(PAYER_ADDR.toLowerCase())
  })

  it('matches the SignedAuthorization shape used by submitAuthorization', async () => {
    const auth = await signReceiveAuthorization(
      {
        payer: PAYER_ADDR,
        amount: 1_000n,
        settlementHub: HUB,
        chain: 'base-sepolia',
        intentId: 'pi_test_001',
      },
      PAYER_KEY,
    )

    expect(auth.payer).toBe(PAYER_ADDR)
    expect(typeof auth.validAfter).toBe('bigint')
    expect(typeof auth.validBefore).toBe('bigint')
    expect(auth.nonce.length).toBe(66)
    // raw 65-byte EOA signature: 0x + 130 hex chars
    expect(auth.signature).toMatch(/^0x[0-9a-f]{130}$/)
  })
})

describe('splitSignature', () => {
  it('splits a 65-byte hex signature into {v, r, s}', () => {
    // 65 bytes = 32 r + 32 s + 1 v
    const r = '11'.repeat(32)
    const s = '22'.repeat(32)
    const sig = `0x${r}${s}1c` as Hex // v = 0x1c = 28
    const out = splitSignature(sig)

    expect(out.r).toBe(`0x${r}`)
    expect(out.s).toBe(`0x${s}`)
    expect(out.v).toBe(28)
  })

  it('normalizes EIP-1559 v=0/1 to 27/28', () => {
    const r = '11'.repeat(32)
    const s = '22'.repeat(32)
    const sigV0 = `0x${r}${s}00` as Hex
    const sigV1 = `0x${r}${s}01` as Hex
    expect(splitSignature(sigV0).v).toBe(27)
    expect(splitSignature(sigV1).v).toBe(28)
  })

  it('throws on invalid signature length', () => {
    expect(() => splitSignature('0xdead' as Hex)).toThrow(/Invalid signature length/)
  })
})

