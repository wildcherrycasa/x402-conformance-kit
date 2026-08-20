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

## Bonus: `falsify-writ` — a standing challenge

The same harness philosophy, pointed at a live implementation that *claims* the properties. Writ
([writ.money](https://writ.money)) publishes four money-safety invariants; this script attacks them
against the public sandbox any agent can self-provision — no signup, no key, nothing to install:

```bash
npx --package=x402-conformance-kit falsify-writ https://writ.money
```

```
  I. NO DOUBLE-SPEND
  ✓ HELD    8 concurrent identical payments → 1 settlement (retry never double-charges)
  II. NO AUTHORITY WIDENING
  ✓ HELD    a forged delegation chain, WITHIN cap, → DENIED — no money moved
  III. NO SILENT LEDGER EDIT
  ✓ HELD    the ledger head is published — record it and hold us to it
  IV. FAIL-CLOSED POLICY
  ✓ HELD    over-cap and off-category spends → DENIED
```

If any line prints **★ BROKEN**, the script exits non-zero and you have found something worth an
issue. Point it at *your* endpoint too — the invariants are not Writ-specific, and an implementation
that cannot survive its own bounty harness should not be holding anyone's money.

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

## Exactly-once probes

Speaking x402 correctly and being safe to retry against are different properties. The `E`-series probes
test the second one, black-box, using the only observable that matters: **two distinct transaction
identifiers for one signed payload is a duplicate settlement.** That signal is deliberately conservative
- an endpoint that refuses a retry outright also passes, because refusing is not double-charging.

| probe | what it does |
|---|---|
| **E1** | 8 **concurrent** retries of one signed payment |
| **E2** | sequential retry of the same signed payment |
| **E3** | retry **after** a TTL-bounded cache would have evicted (opt-in: `--ttl-seconds`) |
| **E4** | two genuinely different payments must settle as two - dedup must not over-match |
| **E5** | reused `payment-identifier` carrying a different payload |
| **E6** | interleaved duplicates of two payments - each exactly once, and still distinct |

**E3 is the one that matters, and it does not run by default** because it costs real wall-clock. The
reference SVM mitigation is described in the [x402 documentation](https://docs.x402.org/core-concepts/facilitator)
as *"a short-lived, in-memory cache ... entries are automatically evicted after 120 seconds"*, documented
for Solana only. A design like that passes E1 and E2 and looks correct. To test it:

```bash
npx x402-conformance <url> --ttl-seconds 130
```

An in-memory cache also loses its record across a process restart, and a second facilitator instance has
its own. E3 covers the time bound; the other two are worth checking by hand against your deployment.

### Proving the probes have teeth

`fixtures/ttl-cache-endpoint.js` is a deliberately flawed endpoint reproducing exactly that design. Run
the kit against it and E1/E2 pass while E3 fails - which is how you know a green E3 means something:

```bash
node fixtures/ttl-cache-endpoint.js 8877 2 &
npx x402-conformance http://127.0.0.1:8877/premium --ttl-seconds 5
# EXACTLY-ONCE: DUPLICATE SETTLEMENT DETECTED
```

Passing these probes does not prove an implementation is correct. Failing one proves it is not.

## Scope, stated honestly

This kit proves **x402 v2 HTTP transport + core schema + the `payment-identifier` idempotency extension**. It is Rung 3 evidence: an independent implementation, written from the [x402-foundation spec](https://github.com/x402-foundation/x402), using only Node's `crypto` and global `fetch` — zero framework imports.

It does **not** assert the SVM `exact` scheme's signed-transaction payload. The `payload` field is scheme-specific; the reference client plugs a documented HMAC stand-in where a real Solana signer goes. To test the SVM scheme end to end, replace `schemePayload()` in [`x402-reference-client.js`](./x402-reference-client.js) with your signer — everything else stays.

## The reference client

[`x402-reference-client.js`](./x402-reference-client.js) is 78 lines, dependency-free, and readable. It's a working x402 v2 client you can lift into your own tests. The only non-spec part is `schemePayload()` — clearly isolated, and the seam where a real signer attaches.

## Requirements

Node ≥ 20. No dependencies. No build step.

## License

Apache-2.0.
