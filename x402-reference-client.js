// ═══ x402 v2 REFERENCE CLIENT — written FROM the x402-foundation/x402 spec, ZERO framework imports ══════
// Sources: specs/x402-specification-v2.md + specs/transports-v2/http.md + specs/extensions/payment_identifier.md.
// Uses ONLY `crypto` + global `fetch`. This client proves x402 v2 HTTP TRANSPORT + CORE-SCHEMA conformance:
//   • transport: 402 status · PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers · base64 JSON
//   • core schema: PaymentRequired{x402Version:2, accepts[], error?, resource{url,…}} ·
//     PaymentRequirements{scheme,network,amount,asset,payTo,maxTimeoutSeconds,extra?} ·
//     PaymentPayload{x402Version, resource?, accepted, payload, extensions?} · extensions echo rule
//   • payment-identifier extension: client-generated id, REUSED on retries (16-128 chars, pay_ prefix)
//
// ⚠️ SCHEME BOUNDARY (honest): `payload` is scheme-specific. The real x402 SVM `exact` scheme requires a
// base64 PARTIALLY-SIGNED VERSIONED SOLANA TRANSACTION — this client instead plugs a documented
// HMAC-authorization stand-in (schemePayload below). Therefore this client proves TRANSPORT + CORE-SCHEMA
// conformance, NOT SVM scheme conformance.
const crypto = require('crypto');

const b64e = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const b64d = (s) => { try { return JSON.parse(Buffer.from(String(s || ''), 'base64').toString('utf8')); } catch (_) { return null; } };

// ── SCHEME PLUG (HMAC stand-in — the ONLY non-spec-derived part, clearly isolated) ─────────────
// Field order + HMAC-SHA256 over a canonical JSON. Swap this whole function for a real signer.
const AUTH_FIELDS = ['scheme', 'network', 'asset', 'payTo', 'from', 'value', 'nonce', 'validBefore', 'resource', 'agentId', 'category'];
function schemePayload({ accepted, resourceUrl, agentId, secret, nonce, validForMs, mutate }) {
  const authorization = {
    scheme: accepted.scheme, network: accepted.network, asset: accepted.asset, payTo: accepted.payTo,
    from: agentId, value: String(accepted.amount),
    nonce: nonce || 'x402_' + crypto.randomBytes(12).toString('hex'),
    validBefore: Date.now() + (validForMs !== undefined ? validForMs : (accepted.maxTimeoutSeconds || 300) * 1000),
    resource: resourceUrl, agentId, category: (accepted.extra && accepted.extra.category) || 'api',
  };
  if (mutate) mutate(authorization);                       // test hook: pre-sign mutations (wrong resource/amount/…)
  const canon = {}; for (const k of AUTH_FIELDS) if (authorization[k] !== undefined && authorization[k] !== null) canon[k] = authorization[k];
  const signature = secret ? crypto.createHmac('sha256', String(secret)).update(JSON.stringify(canon)).digest('hex') : null;
  return { authorization, signature };
}

// ── CORE SCHEMA (pure spec) ────────────────────────────────────────────────────────────────────────────
function selectRequirements(paymentRequired) {                 // PaymentRequired.accepts[] per spec §core
  const accepts = (paymentRequired && paymentRequired.accepts) || [];
  return accepts.find(r => r.scheme === 'exact' && /^solana:/.test(r.network)) || accepts[0] || null;
}
function buildPaymentPayload({ paymentRequired, agentId, secret, paymentId, nonce, validForMs, mutate, tamperSignature }) {
  const accepted = selectRequirements(paymentRequired);
  if (!accepted) throw new Error('no acceptable PaymentRequirements');
  const resourceUrl = (paymentRequired.resource && paymentRequired.resource.url) || '/';
  const payload = schemePayload({ accepted, resourceUrl, agentId, secret, nonce, validForMs, mutate });
  // mutate a SIGNED field post-sign that requirements-matching does NOT cover (the charged agent) —
  // ONLY the signature check can catch this redirection attack → must be BAD_SIGNATURE
  if (tamperSignature) { payload.authorization.agentId = 'marketer'; payload.authorization.from = 'marketer'; }
  const pid = paymentId || 'pay_' + crypto.randomBytes(16).toString('hex');   // payment-identifier ext: 16-128 chars
  return {
    envelope: {
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted,
      payload,
      // extension echo rule: client must include at least the info received; may append (we append our id)
      extensions: Object.assign({}, paymentRequired.extensions, { 'payment-identifier': { info: { id: pid } } }),
    },
    paymentId: pid,
  };
}

// ── TRANSPORT (pure spec: transports-v2/http.md) ───────────────────────────────────────────────────────
async function payResource({ url, agentId, secret, paymentId, nonce, validForMs, mutate, tamperSignature, reuseHeader }) {
  // 1) initial request — expect 402 + PAYMENT-REQUIRED header (base64 JSON; body is non-normative)
  let res = await fetch(url);
  if (res.status !== 402) return { step: 'initial', ok: res.ok, status: res.status };
  const paymentRequired = b64d(res.headers.get('PAYMENT-REQUIRED'));
  if (!paymentRequired || paymentRequired.x402Version !== 2) return { step: 'challenge', ok: false, error: 'MALFORMED_OR_NON_V2_CHALLENGE', paymentRequired };
  // 2) build PaymentPayload → retry with PAYMENT-SIGNATURE header
  const header = reuseHeader || b64e(buildPaymentPayload({ paymentRequired, agentId, secret, paymentId, nonce, validForMs, mutate, tamperSignature }).envelope);
  res = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': header } });
  const settlement = b64d(res.headers.get('PAYMENT-RESPONSE'));
  let body = null; try { body = await res.json(); } catch (_) {}
  return { step: 'paid', ok: res.ok, status: res.status, paymentRequired, header, settlement, body };
}

module.exports = { selectRequirements, buildPaymentPayload, payResource, b64e, b64d };
