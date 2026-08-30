// EIP-712 / ERC-3009 helpers for the CoatiPay SDK.
//
// Used to construct the `ReceiveWithAuthorization` typed-data message that
// USDC v2.x on Base verifies when the SettlementHub calls
// `usdc.receiveWithAuthorization(payer, hub, amount, ..., v, r, s)`.
//
// Two consumption modes:
//   1. Server-side / automation: pass a private key to `signReceiveAuthorization`
//      and get back {v, r, s} directly.
//   2. Client-side / browser wallet: call `buildReceiveAuthorizationTypedData`
//      to get the EIP-712 structure, hand to viem's walletClient.signTypedData
//      (or window.ethereum), parse the resulting 65-byte signature with
//      `splitSignature`.
import {
  CHAIN_IDS,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  type SupportedChain,
  USDC_ADDRESSES,
  USDC_DOMAIN_NAMES,
  USDC_DOMAIN_VERSION,
} from '@lacasoft/coatipay-protocol'
import { type Address, type Hex, hexToBytes, keccak256, serializeSignature, toHex } from 'viem'
import { sign } from 'viem/accounts'

export type { SupportedChain }
// ERC-3009 / USDC EIP-712 constants are the single source of truth in
// @lacasoft/coatipay-protocol. Re-exported here so SDK consumers keep importing
// `USDC_ADDRESSES` / `SupportedChain` from `@lacasoft/coatipay-sdk` unchanged.
export { USDC_ADDRESSES }

/// Default authorization validity window (30 minutes from sign time).
const DEFAULT_VALIDITY_WINDOW_SECONDS = 30 * 60

export interface BuildAuthorizationParams {
  /** Payer address — the `from` of the USDC transfer. Must match the signer. */
  payer: Address
  /** Amount in USDC base units (6 decimals). Must match the intent's amount. */
  amount: bigint
  /** SettlementHub contract address — the `to` of the authorization. */
  settlementHub: Address
  /** Which chain — picks USDC contract address + chainId. */
  chain: SupportedChain
  /**
   * Identificador on-chain del intent que se está pagando (bytes32).
   *
   * Se usa como nonce de la autorización, y el contrato lo EXIGE: sin esa
   * atadura, quien envía la transacción —el nodeit— podía aplicar esta firma
   * a otro intent y quedarse el pago. Ya no es opcional ni aleatorio.
   */
  intentId: Hex
  /** Unix seconds; signature invalid before this. Default: 0 (always valid from start). */
  validAfter?: bigint
  /** Unix seconds; signature invalid after this. Default: now + 30 minutes. */
  validBefore?: bigint
}

export interface AuthorizationMessage {
  from: Address
  to: Address
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
}

export interface AuthorizationTypedData {
  domain: {
    name: string
    version: string
    chainId: number
    verifyingContract: Address
  }
  types: {
    EIP712Domain: { name: string; type: string }[]
    ReceiveWithAuthorization: { name: string; type: string }[]
  }
  primaryType: 'ReceiveWithAuthorization'
  message: AuthorizationMessage
}

/// EIP-712 `ReceiveWithAuthorization` typed data builder. Hand the result to
/// viem's `walletClient.signTypedData` (browser/wallet) or to
/// `signReceiveAuthorization` (server-side with a private key).
export function buildReceiveAuthorizationTypedData(
  params: BuildAuthorizationParams,
): AuthorizationTypedData {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const validAfter = params.validAfter ?? 0n
  const validBefore = params.validBefore ?? nowSeconds + BigInt(DEFAULT_VALIDITY_WINDOW_SECONDS)
  // El nonce ES el intent: así la firma solo sirve para pagar ese intent.
  const nonce = params.intentId

  return {
    domain: {
      name: USDC_DOMAIN_NAMES[params.chain],
      version: USDC_DOMAIN_VERSION,
      chainId: CHAIN_IDS[params.chain],
      verifyingContract: USDC_ADDRESSES[params.chain],
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ReceiveWithAuthorization: RECEIVE_WITH_AUTHORIZATION_TYPES.ReceiveWithAuthorization,
    },
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: params.payer,
      to: params.settlementHub,
      value: params.amount,
      validAfter,
      validBefore,
      nonce,
    },
  }
}

