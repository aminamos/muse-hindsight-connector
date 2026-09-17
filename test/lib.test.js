'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const lib = require('../lib/hindsight');
const { startStub } = require('./stub');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('sanitizeSegment', () => {
  assert.equal(lib.sanitizeSegment('My Repo_2.0'), 'my-repo_2.0');
  assert.equal(lib.sanitizeSegment('  a/b:c  '), 'a-b-c');
  assert.equal(lib.sanitizeSegment(''), 'unknown');
  assert.equal(lib.sanitizeSegment('---'), 'unknown');
  assert.ok(lib.sanitizeSegment('x'.repeat(200)).length <= 80);
});

test('renderBankId', () => {
  assert.equal(
    lib.renderBankId('coding-agent::{gitProject}', { gitProject: 'demo' }),
    'coding-agent::demo',
  );
  assert.equal(
    lib.renderBankId('{harness}::{project}', { harness: 'muse', project: 'p' }),
    'muse::p',
  );
  assert.equal(lib.renderBankId('{missing}', {}), '{missing}');
});

test('gitProjectFromConfigText', () => {
  assert.equal(
    lib.gitProjectFromConfigText('[remote "origin"]\n\turl = https://github.com/aminamos/demo.git\n'),
    'demo',
  );
  assert.equal(
    lib.gitProjectFromConfigText('[remote "origin"]\n\turl = git@github.com:aminamos/demo.git\n'),
    'demo',
  );
  assert.equal(
    lib.gitProjectFromConfigText('[remote "origin"]\n\turl = /srv/repos/demo\n'),
    'demo',
  );
  assert.equal(lib.gitProjectFromConfigText('[core]\n\trepositoryformatversion = 0\n'), null);
});

test('resolveConfig precedence: env > muse.json > adopted > default', () => {
  const home = tmpdir('hindsight-home-');
  const dir = path.join(home, '.hindsight');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'muse.json'),
    JSON.stringify({ apiUrl: 'http://own:8888', apiToken: 'own-tok', bankIdTemplate: 'own::{gitProject}' }),
  );
  fs.writeFileSync(
    path.join(dir, 'claude-code.json'),
    JSON.stringify({ hindsightApiUrl: 'http://adopted:8888', hindsightApiToken: 'adopted-tok' }),
  );
  let c = lib.resolveConfig({ env: {}, home });
  assert.equal(c.apiUrl, 'http://own:8888');
  assert.equal(c.apiToken, 'own-tok');
  assert.equal(c.bankIdTemplate, 'own::{gitProject}');
  c = lib.resolveConfig({ env: { HINDSIGHT_API_URL: 'http://env:8888', HINDSIGHT_API_KEY: 'env-tok' }, home });
  assert.equal(c.apiUrl, 'http://env:8888');
  assert.equal(c.apiToken, 'env-tok');
  fs.rmSync(path.join(dir, 'muse.json'));
  c = lib.resolveConfig({ env: {}, home });
  assert.equal(c.apiUrl, 'http://adopted:8888');
  assert.equal(c.apiToken, 'adopted-tok');
  assert.equal(c.source, 'adopted:claude-code.json');
  fs.rmSync(path.join(dir, 'claude-code.json'));
  c = lib.resolveConfig({ env: {}, home });
  assert.equal(c.apiUrl, 'http://localhost:8888');
  assert.equal(c.apiToken, '');
});

test('detectGitProject + resolveBank', () => {
  const root = tmpdir('hindsight-repo-');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/aminamos/My-Repo.git\n',
  );
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const d = lib.detectGitProject(sub);
  assert.equal(d.project, 'my-repo');
  assert.equal(d.root, root);
  const b = lib.resolveBank(sub);
  assert.equal(b.bankId, 'coding-agent::my-repo');
  assert.deepEqual(b.tags, ['project:my-repo', 'harness:muse']);
  const outside = tmpdir('hindsight-plain-');
  const b2 = lib.resolveBank(outside, '{harness}::{gitProject}');
  assert.ok(b2.bankId.startsWith('muse::'));
});

test('detectGitProject follows .git worktree pointer files', () => {
  const base = tmpdir('hindsight-wt-');
  const gitDir = path.join(base, 'main', '.git');
  fs.mkdirSync(path.join(gitDir, 'worktrees', 'wt1'), { recursive: true });
  fs.writeFileSync(
    path.join(gitDir, 'config'),
    '[remote "origin"]\n\turl = https://github.com/aminamos/wt-repo.git\n',
  );
  const wt = path.join(base, 'wt1');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(gitDir, 'worktrees', 'wt1')}\n`);
  const d = lib.detectGitProject(wt);
  assert.equal(d.project, 'wt-repo');
});

test('resolveConfig tolerates BOM-prefixed muse.json', () => {
  const home = tmpdir('hindsight-bom-');
  const dir = path.join(home, '.hindsight');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'muse.json'),
    '﻿' + JSON.stringify({ apiUrl: 'http://bom:8888', apiToken: 'bom-tok' }), // leading U+FEFF BOM is intentional
  );
  const c = lib.resolveConfig({ env: {}, home });
  assert.equal(c.apiUrl, 'http://bom:8888');
  assert.equal(c.apiToken, 'bom-tok');
});

test('promptFromInput reads candidate fields', () => {
  assert.equal(lib.promptFromInput({ prompt: 'hi' }), 'hi');
  assert.equal(lib.promptFromInput({ user_prompt: 'yo' }), 'yo');
  assert.equal(lib.promptFromInput({ payload: { prompt: 'nested' } }), 'nested');
  assert.equal(lib.promptFromInput({}), '');
  assert.equal(lib.promptFromInput(null), '');
});

test('hookOutput shape', () => {
  assert.deepEqual(lib.hookOutput('SessionStart', ''), {});
  assert.deepEqual(lib.hookOutput('UserPromptSubmit', 'ctx'), {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'ctx' },
  });
});

test('formatRecallContext caps output', () => {
  assert.equal(lib.formatRecallContext([], 'b'), '');
  const out = lib.formatRecallContext(
    [{ type: 'world', text: ' fact one ' }],
    'bank-x',
  );
  assert.ok(out.includes('bank `bank-x`'));
  assert.ok(out.includes('(world) fact one'));
});

test('createClient against stub (auth, recall, retain, reflect, stats, ensure)', async () => {
  const stub = await startStub({ expectedToken: 's3cret' });
  try {
    const client = lib.createClient({ apiUrl: stub.url, apiToken: 's3cret', timeoutMs: 5000 });
    const h = await client.health();
    assert.equal(h.status, 'healthy');
    const rec = await client.recall('coding-agent::demo', 'prefs?', { tags: ['project:demo'], tags_match: 'any' });
    assert.equal(rec.results.length, 2);
    assert.ok(rec.results[0].text.includes('prefs?'));
    const ret = await client.retain('coding-agent::demo', [{ content: 'x' }], { document_tags: ['a'] });
    assert.equal(ret.retained, 1);
    const ref = await client.reflect('coding-agent::demo', 'summarize');
    assert.ok(ref.answer.includes('summarize'));
    const stats = await client.bankStats('coding-agent::demo');
    assert.equal(stats.fact_count, 42);
    const ens = await client.ensureBank('coding-agent::demo');
    assert.equal(ens.bank_id, 'coding-agent::demo');
    const bad = lib.createClient({ apiUrl: stub.url, apiToken: 'wrong', timeoutMs: 5000 });
    await assert.rejects(() => bad.health(), /HTTP 401/);
  } finally {
    await stub.close();
  }
});
