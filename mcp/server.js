#!/usr/bin/env node
'use strict';

/**
 * Minimal MCP stdio server exposing Hindsight memory as model tools.
 * Zero dependencies: newline-delimited JSON-RPC over stdio.
 *
 * Tools: hindsight_recall, hindsight_retain, hindsight_reflect, hindsight_status
 */

const readline = require('node:readline');

const { resolveConfig, resolveBank, createClient } = require('../lib/hindsight');

const SERVER_INFO = { name: 'hindsight-muse', version: '0.1.0' };

const TOOLS = [
  {
    name: 'hindsight_recall',
    description:
      'Recall long-term memories relevant to a query from the Hindsight bank for the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to remember.' },
        bank_id: { type: 'string', description: 'Override bank id (default: current project bank).' },
        max_tokens: { type: 'number', description: 'Recall budget (default 2048).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'hindsight_retain',
    description:
      'Store a durable fact, preference, or decision in the Hindsight bank for the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact to remember.' },
        context: { type: 'string', description: 'Why / where this was learned.' },
        bank_id: { type: 'string', description: 'Override bank id (default: current project bank).' },
      },
      required: ['content'],
    },
  },
  {
    name: 'hindsight_reflect',
    description:
      'Ask Hindsight to synthesize an answer from the current project bank (world facts, observations, mental models).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question to answer from memory.' },
        bank_id: { type: 'string', description: 'Override bank id (default: current project bank).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'hindsight_status',
    description: 'Check Hindsight server health and the current project bank stats.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

async function main() {
  const cfg = resolveConfig();
  const client = createClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken });
  const bankFor = (override) => {
    if (override) return { bankId: String(override), tags: [] };
    const envBank = (process.env.HINDSIGHT_BANK_ID || '').trim();
    if (envBank) return { bankId: envBank, tags: [] };
    return resolveBank(process.cwd(), cfg.bankIdTemplate);
  };

  async function callTool(name, args = {}) {
    if (name === 'hindsight_recall') {
      const { bankId, tags } = bankFor(args.bank_id);
      const rec = await client.recall(bankId, String(args.query || ''), {
        max_tokens: Number(args.max_tokens) > 0 ? Number(args.max_tokens) : 2048,
        ...(tags.length ? { tags, tags_match: 'any' } : {}),
      });
      const hits = Array.isArray(rec && rec.results) ? rec.results : [];
      const lines = hits.map((r) => `- (${r.type || 'fact'}) ${(r.text || '').replace(/\s+/g, ' ').trim()}`);
      return textResult(
        lines.length ? `bank \`${bankId}\` · ${hits.length} hit(s):\n${lines.join('\n')}` : `bank \`${bankId}\`: no memories matched.`,
      );
    }
    if (name === 'hindsight_retain') {
      const { bankId, tags } = bankFor(args.bank_id);
      await client.ensureBank(bankId);
      const res = await client.retain(
        bankId,
        [
          {
            content: String(args.content || ''),
            context: args.context ? String(args.context) : 'stored via muse mcp tool',
            tags,
            metadata: { harness: 'muse', via: 'mcp' },
          },
        ],
        tags.length ? { document_tags: tags } : {},
      );
      return textResult(`retained in bank \`${bankId}\`: ${JSON.stringify(res).slice(0, 500)}`);
    }
    if (name === 'hindsight_reflect') {
      const { bankId } = bankFor(args.bank_id);
      const res = await client.reflect(bankId, String(args.query || ''));
      const answer =
        res && typeof res.answer === 'string'
          ? res.answer
          : res && typeof res.text === 'string'
            ? res.text
            : JSON.stringify(res).slice(0, 2000);
      return textResult(answer);
    }
    if (name === 'hindsight_status') {
      const { bankId, project } = bankFor(null);
      let health = null;
      let stats = null;
      try {
        health = await client.health();
      } catch (e) {
        return textResult(`hindsight unreachable at ${cfg.apiUrl} (${e.message})`);
      }
      try {
        stats = await client.bankStats(bankId);
      } catch (e) {
        if (e && e.status === 404) stats = { missing: true };
        else throw e;
      }
      return textResult(
        `server: ${cfg.apiUrl} (${(health && health.status) || 'ok'})\n` +
          `project: ${project}\nbank: \`${bankId}\`\n` +
          (stats && stats.missing ? 'bank: not created yet (auto-created on first write)' : `stats: ${JSON.stringify(stats).slice(0, 800)}`),
      );
    }
    throw { code: -32602, message: `unknown tool: ${name}` };
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (msg) => {
    try {
      process.stdout.write(`${JSON.stringify(msg)}\n`);
    } catch {
      /* ignore */
    }
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method && msg.id === undefined) continue; // notification — ack by silence
    const id = msg.id;
    try {
      if (msg.method === 'initialize') {
        const requested =
          msg.params && typeof msg.params.protocolVersion === 'string'
            ? msg.params.protocolVersion
            : '2024-11-05';
        send({ jsonrpc: '2.0', id, result: { protocolVersion: requested, serverInfo: SERVER_INFO, capabilities: { tools: {} } } });
      } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (msg.method === 'tools/call') {
        const result = await callTool(msg.params && msg.params.name, (msg.params && msg.params.arguments) || {});
        send({ jsonrpc: '2.0', id, result });
      } else if (msg.method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      }
    } catch (e) {
      const err =
        e && typeof e.code === 'number'
          ? e
          : { code: -32603, message: (e && e.message) || 'internal error' };
      send({ jsonrpc: '2.0', id, error: err });
    }
  }
}

main().then(
  () => {},
  () => process.exit(0),
);
