# omp-multi-harness

An [OMP](https://github.com/can1357/oh-my-pi) extension that turns OMP into a **supervisor**
delegating work to two coding agents you already have:

- **Codex CLI** — `codex`
- **Claude Code CLI** — `claude`

It drives their real binaries through their real non-interactive entry points, using the
logins you already did. **No API keys. No token extraction. No reimplementation of either
agent.**

```text
                  OMP  (supervisor)
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   ask_codex       ask_claude       /sessions
        │               │           (watch, switch,
        ▼               ▼            cancel runs)
    codex CLI       claude CLI
        │               │
  your Codex      your Claude
    login            login
```

> **Status — Phases 0–3 of 6.** Delegation works: `ask_codex`, `ask_claude`, `/codex`,
> `/claude`, plus `/agents`, `/agents auth`, `/harness-setup`. Claude delegation is verified
> end-to-end against the real CLI; Codex passes its fake-CLI suite but could not be verified
> live because that account is out of credits. Parallel runs and `/sessions` land in Phase 4.
> Progress: [`_plan/PROGRESS.md`](_plan/PROGRESS.md).

---

## Setup

### 1. Install the three CLIs

| | install | check |
|---|---|---|
| OMP | `bun add -g @oh-my-pi/pi-coding-agent` | `omp --version` |
| Codex | `brew install --cask codex` · `npm i -g @openai/codex` | `codex --version` |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude --version` |

OMP loads extensions with [Bun](https://bun.sh), so Bun is required
(`curl -fsSL https://bun.sh/install | bash`).

### 2. Log in to each — three separate, non-transferable logins

```bash
omp                  # then /login   — OMP's own model (supervisor turns + auto routing)
codex login          #               — everything ask_codex does
claude auth login    #               — everything ask_claude does
```

This is not redundancy. Claude Code will not accept credentials supplied by another tool,
so each CLI keeps its own login and this extension never touches any of them — it only
reads `codex login status` and `claude auth status`, which print no secrets.

If OMP itself is not logged in, delegation still works; only OMP's own turns and
model-based `auto` routing are affected (routing falls back to rules).

### 3. Install the extension

```bash
git clone <this-repo> omp-multi-harness
cd omp-multi-harness
bun install
```

Then pick one:

```bash
# A. Globally, for every project (recommended)
ln -s "$PWD" ~/.omp/agent/extensions/multi-harness

# B. Just this project
mkdir -p /path/to/project/.omp/extensions
ln -s "$PWD" /path/to/project/.omp/extensions/multi-harness

# C. No install at all — load it per run
omp -e /path/to/omp-multi-harness/src/index.ts
```

Using `--profile`? The path becomes `~/.omp/profiles/<name>/agent/extensions/`. The
extension resolves this at runtime, and honors `PI_CODING_AGENT_DIR`.

### 4. Verify

```bash
bun run doctor     # 14 checks: tools, all three logins, router model, install, config
```

```text
Codex
  ✔ Codex CLI                    codex-cli 0.155.0 (/opt/homebrew/bin/codex)
  ✔ Codex authentication         Logged in using ChatGPT
```

`bun scripts/setup.ts fix` applies the safe repairs (symlink, config block, dependencies).
Installs and logins are printed for you to run — never executed automatically.

Inside OMP, `/agents` and `/harness-setup` report the same thing.

### 5. Configure (optional — the defaults are sensible)

Add to `~/.omp/agent/config.yml`, or `<project>/.omp/config.yml` to override per project:

```yaml
multiHarness:
  enabled: true

  codex:
    enabled: true
    model: null          # null → your ~/.codex/config.toml decides
    timeoutMs: 1800000

  claude:
    enabled: true
    model: null          # null → your Claude Code config decides
    acceptEdits: false

  routing:
    mode: model          # model | rules — how `auto` picks an agent
    model: "@smol"       # router model: role alias, provider/id, or bare id
    modeMap:
      plan: claude
      review: claude
      implement: codex
      debug: codex

  concurrency:
    maxConcurrentRuns: 4
    allowParallelWrites: false   # two agents never write one tree at once

  debug: false
```

Every option: [`_spec/09-config.md`](_spec/09-config.md).

---

## Usage

Flags for `/codex` and `/claude`: `--read-only`, `--new`, `--mode <mode>`, `--model <id>`.

### Commands

| command | status | what it does |
|---|---|---|
| `/agents` | ✅ | Availability, version, auth, and readiness for both agents |
| `/agents auth [codex\|claude]` | ✅ | Auth status plus the exact login command |
| `/harness-setup` | ✅ | The setup checklist, inside a session |
| `/codex <task>` | ✅ | Delegate straight to Codex |
| `/claude <task>` | ✅ | Delegate straight to Claude Code |
| `/sessions` | Phase 4 | List, watch, switch between, and cancel running delegations |

### Tools the supervisor calls on its own

| tool | status | typical use |
|---|---|---|
| `ask_codex` | ✅ | implementation, debugging, refactors, tests |
| `ask_claude` | ✅ | architecture, planning, design review, second opinions |
| `delegate` | Phase 5 | `agent: "auto"` routing |
| `agent_runs` | Phase 5 | fan several runs out, then join them |

### Model selection

Three independent choices:

- **Worker models** stay yours. Set nothing and no `-m`/`--model` is passed at all — each
  CLI's own config decides. Override per agent (`codex.model`) or per call (`--model`).
- **Router model** (`routing.model`, default `@smol`) resolves `agent: "auto"` with one
  small classification call. Any failure falls back to the rule table, so it can never
  block a delegation. `routing.mode: rules` turns it off entirely.

---

## Troubleshooting

| symptom | cause and fix |
|---|---|
| `/agents` says *not authenticated* for Codex | `codex login`. (Note `codex login status` prints to stderr — tools that read only stdout get this wrong.) |
| `/agents` says *not authenticated* for Claude | `claude auth login` |
| `auto` always picks by rules | OMP has no authenticated model — `omp` → `/login`, or set `routing.model` |
| `unavailable — \`codex\` not found on PATH` | install it, or set `multiHarness.codex.executable` to the full path |
| `PROVIDER_LIMIT: … out of credits` | the provider account, not the task — top up or switch accounts. Retrying will not help. |
| doctor shows *repo-local copy shadowing your global omp* | harmless: `bun run` puts `node_modules/.bin` first, and the dev dependency ships an `omp` |
| Extension not loading | confirm the symlink target, or run `omp -e ./src/index.ts` directly |

---

## Security posture

- Never reads OAuth or token files; auth state comes only from each CLI's own status command.
- Never prints credentials. `claude auth status --json` returns your email and org — only
  `loggedIn` and `authMethod` are read.
- Never forwards one provider's credentials to the other.
- No `shell: true`, ever. Arguments are arrays; prompts go over **stdin**, so task text
  never lands in `ps` or shell history.
- Permission-bypass flags (`--dangerously-bypass-approvals-and-sandbox`,
  `--dangerously-skip-permissions`) are never passed, and no config option enables them.
- Working directories are realpath-validated; a run cannot silently target another repo.
- Two write-capable agents never touch the same working tree at once.

Details: [`_spec/10-errors-and-security.md`](_spec/10-errors-and-security.md).

---

## Development

```bash
bun install
bun test           # 110 tests, no live provider calls
MULTI_HARNESS_LIVE_TESTS=1 bun test test/live.test.ts   # opt-in, calls the real CLIs
bun run typecheck
bun run dev        # omp --no-extensions -e ./src/index.ts
bun run doctor
```

VS Code config ships in `.vscode/` (tasks for doctor/typecheck/test, launch configs, and
recommended extensions).

- [`_spec/`](_spec/README.md) — the normative specification, 15 documents
- [`_plan/`](_plan/README.md) — phased plan, decision log, and the task tracker

Built and verified against `omp 18.2.6` · `codex-cli 0.155.0` · `claude 2.1.274` · `bun 1.4.2`
([`_spec/01-environment-findings.md`](_spec/01-environment-findings.md)).
