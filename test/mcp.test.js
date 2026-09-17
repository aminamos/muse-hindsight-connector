'use strict';

/** Speak JSON-RPC to the real MCP server backed by a stub Hindsight server. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const test = require('node:test');

const { startStub } = require('./stub');

const ROOT = path.join(__dirname, '..');

// Isolate the spawned server from the developer's real ~/.hindsight config.
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-empty-home-'));

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-mcp-repo-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/aminamos/mcp-repo.git\n',
  );
  return root;
}

async function withServer(env, fn) {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.js')], {
    env: { ...process.env, HOME: EMPTY_HOME, USERPROFILE: EMPTY_HOME, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;
  const lines = [];
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    lines.push(msg);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 10000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    await fn(call);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
  }
}

test('mcp: initialize, list, status, recall, retain, reflect', async () => {
  const stub = await startStub();
  try {
    const repo = makeRepo();
    await withServer({ HINDSIGHT_API_URL: stub.url, HINDSIGHT_BANK_ID: '', PWD: repo }, async (call) => {
      // Server resolves the bank from its own cwd; run calls with explicit bank to stay hermetic.
      const bank = 'coding-agent::mcp-repo';
      const init = await call('initialize', { protocolVersion: '2024-11-05' });
      assert.equal(init.result.protocolVersion, '2024-11-05');
      assert.equal(init.result.serverInfo.name, 'hindsight-muse');
      const list = await call('tools/list', {});
      const names = list.result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['hindsight_recall', 'hindsight_reflect', 'hindsight_retain', 'hindsight_status']);
      const recall = await call('tools/call', { name: 'hindsight_recall', arguments: { query: 'deploy steps', bank_id: bank } });
      assert.ok(recall.result.content[0].text.includes(bank));
      assert.ok(recall.result.content[0].text.includes('deploy steps'));
      const retain = await call('tools/call', { name: 'hindsight_retain', arguments: { content: 'mcp test fact', bank_id: bank } });
      assert.ok(retain.result.content[0].text.includes(bank));
      const reflect = await call('tools/call', { name: 'hindsight_reflect', arguments: { query: 'what matters', bank_id: bank } });
      assert.ok(reflect.result.content[0].text.includes('what matters'));
      const unknown = await call('tools/call', { name: 'nope', arguments: {} });
      assert.equal(unknown.error.code, -32602);
    });
  } finally {
    await stub.close();
  }
});

test('mcp: status reports unreachable server instead of crashing', async () => {
  await withServer({ HINDSIGHT_API_URL: 'http://127.0.0.1:1', HINDSIGHT_BANK_ID: 'coding-agent::x' }, async (call) => {
    await call('initialize', { protocolVersion: '2024-11-05' });
    const status = await call('tools/call', { name: 'hindsight_status', arguments: {} });
    assert.ok(status.result.content[0].text.includes('UNREACHABLE') || status.result.content[0].text.includes('unreachable'));
  });
});
