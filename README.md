# x402 Conformance Kit

**A dependency-free conformance harness for the [x402](https://github.com/x402-foundation/x402) v2 HTTP payment protocol — with the exactly-once tests the reference SDKs were missing.**

Point it at any x402-protected endpoint. It runs the transport and core-schema checks, then does the one thing that actually protects money: it proves the endpoint settles **exactly once** under retry and conflicting-payment-identifier conditions.

```bash
npx x402-conformance https://your-endpoint.example/premium --agent my-agent --secret <hmac-secret>
```

```
=== x402 v2 conformance — https://your-endpoint.example/premium ===

  ✓ 1  · unpaid request → 402 Payment Required
  ✓ 1e · PaymentRequirements carry {scheme, network, amount, payTo, maxTimeoutSeconds}
  ✓ 2  · valid payment → 200 (resource unlocked)
  ✓ 3  · ★ retry with the SAME PAYMENT-SIGNATURE → the SAME transaction (idempotent, not a second charge)
  ✓ 4  · reused payment-identifier with a DIFFERENT payload → refused
  ✓ 7  · wrong payTo (merchant substitution) → rejected
  ✓ 8  · overpay/underpay vs "exact" amount → rejected
  …
  x402-conformance: 16 passed, 0 failed
```

## Why this exists

Published work on the x402 ecosystem ([arXiv 2605.30998](https://arxiv.org/abs/2605.30998), May 2026) documented a **duplicate-settlement race in the reference SDKs and a production deployment** — an agent that retries on timeout could be charged twice. Neither x402 nor AP2 specifies exactly-once semantics; that obligation falls to each implementation, and implementations have gotten it wrong.

If you are building an x402 merchant or facilitator, this kit answers the question your users care about most: **can a retrying agent be double-charged against my endpoint?**

## What it checks

| # | Check |
|---|---|
| 1 | Transport: `402` + `PAYMENT-REQUIRED` header, base64 JSON |
| 1b–1e | Core schema: `x402Version: 2`, `accepts[]`, `PaymentRequirements` fields |
| 2 | Happy path: valid payment → `200` + `PAYMENT-RESPONSE` settlement |
| **3** | **★ Exactly-once: retry with the same `PAYMENT-SIGNATURE` → the same transaction, not a second charge** |
| 4 | Idempotency conflict: reused `payment-identifier` + different payload → refused |
| 5 | Tampered signed field → rejected |
| 6 | Payment bound to a different resource → rejected (merchant binding) |
| 7 | Wrong `payTo` (merchant substitution) → rejected |
| 8 | Wrong amount vs `exact` scheme → rejected |
| 9 | Expired `validBefore` → rejected |
| 10 | Malformed payload → rejected without crashing |

## Scope, stated honestly

This kit proves **x402 v2 HTTP transport + core schema + the `payment-identifier` idempotency extension**. It is Rung 3 evidence: an independent implementation, written from the [x402-foundation spec](https://github.com/x402-foundation/x402), using only Node's `crypto` and global `fetch` — zero framework imports.

It does **not** assert the SVM `exact` scheme's signed-transaction payload. The `payload` field is scheme-specific; the reference client plugs a documented HMAC stand-in where a real Solana signer goes. To test the SVM scheme end to end, replace `schemePayload()` in [`x402-reference-client.js`](./x402-reference-client.js) with your signer — everything else stays.

## The reference client

[`x402-reference-client.js`](./x402-reference-client.js) is 78 lines, dependency-free, and readable. It's a working x402 v2 client you can lift into your own tests. The only non-spec part is `schemePayload()` — clearly isolated, and the seam where a real signer attaches.

## Requirements

Node ≥ 20. No dependencies. No build step.

## License

Apache-2.0.
