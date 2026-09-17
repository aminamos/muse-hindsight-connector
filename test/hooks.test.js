'use strict';

/** Spawn the real hook scripts against a stub Hindsight server. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startStub } = require('./stub');

const ROOT = path.join(__dirname, '..');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-hook-repo-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/aminamos/hook-repo.git\n',
  );
  return root;
}

// Async spawn: spawnSync would block this process's event loop, starving the
// in-process stub server of the hook's HTTP request.
function runHook(script, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'hooks', script)], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} timed out (stderr: ${stderr})`));
    }, 30000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, `${script} exits 0 (stderr: ${stderr})`);
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('session-start seeds context from stub', async () => {
  const stub = await startStub();
  try {
    const repo = makeRepo();
    const out = await runHook(
      'session-start.js',
      { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: repo },
      { HINDSIGHT_API_URL: stub.url, HINDSIGHT_API_KEY: '' },
    );
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(out.hookSpecificOutput.additionalContext.includes('coding-agent::hook-repo'));
    assert.ok(out.hookSpecificOutput.additionalContext.includes('42 facts'));
    const urls = stub.requests.map((r) => `${r.method} ${r.url}`);
    assert.ok(urls.some((u) => u.startsWith('PUT /v1/default/banks/coding-agent')), 'ensureBank PUT');
    assert.ok(urls.some((u) => u.includes('/memories/recall')), 'seed recall');
  } finally {
    await stub.close();
  }
});

test('user-prompt-submit injects recall hits', async () => {
  const stub = await startStub();
  try {
    const repo = makeRepo();
    const out = await runHook(
      'user-prompt-submit.js',
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-2', cwd: repo, prompt: 'deploy checklist' },
      { HINDSIGHT_API_URL: stub.url },
    );
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(out.hookSpecificOutput.additionalContext.includes('deploy checklist'));
    const recall = stub.requests.find((r) => r.url.includes('/memories/recall'));
    assert.deepEqual(recall.body.tags, ['project:hook-repo', 'harness:muse']);
  } finally {
    await stub.close();
  }
});

test('user-prompt-submit stays silent without a prompt', async () => {
  const stub = await startStub();
  try {
    const out = await runHook(
      'user-prompt-submit.js',
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-3', cwd: makeRepo() },
      { HINDSIGHT_API_URL: stub.url },
    );
    assert.deepEqual(out, {});
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test('stop hook retains new transcript turns incrementally', async () => {
  const stub = await startStub();
  try {
    const repo = makeRepo();
    const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-tr-')), 't.jsonl');
    const sessionId = `stop-test-${Date.now()}`;
    const base = { hook_event_name: 'Stop', session_id: sessionId, cwd: repo, transcript_path: transcript };
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ payload: { event: { prompt: 'first user question about caching' } } })}\n` +
        `${JSON.stringify({ text: 'first assistant answer describing the cache layout' })}\n`,
    );
    const out1 = await runHook('stop.js', base, { HINDSIGHT_API_URL: stub.url });
    assert.deepEqual(out1, {});
    const retains = stub.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/memories'));
    assert.equal(retains.length, 1);
    assert.ok(retains[0].body.items[0].content.includes('caching'));
    assert.deepEqual(retains[0].body.items[0].tags, ['project:hook-repo', 'harness:muse']);
    // Second run with no new bytes retains nothing new.
    const out2 = await runHook('stop.js', base, { HINDSIGHT_API_URL: stub.url });
    assert.deepEqual(out2, {});
    const retains2 = stub.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/memories'));
    assert.equal(retains2.length, 1, 'no duplicate retain without new transcript bytes');
  } finally {
    await stub.close();
  }
});

test('hooks fail open: dead server still exits 0 with {}', async () => {
  const repo = makeRepo();
  const dead = { HINDSIGHT_API_URL: 'http://127.0.0.1:1', HINDSIGHT_API_KEY: '' };
  const out = await runHook(
    'user-prompt-submit.js',
    { hook_event_name: 'UserPromptSubmit', session_id: 'sess-9', cwd: repo, prompt: 'hi' },
    dead,
  );
  assert.deepEqual(out, {});
});
