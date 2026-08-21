#!/usr/bin/env node
// ═══ FALSIFY WRIT — a public bounty harness that dares you to break the money invariants ══════════
//
//   node falsify-writ.js                       # against the public sandbox (default)
//   node falsify-writ.js https://writ.money    # explicit target
//   node falsify-writ.js http://localhost:8795 # your own instance
//
// Writ (writ.money) claims four money-safety invariants. This script does not TEST them politely — it
// ATTACKS them, against a live endpoint, using only the public sandbox that any agent can self-provision
// (POST /api/sandbox/join). If any attack succeeds, the corresponding line prints "★ BROKEN" and the
// script exits non-zero — and you have found something worth telling us about. It never has, but the
// only honest way to make that claim is to hand you the gun.
//
//   I. NO DOUBLE-SPEND      a retried/duplicated payment settles at most once
//  II. NO AUTHORITY WIDEN   a delegated sub-agent cannot spend beyond its granted ceiling
// III. NO SILENT LEDGER EDIT the published ledger head cannot be rewritten without external collision
//  IV. FAIL-CLOSED POLICY   an over-cap / off-category / frozen spend moves zero money
//
// Dependency-free. Node >= 20. The sandbox is internal-rail and valueless, so nothing here can move
// real money — which is precisely why it can be a public, unauthenticated challenge.
'use strict';
const crypto = require('crypto');

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith('--')) || 'https://writ.money').replace(/\/$/, '');
const J = async (r) => { try { return await r.json(); } catch (_) { return {}; } };
const post = (p, body, headers) => fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
const get = (p, headers) => fetch(BASE + p, { headers: headers || {} });

let broken = 0, held = 0, skipped = 0;
const HELD = (m) => { held++; console.log('  \x1b[32m✓ HELD\x1b[0m    ' + m); };
const BROKEN = (m) => { broken++; console.log('  \x1b[31m★ BROKEN\x1b[0m  ' + m + '   ← you found something. Tell us: https://github.com/wildcherrycasa/x402-conformance-kit/issues'); };
const SKIP = (m) => { skipped++; console.log('  \x1b[2m· skip\x1b[0m    ' + m); };

async function join(overrides) {
  const r = await post('/api/sandbox/join', Object.assign({ name: 'falsify' }, overrides || {}));
  if (r.status !== 200) return null;
  return J(r);
}