export interface SignedAuthorization {
  /** Payer address (the `from` of the USDC transfer). */
  payer: Address
  /** Authorization validity window. */
  validAfter: bigint
  validBefore: bigint
  /**
   * Nonce de la autorización, hex de 32 bytes. **Es el `intentId`**: el
   * contrato exige `nonce == intentId` para que una firma no pueda aplicarse
   * a otro intent. Ya no es un valor aleatorio.
   */
  nonce: Hex
  /**
   * Raw signature, hex-encoded. For an EOA this is the 65-byte ECDSA blob; for
   * a smart-contract wallet it's the ERC-1271 signature. USDC's
   * `receiveWithAuthorization(...,bytes)` validates both (FiatTokenV2_2).
   */
  signature: Hex
}

/// Server-side signing convenience. For browser/wallet flows, use
/// `buildReceiveAuthorizationTypedData` + your wallet's `signTypedData`.
export async function signReceiveAuthorization(
  params: BuildAuthorizationParams,
  privateKey: Hex,
): Promise<SignedAuthorization> {
  const typed = buildReceiveAuthorizationTypedData(params)
  const digest = hashTypedData(typed)
  const sig = await sign({ hash: digest, privateKey })
  return {
    payer: typed.message.from,
    validAfter: typed.message.validAfter,
    validBefore: typed.message.validBefore,
    nonce: typed.message.nonce,
    signature: serializeSignature(sig),
  }
}

/// Parse a 65-byte hex signature (as returned by viem's `signTypedData`)
/// into {v, r, s}. Use this after a wallet-side sign to package the result
/// for `submitAuthorization`.
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const bytes = hexToBytes(signature)
  if (bytes.length !== 65) {
    throw new Error(`Invalid signature length: ${bytes.length} bytes (expected 65)`)
  }
  const r = toHex(bytes.slice(0, 32))
  const s = toHex(bytes.slice(32, 64))
  // Length-checked above, so index 64 is guaranteed.
  let v = bytes[64] as number
  // EIP-155 / EIP-1559 wallets may return v as 0 or 1; normalize to 27/28.
  if (v < 27) v += 27
  return { v, r, s }
}


// ── Internal: EIP-712 hashing + signing ───────────────────────

const EIP712DOMAIN_TYPEHASH = keccak256(
  toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
)

const RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
  toHex(
    'ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)',
  ),
)

function hashTypedData(typed: AuthorizationTypedData): Hex {
  const domainSeparator = keccak256(
    encodeAbi(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        EIP712DOMAIN_TYPEHASH,
        keccak256(toHex(typed.domain.name)),
        keccak256(toHex(typed.domain.version)),
        BigInt(typed.domain.chainId),
        typed.domain.verifyingContract,
      ],
    ),
  )

  const m = typed.message
  const structHash = keccak256(
    encodeAbi(
      ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256', 'bytes32'],
      [
        RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
        m.from,
        m.to,
        m.value,
        m.validAfter,
        m.validBefore,
        m.nonce,
      ],
    ),
  )

  // EIP-712 final digest: keccak256("\x19\x01" || domainSeparator || structHash)
  return keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as Hex)
}

// Minimal ABI encoder for the fixed-shape encodings we need (no dynamic
// types — only addresses, uints, bytes32). Avoids pulling viem's full
// `encodeAbiParameters` for ~10 lines of work.
function encodeAbi(
  types: ('bytes32' | 'uint256' | 'address')[],
  values: (Hex | bigint | Address)[],
): Hex {
  const parts: string[] = []
  for (let i = 0; i < types.length; i++) {
    const t = types[i]
    const v = values[i]
    if (t === 'bytes32') {
      parts.push((v as Hex).slice(2).padStart(64, '0'))
    } else if (t === 'uint256') {
      parts.push((v as bigint).toString(16).padStart(64, '0'))
    } else if (t === 'address') {
      parts.push((v as Address).slice(2).toLowerCase().padStart(64, '0'))
    }
  }
  return `0x${parts.join('')}` as Hex
}
