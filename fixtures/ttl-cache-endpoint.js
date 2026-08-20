// A DELIBERATELY FLAWED x402 endpoint, used to prove the exactly-once probes have teeth.
// It reproduces the reference SVM mitigation described in the x402 documentation: an in-memory
// SettlementCache with a time bound. Everything else about it is well behaved, so E1 and E2 pass -
// only E3, which waits out the window, exposes it. Run:  node fixtures/ttl-cache-endpoint.js 8899 2
const http = require('http');
const crypto = require('crypto');

const PORT = +(process.argv[2] || 8899);
const TTL_MS = +(process.argv[3] || 2) * 1000;      // the whole defect, in one constant
const b64e = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const b64d = (s) => { try { return JSON.parse(Buffer.from(String(s || ''), 'base64').toString('utf8')); } catch (_) { return null; } };

const CHALLENGE = {
  x402Version: 2,
  resource: { url: '/premium', description: 'ttl-cache fixture' },
  accepts: [{ scheme: 'exact', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', amount: '1000000',
              asset: 'USDC', payTo: 'FixturePayTo11111111111111111111111111111', maxTimeoutSeconds: 300 }],
};

const cache = new Map();                             // dedupKey -> { tx, at }
let minted = 0;

http.createServer((req, res) => {
  const sig = req.headers['payment-signature'];
  if (!sig) {
    res.writeHead(402, { 'PAYMENT-REQUIRED': b64e(CHALLENGE), 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'payment required' }));
  }
  const env = b64d(sig);
  if (!env || !env.payload) { res.writeHead(402); return res.end(JSON.stringify({ errorReason: 'MALFORMED' })); }

  // dedup key over the signed authorization - a reasonable choice, undone entirely by the time bound
  const key = crypto.createHash('sha256').update(JSON.stringify(env.payload.authorization || {})).digest('hex');
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > TTL_MS) cache.delete(k);   // eviction, exactly as documented

  const hit = cache.get(key);
  const tx = hit ? hit.tx : ('tx_' + (++minted) + '_' + crypto.randomBytes(3).toString('hex'));
  if (!hit) cache.set(key, { tx, at: now });

  res.writeHead(200, {
    'PAYMENT-RESPONSE': b64e({ success: true, transaction: tx, network: CHALLENGE.accepts[0].network, payer: 'fixture' }),
    'content-type': 'application/json',
  });
  res.end(JSON.stringify({ data: 'PREMIUM CONTENT', transaction: tx }));
}).listen(PORT, () => console.log('ttl-cache fixture on :' + PORT + ' (TTL ' + (TTL_MS / 1000) + 's)'));