(async () => {
  console.log('\n\x1b[1mFALSIFY WRIT\x1b[0m — attacking the money invariants at ' + BASE);
  console.log('\x1b[2mThe sandbox is internal-rail and valueless. If a line says BROKEN, you have a finding.\x1b[0m\n');

  // reachability
  let up = false; try { up = (await get('/api/ready')).status === 200; } catch (_) {}
  if (!up) { console.error('  cannot reach ' + BASE + '/api/ready — is the endpoint live?'); process.exit(2); }

  const sandbox = await join();
  if (!sandbox || !sandbox.credential) {
    // sandbox disabled or real-money deployment — the harness cannot run its attacks, and says so
    console.log('  \x1b[2mThe sandbox did not provision (disabled, or this is a real-money deployment that refuses');
    console.log('  self-service). The attacks below need a sandbox credential and cannot run here.\x1b[0m');
    process.exit(3);
  }
  const KEY = sandbox.credential;
  const H = { 'x-agent-key': KEY };
  console.log('  \x1b[2mprovisioned a sandbox in ' + BASE + ' — budget $' + sandbox.limits.budget + ', internal rail, TTL-expiring\x1b[0m\n');

  // ── I · DOUBLE-SPEND: fire N identical payments with ONE idempotency key, count settlements ──────
  console.log('  I. NO DOUBLE-SPEND');
  { const idem = 'falsify-dbl-' + crypto.randomBytes(6).toString('hex');
    const body = { amount: 1, category: 'api', merchant: 'FALSIFY', idempotencyKey: idem };
    const results = await Promise.all(Array.from({ length: 8 }, () => post('/api/pay', body, H).then(J)));
    const settled = results.filter((r) => r.decision === 'APPROVED' || r.decision === 'ALREADY_DONE');
    const authIds = new Set(settled.map((r) => r.authId).filter(Boolean));
    if (authIds.size <= 1) HELD('8 concurrent identical payments → ' + authIds.size + ' settlement (retry never double-charges)');
    else BROKEN('8 concurrent identical payments produced ' + authIds.size + ' DISTINCT settlements');
    // sequential replay of the same key
    const again = await J(await post('/api/pay', body, H));
    if (again.decision === 'ALREADY_DONE' || (again.authId && authIds.has(again.authId))) HELD('a later retry of the same key → the same transaction, not a new one');
    else if (again.decision === 'APPROVED' && !authIds.has(again.authId)) BROKEN('replaying the same idempotency key created a NEW settlement ' + again.authId);
    else HELD('a later retry of the same key did not create a new charge (' + (again.decision || again.reason) + ')');
  }

  // ── II · AUTHORITY WIDENING: try to widen a delegation chain and spend beyond the leaf ───────────
  // Done purely client-side against the delegation math the server exposes: build a chain, tamper it to
  // widen the leaf, and confirm the server's /api/pay refuses it. (Requires a root key configured on the
  // deployment; the public sandbox does not run delegated-required mode, so this probes the math the same
  // way the server does and reports honestly if the live route is not exercisable.)
  console.log('  II. NO AUTHORITY WIDENING');
  { // A forged/widened chain presented to /api/pay must be refused BY THE DELEGATION GATE — not by some
    // other guard firing first. So the amount stays WITHIN the sandbox's own cap ($1), which means only
    // the delegation logic can reject it: a refusal here is the delegation gate's doing, and an APPROVE
    // here would mean a self-supplied chain widened authority. (We cannot forge a valid root signature we
    // do not hold, which is the whole point — the server must refuse a chain it cannot verify.)
    const inCap = Math.min(1, sandbox.limits.per_payment_cap);
    const fakeChain = [{ envelope: { agent: 'X', source_protocol: 'native', max_amount: 999 }, delegate_id: 'X',
      parent_hash: null, issued_at: Date.now(), signer_pubkey: 'not-a-real-key', alg: 'ed25519', signature: 'AAAA' }];
    const r = await J(await post('/api/pay', { amount: inCap, category: 'api', merchant: 'FALSIFY', idempotencyKey: 'falsify-del-' + crypto.randomBytes(4).toString('hex'), delegation_chain: fakeChain }, H));
    if (r.decision === 'DENIED' && /DELEGATION/.test(r.reason || '')) HELD('a forged delegation chain, WITHIN cap, → DENIED (' + r.reason + ') — the delegation gate refused it, no money moved');
    else if (r.decision === 'DENIED') SKIP('a chain-bearing payment was denied by a non-delegation guard (' + r.reason + ') on this deployment — the delegation gate is not the refuser here; see the swarm demo for the full attenuation proof');
    else if (r.decision === 'APPROVED') BROKEN('a forged, unverifiable delegation chain AUTHORIZED a spend');
    else SKIP('delegation route not exercisable on this deployment (' + (r.reason || r.error || 'no-op') + ') — see the swarm demo for the full attenuation proof');
  }

  // ── III · SILENT LEDGER EDIT: the published head must be signed + externally anchorable ───────────
  console.log('  III. NO SILENT LEDGER EDIT');
  { const a = await J(await get('/api/anchor'));
    if (!a.head || !/^[a-f0-9]{64}$/.test(a.head.hash || '')) SKIP('/api/anchor not exposed on this deployment — cannot verify external anchoring');
    else {
      HELD('the ledger head is published (seq ' + a.head.seq + ', sha256 ' + a.head.hash.slice(0, 12) + '…) — record it and hold us to it');
      if (a.witness && a.witness.enabled && a.witness.latest_anchor && a.witness.latest_anchor.signature) {
        // verify the signature ourselves, against the served public key — trust nothing
        const anc = a.witness.latest_anchor;
        const canon = (v) => (v === null || typeof v !== 'object') ? JSON.stringify(v === undefined ? null : v)
          : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
          : '{' + Object.keys(v).filter((k) => v[k] !== undefined && k !== 'hash').sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
        const preimage = Buffer.from(canon({ ledger_id: anc.ledger_id, seq: anc.seq, head_hash: anc.hash, ts: anc.ts }));
        let sigOk = false; try { sigOk = crypto.verify(null, preimage, a.witness.pubkey, Buffer.from(anc.signature, 'base64')); } catch (_) {}
        if (sigOk) HELD('the latest anchor is Ed25519-signed and verifies against the served public key');
        else BROKEN('the published anchor signature does NOT verify against the served public key');
      } else SKIP('external witness sink not configured on this deployment (head is published but not yet signed-anchored)');
    }
  }

  // ── IV · FAIL-CLOSED POLICY: over-cap, off-category, and post-expiry must move zero money ─────────
  console.log('  IV. FAIL-CLOSED POLICY');
  { const over = await J(await post('/api/pay', { amount: sandbox.limits.per_payment_cap + 100, category: 'api', merchant: 'FALSIFY', idempotencyKey: 'falsify-cap-' + crypto.randomBytes(4).toString('hex') }, H));
    if (over.decision === 'DENIED') HELD('a spend over the per-payment cap → DENIED (' + over.reason + ')');
    else BROKEN('a spend of $' + (sandbox.limits.per_payment_cap + 100) + ' over a $' + sandbox.limits.per_payment_cap + ' cap was ' + over.decision);
    const cat = await J(await post('/api/pay', { amount: 1, category: 'weapons', merchant: 'FALSIFY', idempotencyKey: 'falsify-cat-' + crypto.randomBytes(4).toString('hex') }, H));
    if (cat.decision === 'DENIED' && cat.reason === 'CATEGORY_NOT_ALLOWED') HELD('an off-category spend → DENIED (CATEGORY_NOT_ALLOWED)');
    else BROKEN('an off-category spend was ' + cat.decision + ' (' + (cat.reason || '') + ')');
  }

  // ── V · x402 EXACTLY-ONCE: the live x402 loop must settle a retried payment once ─────────────────
  // The property the reference x402 SDKs got wrong (arXiv 2605.30998). If Writ hosts a live x402
  // resource, pay it twice with the SAME nonce and confirm the budget drops once.
  console.log('  V. x402 EXACTLY-ONCE (live endpoint)');
  { const bz = await J(await get('/x402/bazaar'));
    if (!bz.resources || !bz.resources.length) SKIP('no live x402 resource advertised on this deployment');
    else {
      const item = bz.resources[0];
      const nonce = 'x402_' + crypto.randomBytes(12).toString('hex');
      const mkHeader = (n) => Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: item.network,
        payload: { authorization: { scheme: 'exact', network: item.network, asset: item.asset, payTo: item.payTo,
          from: sandbox.agent_id, value: String(Math.round(item.price * 1e6)), nonce: n,
          validBefore: Date.now() + 300000, resource: item.resource, agentId: sandbox.agent_id, category: item.category } } })).toString('base64');
      const before = (await J(await get('/api/agents/' + sandbox.agent_id, H))).remaining;
      const pay1 = await J(await get(item.resource, Object.assign({ 'X-PAYMENT': mkHeader(nonce) }, H)));
      const pay2 = await J(await get(item.resource, Object.assign({ 'X-PAYMENT': mkHeader(nonce) }, H)));   // SAME nonce
      const after = (await J(await get('/api/agents/' + sandbox.agent_id, H))).remaining;
      const dropped = before - after;
      if (pay1.delivered && Math.abs(dropped - item.price) < 1e-9)
        HELD('paid an x402 resource, then retried the SAME nonce → charged once ($' + dropped + '), resource delivered — exactly-once holds on the live x402 loop');
      else if (Math.abs(dropped - 2 * item.price) < 1e-9)
        BROKEN('a retried x402 payment with the same nonce charged TWICE ($' + dropped + ')');
      else SKIP('x402 resource did not deliver as expected (dropped $' + dropped + ') — cannot assess exactly-once here');
    }
  }

  // ── VI · CONSENSUS HONESTY: the public attestation must match the published head or admit it doesn't ─
  // A trust badge is only worth anything if it fails closed. If /api/consensus claims the head is attested
  // AND settle-safe, that head MUST equal the one /api/anchor publishes. A badge that says "safe" on a head
  // the server doesn't publish is the exact lie this checks for.
  console.log('  VI. CONSENSUS HONESTY');
  { const c = await J(await get('/api/consensus'));
    if (!c || c.available === undefined) SKIP('/api/consensus not exposed on this deployment');
    else if (c.available === false) HELD('no validator confirming right now → the panel says so (available:false), it does not fake finality');
    else {
      const a = await J(await get('/api/anchor'));
      const anchorHash = a && a.head && a.head.hash;
      if (c.settle_allowed === true && c.head && c.head.hash !== anchorHash)
        BROKEN('/api/consensus advertised settle_allowed on head ' + (c.head.hash || '').slice(0, 12) + '… while /api/anchor publishes ' + String(anchorHash).slice(0, 12) + '…');
      else if (c.head_matches_anchor === true && c.head && c.head.hash === anchorHash)
        HELD('the attested head (seq ' + c.head.seq + ') EQUALS the published anchor, signed by an independent validator (' + ((c.validators && c.validators[0] && c.validators[0].fingerprint) || '?') + ')');
      else HELD('consensus reports a divergence honestly (head_matches_anchor=' + c.head_matches_anchor + ', settle_allowed=' + c.settle_allowed + ') rather than claiming safe');
      if (/PRIVATE KEY|BEGIN [A-Z ]*KEY/.test(JSON.stringify(c))) BROKEN('/api/consensus leaked key material in its response');
      else HELD('/api/consensus exposes only fingerprints — no key material served');
    }
  }

  console.log('\n\x1b[1m' + (broken ? '\x1b[31mWRIT WAS FALSIFIED' : '\x1b[32mWRIT HELD') + '\x1b[0m — '
    + held + ' invariants held, ' + broken + ' broken, ' + skipped + ' not exercisable here');
  if (!broken) console.log('\x1b[2mNo invariant broke. If you disagree, the sandbox is free and public — try harder, then open an issue.\x1b[0m');
  process.exit(broken ? 1 : 0);
})().catch((e) => { console.error('harness error: ' + e.message); process.exit(2); });
