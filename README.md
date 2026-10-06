# @lacasoft/coatipay-sdk

The CoatiPay JavaScript/TypeScript SDK — **Stripe-compatible payments for the open web**.
Accept **USDC on Base** with no gatekeepers: gasless settlement (ERC-3009), webhooks, and
**x402** micropayments for AI agents. 1.5% protocol fee (1.05% nodeit / 0.45% treasury), settled
trustlessly on-chain.

- ⛽ **Gasless for payers** — they sign an ERC-3009 authorization; the nodeit pays the gas.
- 🤖 **x402 micropayments** — gasless per-request USDC for AI agents, at amounts Stripe can't serve.
- 🧩 **Stripe-like DX** — `paymentIntents.create`, `webhooks.verify`.
- 🌐 **Open network** — no lock-in: any nodeit can settle your payments, and anyone can run one.

## Install

```bash
npm install @lacasoft/coatipay-sdk
# pnpm add @lacasoft/coatipay-sdk   ·   yarn add @lacasoft/coatipay-sdk
```

> No need to clone the monorepo — `@lacasoft/coatipay-protocol` (types + constants) comes along
> automatically; `viem` is a dependency.

## Quick start

```typescript
import { CoatiPay } from '@lacasoft/coatipay-sdk'

// Use a SECRET key, server-side only — never ship it to the browser.
const relay = new CoatiPay({ apiKey: process.env.COATIPAY_SECRET_KEY! })

// Create a charge — amounts are USDC base units (6 decimals → 1 USDC = 1_000_000).
const intent = await relay.paymentIntents.create({
  amount: 10_000_000, // 10.00 USDC
  currency: 'usdc',
  chain: 'base',
  metadata: { orderId: 'order_123' },
  // Safe to retry: the same key with the same parameters returns the same intent.
  idempotency_key: 'order_123',
})

console.log(intent.id, intent.status) // "pi_…"  "created"
```

## Webhooks

```typescript
import { WebhookSignatureError } from '@lacasoft/coatipay-sdk'

app.post('/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  let event
  try {
    event = relay.webhooks.verify(
      req.body.toString(), // the RAW body, before any JSON parsing
      req.headers['x-signature'],
      process.env.COATIPAY_WEBHOOK_SECRET!,
    )
  } catch (e) {
    if (e instanceof WebhookSignatureError) return res.status(400).send(e.reason)
    throw e
  }
  // At least once and in no particular order: deduplicate by event.id.
  if (event.type === 'payment_intent.settled') {
    fulfillOrder(event.data.metadata.orderId)
  }
  res.sendStatus(200)
})
```

- `verify` checks the HMAC-SHA256 signature in constant time and rejects a timestamp more
  than 5 minutes away from now (replay protection): `{ tolerance }` changes it, in seconds.
- On failure it throws `WebhookSignatureError` with a `reason`: `malformed_header`,
  `timestamp_out_of_tolerance` or `no_matching_signature`.
- Events: `payment_intent.created`, `payment_intent.settled`, `payment_intent.expired`,
  `payment_intent.cancelled`.
- **Rotating the secret.** `rotateSecret` returns a new secret — once: store it. The
  previous one keeps signing next to it for 24 hours (`keepPreviousFor`, in seconds, up to
  7 days), and `verify` accepts either, so you change the secret on your server without
  dropping a delivery. If a secret leaked, `keepPreviousFor: 0` retires it at once.

  ```typescript
  const { secret, previous_secret_expires_at } = await relay.webhooks.rotateSecret('we_…')
  await relay.webhooks.rotateSecret('we_…', { keepPreviousFor: 0 }) // leaked: stop now
  ```
- **Deliveries that exhausted their retries** stay in a dead-letter queue:

  ```typescript
  const { data } = await relay.webhooks.listDeadLetters({ limit: 20 })
  await relay.webhooks.replayDeadLetter(data[0].id) // same event, same id, retries reset
  ```

## Errors

```typescript
import { CoatiPaySDKError, NetworkError } from '@lacasoft/coatipay-sdk'

try {
  await relay.paymentIntents.create({ amount, currency: 'usdc', chain: 'base', idempotency_key: orderId })
} catch (e) {
  if (e instanceof NetworkError) {
    // No CoatiPay answer (e.status: the HTTP status, or null). Whether it took effect is
    // unknown: retrying with the same idempotency_key returns the same intent.
  } else if (e instanceof CoatiPaySDKError) {
    console.log(e.code, e.message, e.param, e.doc_url)
  }
}
```

Everything a call throws is a `CoatiPaySDKError`, with `code`, `message`, `param` and
`doc_url` (the code's page at [coatipay.com/docs/errors](https://coatipay.com/docs/errors/)).
The class tells the kind: `AuthError`, `ValidationError`, `RoutingError`, `PaymentError`,
`RateLimitError`, or the base class for the rest and for a code this version does not know.
`NetworkError` is one too, so check it first. The same classes and rules in the Python
and PHP SDKs.

## x402 — micropayments for AI agents

```typescript
// Gate any endpoint behind a per-request micropayment.
app.addHook(
  'preHandler',
  relay.x402.middleware({
    price: 300_000, // 0.30 USDC per request
    currency: 'usdc',
    chain: 'base',
  }),
)
```

Any HTTP client that speaks x402 — including AI agents over MCP — can pay and consume your
endpoint autonomously.

> **Economics:** on-chain settlement costs gas, so each call must clear a floor
> (the node keeps 1.05% of the payment and pays the gas). The API rejects
> amounts below the configured `MIN_PAYMENT_AMOUNT` — **~$0.30/call** on Base
> today. True sub-cent micropayments need off-chain netting — on the roadmap.

### The HTTP flow (x402 spec)

The middleware speaks the standard [x402](https://x402.org) protocol on the wire:

```http
# 1. Client requests the resource — no payment yet
GET /api/data HTTP/1.1

# 2. Server answers 402 with the payment requirements (x402 spec shape)
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "maxAmountRequired": "1000",         // 0.001 USDC (base units)
    "resource": "/api/data",
    "payTo": "0x742d35Cc…",              // merchant wallet
    "asset": "0x833589fC…",              // USDC on Base
    "maxTimeoutSeconds": 300,
    "extra": { "name": "USDC", "version": "2" }
  }]
}

# 3. Client pays and retries with the payment proof
GET /api/data HTTP/1.1
X-PAYMENT: <base64 payment payload>

# 4. Server verifies on-chain (POST /v1/x402/verify) and serves the resource
HTTP/1.1 200 OK
```

## Configuration

```typescript
new CoatiPay({
  apiKey: 'sk_live_…', // required — secret key, server-side only
  baseUrl: 'https://api.coatipay.com', // optional — your CoatiPay API host
  timeout: 30_000, // optional — request timeout in ms
})
```

## Links

- Repo, docs & protocol spec: https://github.com/lacasoft/coatipay-protocol
- Source: [`coatipay-js-sdk`](https://github.com/lacasoft/coatipay-js-sdk)
- License: Apache-2.0

---

### Contributing / local dev

To work on the SDK:

```bash
pnpm dev        # watch mode (cjs + esm + dts)
pnpm build      # build with tsup
pnpm test       # unit tests
pnpm typecheck  # type-check without emitting
```
