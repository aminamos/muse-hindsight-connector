'use strict';

/** Self-check: plugin manifest follows the native Muse plugin contract. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const RESERVED = ['loop', 'muse-core', 'tbh-reminders', 'herdr', 'threejs'];
const WIN_RESERVED = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];

function portableId(id) {
  return ID_RE.test(id) && !WIN_RESERVED.includes(id.split('.')[0].toUpperCase());
}

test('manifest base shape', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.muse-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(portableId(manifest.name), 'portable plugin id');
  assert.ok(!RESERVED.includes(manifest.name), 'not a reserved id');
  assert.deepEqual(manifest.compat, { source: 'native', manifestDir: '.muse-plugin' });
  const fams = Object.keys(manifest.capabilities).sort();
  assert.deepEqual(fams, ['commands', 'hooks', 'mcpServers', 'reminders', 'skills']);
});

function assertManifestPath(p) {
  assert.ok(p && !p.includes('\\'), `forward slashes: ${p}`);
  assert.ok(!path.isAbsolute(p), `relative: ${p}`);
  assert.ok(!p.split('/').includes('..'), `no traversal: ${p}`);
  const full = path.join(ROOT, p);
  assert.ok(fs.statSync(full).isFile(), `exists: ${p}`);
}

test('hooks: events, argv, unique sources', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.muse-plugin', 'plugin.json'), 'utf8'));
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreLLMCall', 'PostLLMCall', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd'];
  const seen = new Set();
  assert.ok(manifest.capabilities.hooks.length >= 1);
  for (const h of manifest.capabilities.hooks) {
    assert.ok(portableId(h.id), `hook id: ${h.id}`);
    assert.ok(events.includes(h.event), `event: ${h.event}`);
    assert.ok(Array.isArray(h.command) && h.command.length >= 2, 'structured argv');
    for (const arg of h.command.slice(1)) {
      if (!arg.startsWith('-') && (arg.endsWith('.js') || arg.includes('/'))) {
        assertManifestPath(arg);
        assert.ok(!seen.has(arg), `hook source shared: ${arg}`);
        seen.add(arg);
      }
    }
  }
});

test('mcpServers: stdio entries with existing sources', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.muse-plugin', 'plugin.json'), 'utf8'));
  for (const s of manifest.capabilities.mcpServers) {
    assert.ok(portableId(s.id), `mcp id: ${s.id}`);
    if ((s.transport || 'stdio') === 'stdio') {
      assert.ok(Array.isArray(s.command) && s.command.length >= 2);
      for (const arg of s.command.slice(1)) {
        if (!arg.startsWith('-') && (arg.endsWith('.js') || arg.includes('/'))) assertManifestPath(arg);
      }
    } else {
      assert.ok(s.url, 'http transport needs url');
    }
  }
});

test('skills: SKILL.md with name + description frontmatter', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.muse-plugin', 'plugin.json'), 'utf8'));
  for (const s of manifest.capabilities.skills) {
    assert.ok(portableId(s.id), `skill id: ${s.id}`);
    assertManifestPath(s.path);
    const body = fs.readFileSync(path.join(ROOT, s.path), 'utf8');
    const m = body.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, 'frontmatter block');
    assert.ok(/^name:\s*\S+/m.test(m[1]), 'frontmatter name');
    assert.ok(/^description:\s*\S+/m.test(m[1]), 'frontmatter description');
  }
});

test('commands: markdown templates exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.muse-plugin', 'plugin.json'), 'utf8'));
  for (const c of manifest.capabilities.commands) {
    assert.ok(portableId(c.id), `command id: ${c.id}`);
    assertManifestPath(c.path);
  }
});
