#!/usr/bin/env node
'use strict';

/**
 * Stop hook: append new transcript turns to the repo's memory bank (write-back).
 * Incremental via a byte-offset cursor per session in the OS temp dir, so each
 * Stop only retains what it has not seen. Always outputs {} — write-back is
 * observational and must never disturb the session.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveConfig, resolveBank, createClient, readHookInput } = require('../lib/hindsight');

const MAX_TAIL_LINES = 60;
const MAX_ITEM_CHARS = 6000;

function stateDir() {
  const dir = path.join(os.tmpdir(), 'muse-hindsight');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  return dir;
}

function cursorPath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(stateDir(), `sess-${safe}.cursor`);
}

function readCursor(sessionId) {
  try {
    return parseInt(fs.readFileSync(cursorPath(sessionId), 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}

function writeCursor(sessionId, offset) {
  try {
    fs.writeFileSync(cursorPath(sessionId), String(offset));
  } catch {
    /* best-effort */
  }
}

/** Pull human/model text out of one transcript line (defensive: format-agnostic). */
function textFromLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const pick = (o) => {
    if (!o || typeof o !== 'object') return null;
    for (const k of ['text', 'prompt', 'message', 'content', 'last_assistant_message']) {
      if (typeof o[k] === 'string' && o[k].trim()) return o[k];
    }
    return null;
  };
  return (
    pick(obj) ||
    pick(obj.payload) ||
    (obj.payload && pick(obj.payload.event)) ||
    pick(obj.event) ||
    null
  );
}

/** Read bytes appended since the cursor, capped to the tail. */
function readNewTranscriptText(transcriptPath, fromOffset) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return { text: '', offset: fromOffset };
  }
  const start = Math.max(0, Math.min(fromOffset, stat.size));
  const maxBytes = 65536;
  const readStart = Math.max(start, stat.size - maxBytes);
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const len = stat.size - readStart;
    const buf = Buffer.alloc(Math.max(0, len));
    fs.readSync(fd, buf, 0, len, readStart);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    const tail = lines.slice(-MAX_TAIL_LINES);
    const texts = [];
    for (const line of tail) {
      const t = textFromLine(line);
      if (t) texts.push(t.replace(/\s+/g, ' ').trim().slice(0, 1500));
    }
    return { text: texts.join('\n').slice(0, MAX_ITEM_CHARS), offset: stat.size };
  } catch {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    return { text: '', offset: stat.size };
  }
}

async function main() {
  const input = await readHookInput();
  const transcriptPath = input && input.transcript_path;
  const sessionId = (input && (input.session_id || input.sessionId)) || 'default';
  const cwd = (input && input.cwd) || process.cwd();
  if (!transcriptPath) {
    console.log(JSON.stringify({}));
    return;
  }
  const cfg = resolveConfig();
  const { bankId, tags, project } = resolveBank(cwd, cfg.bankIdTemplate);
  const client = createClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken, timeoutMs: 15000 });

  const from = readCursor(sessionId);
  const { text, offset } = readNewTranscriptText(transcriptPath, from);
  writeCursor(sessionId, offset);
  if (!text || text.length < 20) {
    console.log(JSON.stringify({}));
    return;
  }
  await client.ensureBank(bankId);
  await client.retain(
    bankId,
    [
      {
        content: text,
        context: `muse session ${sessionId} in project ${project}`,
        tags,
        metadata: { session_id: String(sessionId), harness: 'muse' },
      },
    ],
    { document_tags: tags },
  );
  console.log(JSON.stringify({}));
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
