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

> **Status — Phases 0–5 of 6 complete, Phase 6 substantially done.** Everything in the
> tables below is implemented: delegation, routing, parallel runs, `/sessions`, session
> continuation, and the background (`--bg`) path. Claude delegation is verified end-to-end
> against the real CLI; **Codex passes its fake-CLI suite but has never been verified live**,
> because that account is out of credits — treat it as unproven against the real binary.
> Model-based `auto` routing is likewise unverified live: OMP itself has no authenticated
> model here, so it silently falls back to the rule table (which is tested).
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

OMP discovers extensions from its **agent dir** (`<agentDir>/extensions/`) and from a
project's `.omp/extensions/`, resolving each directory through that directory's
`package.json` → `omp.extensions`. It does **not** scan `node_modules`. So installing from
npm is two steps: install the package, then register it. The bundled CLI does step two.

#### From npm — global, for every project (recommended)

```bash
npm install -g omp-multi-harness
omp-multi-harness link
```

`link` symlinks the installed package into `<agentDir>/extensions/multi-harness`. It only
ever manages its own symlink: it refuses to replace anything that is not a symlink it
created, and it never edits your OMP config, logs you in, or installs a CLI.

#### From npm — one project only

```bash
npm install --save-dev omp-multi-harness
npx omp-multi-harness link --project
```

That links into `./.omp/extensions/multi-harness`, so the extension loads for this
repository and nowhere else.

#### Using a profile

```bash
omp-multi-harness link --profile work      # ~/.omp/profiles/work/agent/extensions/
```

`PI_CODING_AGENT_DIR` overrides both the default and `--profile`, and is honored by the CLI
and by the extension at runtime — nothing hard-codes `~/.omp/agent`.

#### Check, and undo

```bash
omp-multi-harness status     # where it is linked, globally and for this project
omp-multi-harness unlink     # remove the symlink (add --project for the project one)
omp-multi-harness doctor     # the full setup check
```

#### From source

```bash
git clone https://github.com/abdevts/omp-multi-harness.git
cd omp-multi-harness
bun install
bun scripts/cli.ts link          # same linking, straight from the checkout
```

Or skip installation entirely and load it per run:

```bash
omp -e /path/to/omp-multi-harness/src/index.ts
```

> **No build step.** OMP loads TypeScript directly, so the package ships its sources and
> `omp.extensions` points at `./src/index.ts`. There is nothing to compile.

### Using it from VS Code

The extension lives inside `omp`, not inside VS Code — so "using it in VS Code" means
running `omp` in VS Code's integrated terminal with the extension registered. Once
`omp-multi-harness link` has been run, every terminal session picks it up automatically.

This repository ships `.vscode/` with the loop already wired:

| file | what it gives you |
|---|---|
| `tasks.json` | **Terminal → Run Task** for `doctor`, `test`, and `typecheck` |
| `launch.json` | debug `omp` with the extension loaded via `-e` |
| `settings.json` | formatting and TypeScript settings matching this codebase |
| `extensions.json` | the editor extensions this project expects |

For a project that merely *consumes* the package, you do not need any of that — install,
link, and open a terminal:

```bash
npm install --save-dev omp-multi-harness
npx omp-multi-harness link --project
omp                    # in VS Code's integrated terminal
```

Then `/agents` inside OMP confirms it loaded. If you keep a workspace-local agent dir, set
`PI_CODING_AGENT_DIR` in VS Code's terminal environment (`terminal.integrated.env.osx`,
`.linux`, or `.windows`) and both the CLI and the extension will follow it.

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

Flags for `/codex` and `/claude`: `--read-only`, `--write`, `--new`, `--bg`,
`--mode <mode>`, `--model <id>`.

`--bg` returns a run id immediately and keeps working in the background; track it with
`/sessions`. Many runs can be alive at once — see [Parallel runs](#parallel-runs).

### Commands

| command | status | what it does |
|---|---|---|
| `/agents` | ✅ | Availability, version, auth, and readiness for both agents |
| `/agents auth [codex\|claude]` | ✅ | Auth status plus the exact login command |
| `/harness-setup` | ✅ | The setup checklist, inside a session |
| `/codex <task>` | ✅ | Delegate straight to Codex |
| `/claude <task>` | ✅ | Delegate straight to Claude Code |
| `/sessions` | ✅ | List, watch, switch focus between, and cancel running delegations |

### Tools the supervisor calls on its own

| tool | status | typical use |
|---|---|---|
| `ask_codex` | ✅ | implementation, debugging, refactors, tests |
| `ask_claude` | ✅ | architecture, planning, design review, second opinions |
| `delegate` | ✅ | `agent: "auto"` routing |
| `agent_runs` | ✅ | fan several runs out, then join them |

### Parallel runs

Every delegation — whether from a slash command or a tool — becomes a *run* in a
session-scoped registry. Runs execute concurrently; `/sessions` is the view over them.

```text
/claude --bg review the auth architecture
/codex  --bg --read-only summarize the test suite
/sessions                      # both listed, elapsed ticking
/sessions attach r7c1          # stream that run's output into the widget
/sessions cancel r7c2          # stops just that run
```

Attaching changes only what you are shown. It never pauses, throttles, or reorders a run —
unfocused runs keep executing and keep filling their own output buffers.

What may run at once:

| situation | parallel? |
|---|---|
| N read-only runs, same repo | yes |
| read-only + writer, same repo | yes — the reader may observe a moving tree, and the result says so |
| two writers, same repo | no — serialized by a FIFO workspace write lock |
| two writers, different repos | yes |

`concurrency.maxConcurrentRuns` (default 4) caps live child processes; the rest wait in
`queued`. Quitting OMP cancels every live run and waits for it to die — no child or
grandchild outlives the session.

> `/sessions` covers **delegated runs only**. OMP's own `/resume` already lists and switches
> OMP sessions, including `/resume @claude` and `/resume @codex` to import a worker session,
> so this extension does not duplicate it.

### Session continuation

Each `(OMP session, repo)` pair remembers the worker session it was talking to, so a second
`/codex` continues the first one's thread rather than starting cold. `--new` forces a fresh
one. If a resume fails, the run retries **once** with a compact handoff summary rather than
replaying history, and says so in the result. Two parallel runs against the same agent and
repo cannot share one worker session: the second forks (Claude) or starts fresh (Codex).

The mapping holds ids, paths, and timestamps only — never task text, tokens, or
environment — in `0600` files under a `0700` directory in the active agent dir (honoring
`--profile` and `PI_CODING_AGENT_DIR`).

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
- `readOnlyEnforced` reports what the adapter's **argv actually enforced**, not what the
  caller requested. An adapter that cannot prove enforcement reports `false`.
- Every CLI-derived string embedded in an error is redacted first (API keys, tokens, JWTs,
  PEM blocks, `KEY=value` assignments), so a credential a worker echoes back cannot reach
  an error message or a log. Environment views are allowlist-based — a denylist fails open.

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
