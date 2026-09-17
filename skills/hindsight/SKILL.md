---
name: hindsight
description: Long-term Hindsight memory for this project — recall past facts, retain durable ones, and check memory status.
license: MIT
metadata:
  author: aminamos
  version: "0.1.0"
---

# Hindsight Memory

This project uses a Hindsight memory bank (`coding-agent::<project>`, one bank per
repo shared across agents). Three lifecycle hooks run automatically:

- **SessionStart** ensures the bank exists and seeds context.
- **UserPromptSubmit** recalls relevant memories into the turn.
- **Stop** writes new transcript turns back to the bank.

## MCP tools (server `hindsight`)

- `hindsight_recall` — search memory. Args: `query` (required), `bank_id?`, `max_tokens?`.
- `hindsight_retain` — store a durable fact. Args: `content` (required), `context?`, `bank_id?`.
- `hindsight_reflect` — synthesize an answer from the bank. Args: `query` (required), `bank_id?`.
- `hindsight_status` — server health + current bank stats. No args.

## When to write memory

Retain facts the agent could get wrong from general knowledge alone: standing user
preferences, project-specific procedures, why a workaround exists, credentials
locations (never the secrets themselves), and decisions made in-session. Keep
each item to one fact with a short `context` noting where it was learned.

## Manual CLI

`node <plugin>/bin/cli.js doctor` checks node version, server reachability, and
bank stats. `node <plugin>/bin/cli.js configure` writes `~/.hindsight/muse.json`.

Endpoint precedence: `HINDSIGHT_API_URL` / `HINDSIGHT_API_KEY` env vars, then
`~/.hindsight/muse.json`, then adopted `claude-code.json` / `codex.json`, then
`http://localhost:8888` with no token.
