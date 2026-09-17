#!/usr/bin/env node
'use strict';

/**
 * SessionStart hook: ensure the repo's memory bank exists and seed the session
 * with a short memory summary. Silent ({}) when the server is unreachable —
 * hooks must never break a session.
 */

const { resolveConfig, resolveBank, createClient, readHookInput, hookOutput, formatRecallContext } = require('../lib/hindsight');

async function main() {
  const input = await readHookInput();
  const cfg = resolveConfig();
  const cwd = (input && input.cwd) || process.cwd();
  const { bankId, tags } = resolveBank(cwd, cfg.bankIdTemplate);
  const client = createClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken, timeoutMs: 12000 });

  await client.ensureBank(bankId);

  let factCount = null;
  try {
    const stats = await client.bankStats(bankId);
    factCount =
      stats && typeof stats.fact_count === 'number'
        ? stats.fact_count
        : stats && stats.stats && typeof stats.stats.fact_count === 'number'
          ? stats.stats.fact_count
          : null;
  } catch {
    /* stats are best-effort */
  }

  let seed = '';
  try {
    const rec = await client.recall(bankId, 'key project context, preferences, and standing decisions', {
      max_tokens: 1500,
      tags,
      tags_match: 'any',
    });
    seed = formatRecallContext(rec && rec.results, bankId, { maxItems: 6, maxChars: 2500 });
  } catch {
    /* recall is best-effort */
  }

  const header =
    `Hindsight memory connected (bank \`${bankId}\`` +
    `${factCount === null ? '' : `, ${factCount} facts`}).`;
  const context = seed ? `${header}\n${seed}` : factCount ? header : '';
  console.log(JSON.stringify(hookOutput('SessionStart', context)));
}

main().then(
  () => {},
  () => {
    try {
      console.log(JSON.stringify({}));
    } catch {
      /* never fail the session */
    }
  },
);
