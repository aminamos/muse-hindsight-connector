'use strict';

/**
 * muse-hindsight-connector — shared zero-dependency client.
 *
 * Used by the lifecycle hooks, the MCP server, and the CLI. Pure Node.js
 * standard library only: works identically on macOS, Linux, and Windows.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HARNESS = 'muse';
const DEFAULT_API_URL = 'http://localhost:8888';
const DEFAULT_BANK_TEMPLATE = 'coding-agent::{gitProject}';
const DEFAULT_TIMEOUT_MS = 20000;

/** Per-OS home directory. */
function homedir() {
  return os.homedir();
}

/** Shared Hindsight config dir (~/.hindsight on every OS). */
function hindsightDir(home = homedir()) {
  return path.join(home, '.hindsight');
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * Resolve endpoint config. Precedence:
 *   env HINDSIGHT_API_URL / HINDSIGHT_API_KEY
 *   > ~/.hindsight/muse.json {apiUrl, apiToken, bankIdTemplate}
 *   > adopted ~/.hindsight/{claude-code,codex}.json {hindsightApiUrl, hindsightApiToken}
 *   > defaults (local server, no token)
 */
function resolveConfig({ env = process.env, home = homedir() } = {}) {
  const dir = hindsightDir(home);
  const own = readJsonFile(path.join(dir, 'muse.json')) || {};
  let adopted = {};
  let adoptedFrom = null;
  for (const f of ['claude-code.json', 'codex.json']) {
    const c = readJsonFile(path.join(dir, f));
    if (c && (c.hindsightApiUrl || c.hindsightApiToken)) {
      adopted = c;
      adoptedFrom = f;
      break;
    }
  }
  const apiUrl =
    env.HINDSIGHT_API_URL || own.apiUrl || adopted.hindsightApiUrl || DEFAULT_API_URL;
  const apiToken =
    env.HINDSIGHT_API_KEY ||
    env.HINDSIGHT_API_TOKEN ||
    own.apiToken ||
    adopted.hindsightApiToken ||
    '';
  const bankIdTemplate =
    env.HINDSIGHT_BANK_TEMPLATE || own.bankIdTemplate || DEFAULT_BANK_TEMPLATE;
  const source = env.HINDSIGHT_API_URL
    ? 'env:HINDSIGHT_API_URL'
    : own.apiUrl
      ? 'muse.json'
      : adoptedFrom
        ? `adopted:${adoptedFrom}`
        : 'default:localhost';
  return { apiUrl, apiToken, bankIdTemplate, source };
}

/** Make a string safe for bank ids / tags. */
function sanitizeSegment(s) {
  return (
    String(s || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'unknown'
  );
}

/** Extract the repo name from raw .git/config text (origin remote). */
function gitProjectFromConfigText(text) {
  const m = String(text || '').match(/\[remote\s+"origin"\][^\[]*?url\s*=\s*(\S+)/);
  if (!m) return null;
  const url = m[1].trim().replace(/\.git$/, '');
  const seg = url.split(/[/:]/).filter(Boolean).pop();
  return seg || null;
}

/**
 * Walk up from cwd to find the enclosing git checkout. Pure fs, no subprocess,
 * so it works on stock Windows/macOS/Linux. Falls back to the cwd basename.
 */
function detectGitProject(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    const gitPath = path.join(dir, '.git');
    try {
      const st = fs.statSync(gitPath);
      let configPath = null;
      if (st.isDirectory()) {
        configPath = path.join(gitPath, 'config');
      } else if (st.isFile()) {
        // Worktree / submodule / linked checkout: ".git" is a "gitdir: <path>" pointer.
        // The origin remote usually lives in a config up-tree from the pointer
        // (e.g. <main>/.git/config for a linked worktree), so search upward.
        try {
          const pointer = fs.readFileSync(gitPath, 'utf8').match(/^\s*gitdir\s*:\s*(.+?)\s*$/m);
          if (pointer) {
            const target = pointer[1];
            let probe = path.isAbsolute(target) ? target : path.resolve(dir, target);
            for (let level = 0; level < 5; level++) {
              const candidate = path.join(probe, 'config');
              try {
                if (gitProjectFromConfigText(fs.readFileSync(candidate, 'utf8'))) {
                  configPath = candidate;
                  break;
                }
              } catch {
                /* keep climbing */
              }
              const parent = path.dirname(probe);
              if (parent === probe) break;
              probe = parent;
            }
          }
        } catch {
          /* fall through to basename */
        }
      }
      if (configPath) {
        try {
          const proj = gitProjectFromConfigText(fs.readFileSync(configPath, 'utf8'));
          if (proj) return { project: sanitizeSegment(proj), root: dir };
        } catch {
          /* fall through to basename */
        }
      }
      return { project: sanitizeSegment(path.basename(dir)), root: dir };
    } catch {
      /* no .git here — keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const resolved = path.resolve(cwd || process.cwd());
  return { project: sanitizeSegment(path.basename(resolved)), root: resolved };
}

/** Render {placeholders} in a bank id template. */
function renderBankId(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] === undefined ? `{${k}}` : String(vars[k]),
  );
}

/** Resolve {bankId, project, root, tags} for a working directory. */
function resolveBank(cwd, template = DEFAULT_BANK_TEMPLATE) {
  const { project, root } = detectGitProject(cwd);
  const bankId = renderBankId(template, {
    gitProject: project,
    project,
    harness: HARNESS,
  });
  return { bankId, project, root, tags: [`project:${project}`, `harness:${HARNESS}`] };
}

/** Minimal Hindsight REST client (verified against server v0.9.2). */
function createClient({ apiUrl, apiToken, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = String(apiUrl).replace(/\/+$/, '');
  async function req(method, p, body) {
    const res = await fetchImpl(base + p, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`hindsight ${method} ${p}: HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  const enc = encodeURIComponent;
  return {
    health() {
      return req('GET', '/health');
    },
    recall(bankId, query, opts = {}) {
      return req('POST', `/v1/default/banks/${enc(bankId)}/memories/recall`, {
        query,
        max_tokens: 2048,
        ...opts,
      });
    },
    retain(bankId, items, opts = {}) {
      return req('POST', `/v1/default/banks/${enc(bankId)}/memories`, {
        items,
        ...opts,
      });
    },
    reflect(bankId, query, opts = {}) {
      return req('POST', `/v1/default/banks/${enc(bankId)}/reflect`, {
        query,
        max_tokens: 1024,
        ...opts,
      });
    },
    bankStats(bankId) {
      return req('GET', `/v1/default/banks/${enc(bankId)}/stats`);
    },
    ensureBank(bankId) {
      return req('PUT', `/v1/default/banks/${enc(bankId)}`, {});
    },
  };
}

/** Read hook input: --fixture <path> / positional file, else stdin JSON. */
function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function readHookInput(argv = process.argv) {
  const args = argv.slice(2);
  let fixture = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fixture' && args[i + 1]) {
      fixture = args[i + 1];
      i++;
    } else if (!args[i].startsWith('-') && fixture === null) {
      fixture = args[i];
    }
  }
  if (fixture) {
    try {
      return JSON.parse(fs.readFileSync(fixture, 'utf8'));
    } catch {
      return {};
    }
  }
  const raw = await readStdin();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Build context-injection output, or {} to stay silent. */
function hookOutput(event, additionalContext) {
  if (!additionalContext || !String(additionalContext).trim()) return {};
  return { hookSpecificOutput: { hookEventName: event, additionalContext } };
}

/** Extract the user prompt from a UserPromptSubmit payload (defensive). */
function promptFromInput(input) {
  const obj = input && typeof input === 'object' ? input : {};
  for (const k of ['prompt', 'user_prompt', 'message', 'text', 'input']) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k];
  }
  const payload = obj.payload;
  if (payload && typeof payload === 'object') {
    for (const k of ['prompt', 'user_prompt', 'message', 'text']) {
      if (typeof payload[k] === 'string' && payload[k].trim()) return payload[k];
    }
  }
  return '';
}

/** Format recall hits as injected context. Caps count and length. */
function formatRecallContext(results, bankId, { maxItems = 8, maxChars = 4000 } = {}) {
  const hits = Array.isArray(results) ? results.slice(0, maxItems) : [];
  if (hits.length === 0) return '';
  const lines = hits.map((r) => {
    const type = r && r.type ? `(${r.type}) ` : '';
    const text = r && typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim() : '';
    return `- ${type}${text}`.slice(0, 600);
  });
  let out = `[hindsight memory · bank \`${bankId}\`]\n${lines.join('\n')}`;
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 20)}\n…(truncated)`;
  return out;
}

module.exports = {
  HARNESS,
  DEFAULT_API_URL,
  DEFAULT_BANK_TEMPLATE,
  DEFAULT_TIMEOUT_MS,
  homedir,
  hindsightDir,
  resolveConfig,
  sanitizeSegment,
  gitProjectFromConfigText,
  detectGitProject,
  renderBankId,
  resolveBank,
  createClient,
  readHookInput,
  hookOutput,
  promptFromInput,
  formatRecallContext,
};
