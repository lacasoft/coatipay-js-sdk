# Changelog

## 0.1.4 — 2026-09-28

### Changed

- **`webhooks.verify` follows the rules shared by every CoatiPay SDK**
  (vectors in `@lacasoft/coatipay-protocol/vectors/webhooks.json`):
  - valid if **any** `v1` matches, so a signing secret can be rotated without
    dropping deliveries (it used to check only the first one);
  - `t` must be all digits and appear once; spaces around parts are ignored;
  - the fourth argument also takes `{ tolerance, now }` — a number still sets
    the tolerance;
  - it throws `WebhookSignatureError` with a `reason`: `malformed_header`,
    `timestamp_out_of_tolerance` or `no_matching_signature`. It is still an
    `Error`, with the same messages.
- **`intentIdToBytes32` rejects a whitespace-only id**, as it already did an
  empty one: its hash is a nonce that looks valid and belongs to no intent.
- **`webhooks.register` takes `WebhookEventType[]`.** Passing an event that
  does not exist (such as `payment_intent.failed`) no longer type-checks.

### Added

- `webhooks.listDeadLetters({ limit })` and `webhooks.replayDeadLetter(id)`:
  deliveries that exhausted their retries, and sending one again.
- Exports `PaymentError` (x402 payment errors were already classified as such,
  but the class was not exported), `WebhookSignatureError`, and the
  `PaymentIntentStatus` and `WebhookEventType` types.
- Tests against the shared vectors: the authorization nonce, the full
  ERC-3009 authorization per network (domain, message, digest, signature and
  API body), the 21 webhook cases and every error class.

## 0.1.3 — 2026-09-28

### Changed

- **`@lacasoft/coatipay-protocol` 0.1.2: the error codes match what the API
  returns.** `CoatiPayErrorCode` is derived from the new `ERROR_CATALOG` (every
  code with the HTTP status it always comes with). It no longer lists
  `amount_too_small`, `amount_too_large`, `chain_not_supported`,
  `intent_expired` or `no_nodes_available` — the API never returned them — and
  now includes every code it does. `classifyError` maps more codes to their
  class: every validation reason to `ValidationError`, `invalid_session` and
  `invalid_token` to `AuthError`.

  Published `0.1.2` of this SDK already resolves protocol `0.1.2` on a fresh
  install (`^0.1.0`); this bumps the floor and the lockfile.

### Added

- `RateLimitError` (for `rate_limited`, HTTP 429) and `ERROR_CATALOG`,
  re-exported from the protocol package.

## Withdrawn versions — 2026-09-27

**0.1.0 and 0.1.1 cannot complete a payment**: they sign with a random nonce, and the API
and the SettlementHub reject any authorization whose nonce is not the intent id (see 0.1.2
below). Both are **deprecated on npm** with a message pointing here. Use **0.1.2 or later**.

The old `@lacasoft/openrelay-sdk` package (the name before the rebrand) has the same problem
and is deprecated too.

## 0.1.2 — 2026-09-01

### ⚠️ Breaking: `intentId` is now required when signing

The SettlementHub now requires the ERC-3009 authorization nonce to equal the
intent id. **Signatures produced by 0.1.1 and earlier are rejected on-chain**,
so upgrading is not optional if you are signing payments.

```diff
- const nonce = generateNonce()
- const typed = buildReceiveAuthorizationTypedData({ payer, amount, nonce, ... })
+ const typed = buildReceiveAuthorizationTypedData({ payer, amount, intentId, ... })
```

Pass the **textual** intent id (`pi_…`) exactly as the API returns it. The SDK
derives the on-chain nonce itself; you do not need to hash anything. `intentIdToBytes32` is
exported if you want to verify the derivation.

The random-nonce generator has been **removed**. There is no migration path that
keeps it: a random nonce is precisely the defect this release fixes.

### Why

A signed authorization was not bound to any particular intent. Because USDC
enforces `msg.sender == to`, the signed `to` is always the hub and can never
name a merchant — so the payment destination was decided by calldata that the
routing node controls. A malicious node could redirect a payment and keep
**997 of every 1000 USDC**.

Reported externally and fixed in ADR-004. Full write-up:
https://github.com/lacasoft/coatipay-protocol/blob/master/audits/adr/004-auth-binding-y-retirada-de-disputas.md

### Also

- Protocol fee is now **1.5%** (ADR-005), split 70/30 as before: 1.05% to the
  routing node, 0.45% to the treasury.
