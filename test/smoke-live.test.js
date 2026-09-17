'use strict';

/**
 * Live smoke test against a real Hindsight server. Opt-in only:
 *   HINDSIGHT_LIVE=1 HINDSIGHT_SMOKE_BANK=<bank> npm run smoke
 * Optional write path (uses a dedicated bank, never the shared one):
 *   HINDSIGHT_SMOKE_RETAIN=1 HINDSIGHT_SMOKE_RETAIN_BANK=muse-connector-smoke
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const lib = require('../lib/hindsight');

const LIVE = process.env.HINDSIGHT_LIVE === '1';

test('live: recall returns results from a real bank', { skip: !LIVE && 'set HINDSIGHT_LIVE=1 to run' }, async () => {
  const bank = process.env.HINDSIGHT_SMOKE_BANK;
  assert.ok(bank, 'HINDSIGHT_SMOKE_BANK must be set');
  const cfg = lib.resolveConfig();
  const client = lib.createClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken, timeoutMs: 20000 });
  const rec = await client.recall(bank, 'project preferences and standing decisions');
  assert.ok(Array.isArray(rec.results), 'results array');
  console.log(`live recall on \`${bank}\`: ${rec.results.length} hit(s)`);
});

test('live: retain round-trips to a dedicated smoke bank', { skip: !(LIVE && process.env.HINDSIGHT_SMOKE_RETAIN === '1') && 'set HINDSIGHT_SMOKE_RETAIN=1 to run' }, async () => {
  const bank = process.env.HINDSIGHT_SMOKE_RETAIN_BANK || 'muse-connector-smoke';
  const cfg = lib.resolveConfig();
  const client = lib.createClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken, timeoutMs: 20000 });
  await client.ensureBank(bank);
  const marker = `smoke-marker-${Date.now()}`;
  await client.retain(
    bank,
    [
      {
        content: `Muse connector smoke test ${marker}: the smoke project prefers terse output.`,
        tags: ['smoke'],
        metadata: { harness: 'muse' },
      },
    ],
  );
  // Fact extraction/indexing is async server-side: poll until the fact is visible.
  let found = false;
  for (let i = 0; i < 18 && !found; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const rec = await client.recall(bank, 'what does the smoke project prefer');
    assert.ok(Array.isArray(rec.results), 'results array');
    found = rec.results.some((r) => typeof r.text === 'string' && r.text.includes('terse'));
  }
  assert.ok(found, `retained fact visible in recall within 90s (marker ${marker})`);
  console.log(`live retain+recall on \`${bank}\`: ok (fact visible)`);
});
