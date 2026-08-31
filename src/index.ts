import type { CoatiPayConfig } from './lib/types'
import { PaymentIntents } from './resources/payment-intents'
import { Webhooks } from './resources/webhooks'
import { X402 } from './x402/middleware'

export class CoatiPay {
  private config: CoatiPayConfig

  readonly paymentIntents: PaymentIntents
  readonly webhooks: Webhooks
  readonly x402: X402

  constructor(config: CoatiPayConfig) {
    if (!config.apiKey) throw new Error('CoatiPay: apiKey is required')

    this.config = {
      baseUrl: config.baseUrl ?? 'https://api.coatipay.com',
      apiKey: config.apiKey,
      timeout: config.timeout ?? 30_000,
      ...(config.merchantWallet !== undefined && { merchantWallet: config.merchantWallet }),
      ...(config.logger !== undefined && { logger: config.logger }),
    }

    this.paymentIntents = new PaymentIntents(this.config)
    this.webhooks = new Webhooks(this.config)
    this.x402 = new X402(this.config)
  }
}

export type {
  CreatePaymentIntentParams,
  CoatiPayError,
  CoatiPayErrorCode,
  PaymentIntent,
  WebhookEvent,
  X402MiddlewareOptions,
} from '@lacasoft/coatipay-protocol'
export {
  AuthError,
  classifyError,
  NetworkError,
  CoatiPaySDKError,
  RoutingError,
  ValidationError,
} from '@lacasoft/coatipay-protocol'
export type {
  AuthorizationMessage,
  AuthorizationTypedData,
  BuildAuthorizationParams,
  SignedAuthorization,
  SupportedChain,
} from './lib/eip712'

// ── ERC-3009 / ADR-003 gasless settlement ────────────────────
export {
  buildReceiveAuthorizationTypedData,
  intentIdToBytes32,
  signReceiveAuthorization,
  splitSignature,
  USDC_ADDRESSES,
} from './lib/eip712'
export type { LogEntry, CoatiPayConfig } from './lib/types'
export type {
  SubmitAuthorizationBatchResponse,
  SubmitAuthorizationResponse,
} from './resources/payment-intents'
