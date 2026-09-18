# 14 — Setup, Toolchain, Install, Auth

Every step needed to go from a bare machine to a working supervisor. Implemented by
`scripts/setup.ts` (`bun run doctor` / `bun run setup fix`) and surfaced inside OMP by
`/harness-setup`.

## Principles

1. **Check everything, fix only what is safe.** Creating directories, symlinks, config
   blocks, and running `bun install` are automatic (after a prompt). Installing software
   and logging in are **never** automated — the command is printed for the user to run.
2. **Auth state comes only from each CLI's own status command.** No credential file is ever
   read, no token is ever printed, and no login is ever performed on the user's behalf.
3. **Every failing check names its exact fix**, as a copy-pasteable command.

## Prerequisites

| tool | why | check | install |
|---|---|---|---|
| Bun ≥ 1.4 | OMP loads extensions with Bun | `bun --version` | `curl -fsSL https://bun.sh/install \| bash` |
| Git | repo + worktree features | `git --version` | platform package manager |
| OMP 18.x | the host | `omp --version` | `bun add -g @oh-my-pi/pi-coding-agent` |
| Codex CLI | worker | `codex --version` | `brew install --cask codex` (macOS) / `npm i -g @openai/codex` |
| Claude Code | worker | `claude --version` | `npm i -g @anthropic-ai/claude-code` |

Node is not required by the extension; OMP and the CLIs bring their own runtimes.

## Setup steps (the doctor's checklist)

| # | step | ok when | auto-fix |
|---|---|---|---|
| 1 | Bun runtime | `bun` on PATH | no (install) |
| 2 | Git repository | repo initialized | yes (`git init`) |
| 3 | Project dependencies | `node_modules/` present | yes (`bun install`) |
| 4 | OMP CLI | `omp` on PATH | no (install) |
| 5 | OMP agent directory | `<agentDir>` exists | no (run `omp` once) |
| 6 | OMP provider auth | `omp models ls --json` returns ≥ 1 model | no (`omp` → `/login`) |
| 7 | Codex CLI | `codex` on PATH | no (install) |
| 8 | **Codex auth** | `codex login status` reports logged in | no (`codex login`) |
| 9 | Claude Code CLI | `claude` on PATH | no (install) |
| 10 | **Claude auth** | `claude auth status --json` → `loggedIn: true` | no (`claude auth login`) |
| 11 | Router model | a small/fast model is available for `routing.model` | no (config) |
| 12 | Extension linked | `<agentDir>/extensions/multi-harness` exists | yes (symlink) |
| 13 | `multiHarness` config | block present in `config.yml` | yes (append defaults) |
| 14 | Editor config | `.vscode/*` + `.editorconfig` present | shipped in repo |

`<agentDir>` = `PI_CODING_AGENT_DIR`, else `~/.omp/agent` — and
`~/.omp/profiles/<name>/agent` under `omp --profile <name>`. Resolve at runtime; never
hard-code.

## Authentication

Three **separate, non-transferable** logins. This is the single most important thing to get
right:

| who | login | status check | used for |
|---|---|---|---|
| OMP | `omp` → `/login` | `omp models ls --json` | the supervisor's own turns **and** the router model |
| Codex | `codex login` | `codex login status` | everything `ask_codex` does |
| Claude Code | `claude auth login` | `claude auth status --json` | everything `ask_claude` does |

**OMP's auth integration is not reused for the workers** (decision D-012). OMP has an
auth-broker credential vault and can hold Anthropic credentials, but Claude Code will not
accept externally supplied credentials, and forwarding them would violate the project's
core constraint anyway. Each CLI keeps its own login, full stop.

### Gotchas found while verifying (2026-09-18)

- **`codex login status` writes to stderr, not stdout.** A check that reads only stdout
  reports a logged-in user as unauthenticated. Read both streams.
- **`claude auth status --json` includes the account email, org id, and org name.** Read
  only `loggedIn` and `authMethod`; never print or persist the rest.
- `omp auth-broker status` returning `{"ok":false,"reason":"not_configured"}` is **normal** —
  the broker is an optional vault, not OMP's login state. Use `omp models ls --json`.
- An unauthenticated OMP is not a hard failure for this extension: `/agents`, `/codex`, and
  `/claude` still work, but the supervisor cannot take a turn and `auto` routing degrades
  to rules.

## In-OMP commands

- `/harness-setup` — runs the same checklist inside a session and renders it, with a
  per-row fix hint. Read-only by default; `/harness-setup fix` applies the automatic fixes
  after a `ctx.ui.confirm`.
- `/agents auth <codex|claude>` — shows that agent's auth status and, when logged out, the
  exact login command. Because login flows need a TTY and a browser, the command **offers**
  to run it in an interactive shell rather than capturing it — and says so plainly if the
  session has no UI.

## Editor configuration (shipped in the repo)

- `.vscode/settings.json` — workspace TypeScript SDK, tabs, LF, final newline, YAML
  association for `config.yml`.
- `.vscode/extensions.json` — Bun, Prettier, EditorConfig, YAML recommendations.
- `.vscode/launch.json` — run the doctor, run `bun test`, and launch
  `omp --no-extensions -e ./src/index.ts` in an integrated terminal.
- `.vscode/tasks.json` — `setup: check`, `setup: fix`, `typecheck`, `test`, `omp: run with
  extension` (default test task = `bun test`).
- `.editorconfig` — tabs in code, spaces in markdown/YAML/JSON, LF everywhere.
