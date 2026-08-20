// ═══ EXACTLY-ONCE PROBES ═══════════════════════════════════════════════════════════════════════════
// Black-box only. No framework imports, no knowledge of any implementation's internals — the sole
// observable is what the endpoint returns, and the sole duplicate-settlement signal is TWO DISTINCT
// transaction identifiers for ONE signed payload. That is deliberately conservative: an endpoint that
// refuses a retry outright also passes, because refusing is not double-charging.
//
// Why these probes exist. Neither x402 nor AP2 specifies exactly-once semantics; the obligation falls
// to each implementation. The reference SVM mitigation is a SettlementCache described in the x402
// documentation as "a short-lived, in-memory cache ... entries are automatically evicted after 120
// seconds", documented for Solana only. Three consequences an implementer should be able to check:
//   • in-memory   -> a process restart between a payment and its retry loses the record
//   • 120s TTL    -> a retry after the window is a fresh charge (probe E3, opt-in: --ttl-seconds)
//   • per-process -> a second facilitator instance has its own cache
// Passing these probes does not prove an implementation is correct. Failing one proves it is not.
const client = require('./x402-reference-client');

const txOf = (r) => (r && r.settlement && (r.settlement.transaction || r.settlement.txId)) || null;
const settledOK = (r) => !!(r && r.ok && txOf(r));
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Distinct transaction ids across responses to the SAME signed payload = duplicate settlement.
function duplicates(results) {
  const ids = results.map(txOf).filter(Boolean);
  const distinct = [...new Set(ids)];
  return { ids, distinct, duplicated: distinct.length > 1 };
}

async function run({ url, agentId, secret, ok, note, ttlSeconds }) {
  // E1 - CONCURRENT identical retries. An agent that times out and retries while the first request is
  // still in flight: the exact shape of the race documented in the reference SDKs (arXiv 2605.30998).
  const first = await client.payResource({ url, agentId, secret });
  if (!settledOK(first)) {
    note('E1-E3 skipped - the endpoint did not settle a baseline payment');
  } else {
    const header = first.header;
    const burst = await Promise.all(Array.from({ length: 8 }, () =>
      client.payResource({ url, reuseHeader: header }).catch(() => null)));
    const d = duplicates([first, ...burst.filter(Boolean)]);
    ok(!d.duplicated, 'E1 - 8 CONCURRENT retries of one signed payment -> ' +
      (d.duplicated ? 'DUPLICATE SETTLEMENT (' + d.distinct.length + ' distinct transactions)'
                    : 'one transaction (' + (d.distinct[0] || 'n/a') + ')'));

    // E2 - sequential rapid retry
    const again = await client.payResource({ url, reuseHeader: header }).catch(() => null);
    ok(!duplicates([first, again].filter(Boolean)).duplicated,
      'E2 - sequential retry of the same signed payment -> no new transaction');

    // E3 - retry AFTER a TTL-bounded cache would have evicted. Opt-in: it costs real wall-clock.
    // This is the probe a 120-second in-memory cache fails.
    if (ttlSeconds > 0) {
      note('E3 - waiting ' + ttlSeconds + 's to outlast a TTL-bounded dedup cache...');
      await sleep(ttlSeconds * 1000);
      const late = await client.payResource({ url, reuseHeader: header }).catch(() => null);
      const d3 = duplicates([first, late].filter(Boolean));
      ok(!d3.duplicated, 'E3 - retry after ' + ttlSeconds + 's -> ' +
        (d3.duplicated ? 'DUPLICATE SETTLEMENT: dedup is TTL-bounded, not durable' : 'still one transaction'));
    } else {
      note('E3 - TTL-eviction probe not run (pass --ttl-seconds 130 to outlast a 120s cache)');
    }
  }

  // E4 - dedup must not OVER-match. A key that is too coarse silently drops legitimate distinct
  // payments. Refusing everything would pass E1-E3; this control is what makes those results mean
  // something.
  const a = await client.payResource({ url, agentId, secret });
  const b = await client.payResource({ url, agentId, secret });
  if (settledOK(a) && settledOK(b)) {
    ok(txOf(a) !== txOf(b),
      'E4 - two genuinely DIFFERENT payments settle as two transactions (dedup does not over-match)');
  } else {
    note('E4 - inconclusive: the endpoint did not settle two independent payments (budget exhausted?)');
  }

  // E5 - reused payment-identifier carrying a different payload
  if (settledOK(a)) {
    const env = client.b64d(a.header) || {};
    const ext = env.extensions && env.extensions['payment-identifier'];
    const pid = ext && ext.info && ext.info.id;
    if (pid) {
      const conflicting = await client.payResource({ url, agentId, secret, paymentId: pid }).catch(() => null);
      const dup = duplicates([a, conflicting].filter(Boolean));
      ok(!conflicting || !conflicting.ok || !dup.duplicated,
        'E5 - same payment-identifier + DIFFERENT payload -> refused, or no second transaction');
    } else {
      note('E5 - the endpoint did not echo a payment-identifier; idempotency-by-id not asserted');
    }
  } else {
    note('E5 - inconclusive: no baseline settlement');
  }

  // E6 - interleaved duplicates of two distinct payments. Concurrency and distinctness at once: each
  // must settle exactly once, and the two must not collapse into one. Catches a racy dedup and an
  // over-broad one in the same shot.
  if (settledOK(a) && settledOK(b)) {
    const mixed = await Promise.all([
      client.payResource({ url, reuseHeader: a.header }).catch(() => null),
      client.payResource({ url, reuseHeader: b.header }).catch(() => null),
      client.payResource({ url, reuseHeader: a.header }).catch(() => null),
      client.payResource({ url, reuseHeader: b.header }).catch(() => null),
    ]);
    const g1 = duplicates([a, mixed[0], mixed[2]].filter(Boolean));
    const g2 = duplicates([b, mixed[1], mixed[3]].filter(Boolean));
    ok(!g1.duplicated && !g2.duplicated,
      'E6 - interleaved duplicates of TWO payments -> each still exactly one transaction');
    ok(txOf(a) !== txOf(b), 'E6b - the two payments remained distinct under concurrent load');
  } else {
    note('E6 - inconclusive: could not establish two baseline settlements');
  }
}

module.exports = { run, duplicates, txOf };
