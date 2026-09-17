#!/usr/bin/env node
'use strict';

/**
 * Manual helper CLI. node bin/cli.js <doctor|configure|recall|retain> [args]
 * Cross-platform: pure Node.js, no prompts library (uses readline).
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const lib = require('../lib/hindsight');

function usage(exit = 0) {
  console.log(
    [
      'usage: node bin/cli.js <command>',
      '',
      '  doctor              check node, server reachability, and current bank',
      '  configure           write ~/.hindsight/muse.json (apiUrl, apiToken, bankIdTemplate)',
      '  recall <query>      recall memories for the current project bank',
      '  retain <content>    retain one fact for the current project bank',
    ].join('\n'),
  );
  process.exit(exit);
}

async function doctor() {
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
  console.log(`node: ${process.version} ${nodeOk ? 'OK (>=18)' : 'TOO OLD — need >=18'}`);
  const cfg = lib.resolveConfig();
  console.log(`endpoint: ${cfg.apiUrl} (source: ${cfg.source})`);
  console.log(`auth: ${cfg.apiToken ? 'token set' : 'no token'}`);
  const { bankId, project } = lib.resolveBank(process.cwd(), cfg.bankIdTemplate);
  console.log(`project: ${project}\nbank: ${bankId}`);
  const client = lib.createClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken, timeoutMs: 10000 });
  try {
    const h = await client.health();
    console.log(`server: healthy (${JSON.stringify(h).slice(0, 200)})`);
  } catch (e) {
    console.log(`server: UNREACHABLE (${e.message})`);
    process.exitCode = 1;
    return;
  }
  try {
    const s = await client.bankStats(bankId);
    console.log(`bank stats: ${JSON.stringify(s).slice(0, 500)}`);
  } catch (e) {
    if (e && e.status === 404) console.log('bank: not created yet (auto-created on first write)');
    else console.log(`bank stats: error (${e.message})`);
  }
}

function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

async function configure() {
  const cfg = lib.resolveConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const apiUrl = (await ask(rl, `apiUrl [${cfg.apiUrl}]: `)) || cfg.apiUrl;
  const apiToken = (await ask(rl, 'apiToken [keep current]: ')) || cfg.apiToken;
  const bankIdTemplate =
    (await ask(rl, `bankIdTemplate [${cfg.bankIdTemplate}]: `)) || cfg.bankIdTemplate;
  rl.close();
  const dir = lib.hindsightDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'muse.json');
  fs.writeFileSync(p, `${JSON.stringify({ apiUrl, apiToken, bankIdTemplate }, null, 2)}\n`);
  console.log(`wrote ${p}`);
}

async function recall(query) {
  if (!query) usage(2);
  const cfg = lib.resolveConfig();
  const { bankId, tags } = lib.resolveBank(process.cwd(), cfg.bankIdTemplate);
  const client = lib.createClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken });
  const rec = await client.recall(bankId, query, { tags, tags_match: 'any' });
  console.log(lib.formatRecallContext(rec && rec.results, bankId, { maxItems: 20, maxChars: 8000 }) || '(no hits)');
}

async function retain(content) {
  if (!content) usage(2);
  const cfg = lib.resolveConfig();
  const { bankId, tags } = lib.resolveBank(process.cwd(), cfg.bankIdTemplate);
  const client = lib.createClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken });
  await client.ensureBank(bankId);
  const res = await client.retain(
    bankId,
    [{ content, context: 'stored via muse-hindsight cli', tags, metadata: { harness: 'muse', via: 'cli' } }],
    { document_tags: tags },
  );
  console.log(`retained in \`${bankId}\`: ${JSON.stringify(res).slice(0, 500)}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage(0);
  if (cmd === 'doctor') return doctor();
  if (cmd === 'configure') return configure();
  if (cmd === 'recall') return recall(rest.join(' '));
  if (cmd === 'retain') return retain(rest.join(' '));
  usage(2);
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
