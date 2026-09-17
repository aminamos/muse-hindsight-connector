# muse-hindsight-connector

Native [Muse Code](https://dev.meta.ai/docs/muse-code) plugin for long-term
[Hindsight](https://hindsight.vectorize.io) memory. One bank per repo
(`coding-agent::<project>`), shared across agents — what you tell Muse is there
when you open another Hindsight-wired agent.

Works on **macOS, Linux, and Windows**. Pure Node.js standard library, zero
dependencies, no native modules, no subprocesses.

## What you get

| Capability | How |
|---|---|
| `SessionStart` hook | Ensures the repo bank exists, seeds session context |
| `UserPromptSubmit` hook | Recalls relevant memories into each turn |
| `Stop` hook | Writes new transcript turns back (incremental cursor, no dupes) |
| MCP server `hindsight` | `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`, `hindsight_status` |
| Skill `hindsight` | Companion skill teaching the memory workflow |
| Command `/hindsight-status` | One-shot memory status report |

All hooks fail open: if the server is unreachable they output `{}` and the
session continues untouched.

## Requirements

- Node.js ≥ 18 on `PATH`
- A Hindsight server (local default `http://localhost:8888`, self-hosted, or Cloud)

## Install

```sh
git clone https://github.com/aminamos/muse-hindsight-connector.git
muse plugins install ./muse-hindsight-connector
muse plugins approve hindsight-muse
```

Then point it at your server (or skip this if you already use Hindsight with
Claude Code / Codex — their endpoint is adopted automatically):

```sh
node muse-hindsight-connector/bin/cli.js configure
# or with env vars (sh):
# HINDSIGHT_API_URL=http://localhost:8888 HINDSIGHT_API_KEY=<token>
# PowerShell:
# $env:HINDSIGHT_API_URL='http://localhost:8888'; $env:HINDSIGHT_API_KEY='<token>'
```

Verify:

```sh
node muse-hindsight-connector/bin/cli.js doctor
```

## Configuration

Endpoint precedence:

1. `HINDSIGHT_API_URL` / `HINDSIGHT_API_KEY` env vars
2. `~/.hindsight/muse.json` (`{apiUrl, apiToken, bankIdTemplate}`)
3. Adopted `~/.hindsight/claude-code.json` / `codex.json`
4. Default: `http://localhost:8888`, no token

Optional overrides: `HINDSIGHT_BANK_TEMPLATE` (default
`coding-agent::{gitProject}`), `HINDSIGHT_BANK_ID` (MCP server only).

Bank naming needs no `git` binary: the repo name is read from `.git/config`
purely via the filesystem, falling back to the directory name.

## Tests

```sh
npm test        # hermetic: stub-server unit + hook + MCP + manifest tests
npm run smoke   # live: needs HINDSIGHT_LIVE=1 + HINDSIGHT_SMOKE_BANK=<bank>
```

CI runs `npm test` on ubuntu / windows / macos × node 18 / 20 / 24.

## Hook protocol notes

Muse hooks receive JSON on stdin
(`hook_event_name`, `session_id`, `cwd`, `transcript_path`, …) and inject
context by printing
`{"hookSpecificOutput": {"hookEventName": "<event>", "additionalContext": "…"}}`.
The `UserPromptSubmit` prompt field is read defensively from several candidate
keys. Test one hook directly:

```sh
# sh / bash / zsh:
echo '{"hook_event_name":"UserPromptSubmit","cwd":".","prompt":"hi"}' \
  | node hooks/user-prompt-submit.js
# PowerShell:
# '{"hook_event_name":"UserPromptSubmit","cwd":".","prompt":"hi"}' | node hooks/user-prompt-submit.js
```

## License

MIT
