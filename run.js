#!/usr/bin/env node
// x402 v2 conformance harness — points at ANY x402-protected resource and runs the battery.
//   x402-conformance <resource-url> [--agent jarvis] [--secret <hmac-secret>]
//
// It answers one question the x402 reference SDKs left open: does this implementation settle
// EXACTLY ONCE? A duplicate-settlement race was documented in those SDKs (arXiv 2605.30998);
// this harness proves — or disproves — the property against a live endpoint.
//
// Scope, stated honestly: x402 v2 HTTP TRANSPORT + CORE SCHEMA + the payment-identifier
// idempotency extension. NOT the SVM `exact` scheme's signed-transaction payload (that plugs in
// where schemePayload lives in the reference client). Rung 3: independent implementation.
const client = require('./x402-reference-client');

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
if (!url) { console.error('usage: x402-conformance <resource-url> [--agent <id>] [--secret <hmac-secret>]'); process.exit(2); }
const agentId = opt('agent', 'agent-1');
const secret = opt('secret', '');

let pass = 0, fail = 0, skip = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \x1b[32m✓\x1b[0m ' + m)) : (fail++, console.log('  \x1b[31m✗\x1b[0m ' + m)); };
const note = (m) => { skip++; console.log('  \x1b[33m·\x1b[0m ' + m); };

(async () => {
  console.log('=== x402 v2 conformance — ' + url + ' ===\n');

  // 1 · transport + challenge schema
  let r0;
  try { r0 = await fetch(url); } catch (e) { console.error('  cannot reach ' + url + ': ' + e.message); process.exit(1); }
  const ch = client.b64d(r0.headers.get('PAYMENT-REQUIRED'));
  ok(r0.status === 402, '1 · unpaid request → 402 Payment Required');
  ok(!!ch, '1b · PAYMENT-REQUIRED header present, base64 JSON');
  if (!ch) { finish(); return; }
  ok(ch.x402Version === 2, '1c · challenge declares x402Version: 2');
  ok(Array.isArray(ch.accepts) && ch.accepts.length > 0, '1d · accepts[] present (PaymentRequirements list)');
  const a0 = (ch.accepts || [])[0] || {};
  ok(!!(a0.scheme && a0.network && a0.amount != null && a0.payTo && a0.maxTimeoutSeconds > 0),
     '1e · PaymentRequirements carry {scheme, network, amount, payTo, maxTimeoutSeconds}');

  // 2 · happy path
  const p1 = await client.payResource({ url, agentId, secret });
  const settledOnce = p1.ok && p1.settlement && p1.settlement.transaction;
  ok(p1.status === 200, '2 · valid payment → 200 (resource unlocked)');
  ok(!!settledOnce, '2b · PAYMENT-RESPONSE carries a settlement transaction');
  ok(!!(p1.settlement && p1.settlement.success === true), '2c · settlement.success === true');
  if (!settledOnce) { console.log('\n  (endpoint did not settle a first payment — exactly-once checks need a baseline; stopping)'); finish(); return; }

  // 3 · ★ EXACTLY-ONCE — the check the reference SDKs were missing
  const p2 = await client.payResource({ url, reuseHeader: p1.header });
  ok(p2.settlement && p2.settlement.transaction === p1.settlement.transaction,
     '3 · ★ retry with the SAME PAYMENT-SIGNATURE → the SAME transaction (idempotent, not a second charge)');

  // 4 · payment-identifier conflict — same id, different payload MUST be refused
  const pid = (client.b64d(p1.header).extensions || {})['payment-identifier'];
  if (pid && pid.info && pid.info.id) {
    const p3 = await client.payResource({ url, agentId, secret, paymentId: pid.info.id });
    ok(!p3.ok, '4 · reused payment-identifier with a DIFFERENT payload → refused (no ambiguous double outcome)');
  } else { note('4 · endpoint did not echo a payment-identifier — idempotency-by-id not asserted'); }

  // 5-8 · negative battery: tamper / wrong-merchant / wrong-amount / expired must all be rejected
  const neg = async (label, m) => { const r = await client.payResource(m); ok(!r.ok, label); };
  await neg('5 · tampered signed field → rejected', { url, agentId, secret, tamperSignature: true });
  await neg('6 · payment for a DIFFERENT resource → rejected (merchant binding)', { url, agentId, secret, mutate: a => { a.resource = '/some-other-path'; } });
  await neg('7 · wrong payTo (merchant substitution) → rejected', { url, agentId, secret, mutate: a => { a.payTo = 'AttackerPubkey1111111111111111111111111111'; } });
  await neg('8 · overpay/underpay vs "exact" amount → rejected', { url, agentId, secret, mutate: a => { a.value = String((+a.value || 0) + 1000000); } });
  await neg('9 · expired validBefore → rejected', { url, agentId, secret, validForMs: -60000 });
  const mf = await client.payResource({ url, reuseHeader: '!!!not-base64!!!' });
  ok(!mf.ok, '10 · malformed payload → rejected without crashing');

  finish();
  function finish() {
    console.log('\n\x1b[1mx402-conformance: ' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' not-asserted' : '') + '\x1b[0m');
    console.log('RUNG 3 · independent implementation · SCOPE: x402 v2 HTTP transport + core schema + payment-identifier idempotency.');
    console.log('NOT asserted: SVM `exact` signed-transaction scheme (plug your signer into schemePayload in x402-reference-client.js).');
    process.exit(fail ? 1 : 0);
  }
})().catch(e => { console.error('\n  harness error: ' + e.message); process.exit(1); });
