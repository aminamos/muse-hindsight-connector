#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit hook: recall memories relevant to the user's prompt and
 * inject them as additional context. Silent ({}) on any failure.
 */

const { resolveConfig, resolveBank, createClient, readHookInput, hookOutput, promptFromInput, formatRecallContext } = require('../lib/hindsight');

async function main() {
  const input = await readHookInput();
  const prompt = promptFromInput(input).slice(0, 2000);
  if (!prompt) {
    console.log(JSON.stringify({}));
    return;
  }
  const cfg = resolveConfig();
  const cwd = (input && input.cwd) || process.cwd();
  const { bankId, tags } = resolveBank(cwd, cfg.bankIdTemplate);
  const client = createClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken, timeoutMs: 10000 });

  const rec = await client.recall(bankId, prompt, { max_tokens: 2048, tags, tags_match: 'any' });
  const context = formatRecallContext(rec && rec.results, bankId);
  console.log(JSON.stringify(hookOutput('UserPromptSubmit', context)));
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
