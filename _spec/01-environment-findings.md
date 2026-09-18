# 01 — Environment Findings (verified 2026-09-18)

Everything below was checked by running the tools, not assumed. Re-verify before Phase 2
if more than a few weeks pass — all three CLIs move fast.

## 1. OMP — `omp/18.2.6` at `~/.bun/bin/omp`  ✅ installed

Installed mid-session by the user and verified. Version matches the reference repo
(`@oh-my-pi/pi-coding-agent@18.2.6`), so the API docs in that repo are authoritative here.

`~/.omp/` does not exist yet — it is created on first run. Phase 0 runs `omp` once so the
agent directory and `config.yml` exist before the extension is installed.

**Do not confuse OMP with the `pi` also on this machine.** They are different projects and
the extension is NOT portable between them without a shim:

| | OMP (target) | also installed: `pi` |
|---|---|---|
| package | `@oh-my-pi/pi-coding-agent@18.2.6` | `@earendil-works/pi-coding-agent@0.80.6` |
| binary | `omp` (`~/.bun/bin/omp`) | `pi` (`~/.local/bin/pi`) |
| config dir | `~/.omp/agent/` | `~/.pi/agent/` |
| extension dirs | `~/.omp/agent/extensions/`, `<cwd>/.omp/extensions/` | `~/.pi/agent/extensions/`, `.pi/extensions/` |
| loader | Bun | jiti |
| tool schema builder | `pi.zod` / `pi.arktype` / `pi.typebox` shim | `typebox` `Type` |
| repo | `github.com/can1357/oh-my-pi` (Stencil Labs) | earendil-works |

**Decision:** target OMP only. See `_plan/decisions.md` D-001/D-002.

Relevant `omp` surface discovered while verifying:

- `-e, --extension=<path>` — load an extension file directly (fast dev loop, no install).
- `--no-extensions` — disable discovery; explicit `-e` still works (clean test baseline).
- `--profile <name>` — isolated profile; shifts the agent dir to
  `~/.omp/profiles/<name>/agent/`. Never hard-code `~/.omp/agent`; resolve the active
  agent dir (and honor `PI_CODING_AGENT_DIR`).
- `--from-claude` / `--from-codex` — OMP can **import a Claude Code or Codex session**
  into an OMP session. Out of MVP scope, but the strongest future handoff primitive; see
  D-006.
- `omp ps` — daemon-supervised background *services* (list/info/logs/stop/kill/restart,
  `--json`). It supervises services, not ad-hoc agent runs, so the run registry in 08
  stays extension-owned; `omp ps` is the UX precedent `/sessions` should feel like.
- `/resume` — built-in interactive picker that lists OMP sessions and switches to one.
  **`/resume @claude` and `/resume @codex`** open a *foreign*-session picker: selecting one
  converts a Claude Code or Codex session into a fresh OMP session and switches to it
  (the slash-command form of `--from-claude` / `--from-codex`). OMP therefore already owns
  session browsing, session switching, and worker-session import — this extension must not
  reimplement any of the three.
- `omp agents`, `omp plugin`, `omp install` — bundled task agents and plugin installation.
- `ctx.getAsyncJobSnapshot()` exists on the extension context for the host's own async-job
  view; it is read-only and does not manage our child processes.

Reference checkout used for API discovery: `github.com/can1357/oh-my-pi` (cloned to a
scratch dir; re-clone as needed — it is not vendored into this repo).

## 2. OMP extension API surface (from `oh-my-pi/docs/extensions.md`)

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function (pi: ExtensionAPI) { /* registration only */ }
```

- **Load phase is registration-only.** Calling action methods (`pi.sendMessage`, …) during
  load throws `ExtensionRuntimeNotInitializedError`. Register first; act from
  events/commands/tools.
- Registration: `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`,
  `registerMessageRenderer`, `registerComposerShape`, `setLabel`.
- Actions: `sendMessage` / `sendUserMessage` (`deliverAs: steer | followUp | nextTurn | aside`),
  `appendEntry`, `exec(command, args, opts)`, `getActiveTools` / `setActiveTools`,
  `getCommands`, `setSessionName`.
- Also exposed: `pi.logger`, `pi.zod`, `pi.arktype`, `pi.typebox`, `pi.pi`.
- `ExtensionContext` (`ctx`): `ui`, `hasUI`, `cwd`, `sessionManager` (read-only),
  `models`, `signal`, `isIdle()`, `abort()`, `shutdown()`, `getContextUsage()`,
  **`ctx.setInterval` / `ctx.setTimeout` / `ctx.clearTimer`**.
- `ExtensionCommandContext` adds `waitForIdle()`, `newSession()`, `switchSession()`,
  `branch()`, `navigateTree()`, `reload()`.

**Critical runtime rule:** extensions run in-process with **no isolation**. A raw
`setInterval`/`setTimeout`/detached-promise callback that throws becomes a process-level
`uncaughtException` and **tears down the whole OMP session**. All background work in this
extension MUST use `ctx.setInterval` / `ctx.setTimeout` (isolated, auto-cleared on
`session_shutdown`), and every detached promise MUST have a `.catch`.

Install locations: `~/.omp/agent/extensions/<name>/index.ts` (global) or
`<cwd>/.omp/extensions/<name>/index.ts` (project-local, loads only after the project is
trusted). Configured paths also via `~/.omp/agent/config.yml#extensions`.

Name note: OMP already has an internal package called `@oh-my-pi/pi-metaharness`
(benchmark runner, unrelated). Ship this as **`multi-harness`** and avoid the word
"metaharness" anywhere user-visible.

## 3. Codex CLI — `codex-cli 0.155.0` at `/opt/homebrew/bin/codex`

Non-interactive entry point is `codex exec` (alias `codex e`). Verified flags:

| Flag | Meaning |
|---|---|
| `[PROMPT]` positional, or `-`/piped stdin | instructions (**use stdin — keeps prompts out of `ps`**) |
| `--json` | print events to stdout as **JSONL** |
| `-o, --output-last-message <FILE>` | write the agent's final message to a file |
| `-C, --cd <DIR>` | working root |
| `-s, --sandbox <read-only \| workspace-write \| danger-full-access>` | sandbox policy |
| `-m, --model <MODEL>` | model override (omit → user's config decides) |
| `--skip-git-repo-check` | allow running outside a git repo |
| `--add-dir <DIR>` | extra writable dirs |
| `--worktree` | run in a new managed git worktree (future use) |
| `--output-schema <FILE>` | JSON Schema for the final response shape |
| `--ephemeral` | do not persist session files |
| `-c key=value` | config override |

Resume: `codex exec resume <SESSION_ID|thread-name> [PROMPT]`, or `--last`.
Also available: `codex exec fork`, `codex exec review`, `codex agents`, `codex resume`.

Auth status: **`codex login status`** → `Logged in using ChatGPT`, exit 0 — but it prints to
**stderr, not stdout**. A checker reading only stdout will wrongly report "not
authenticated" (this bit the first version of `scripts/setup.ts`). Login: `codex login`.

Never pass `--dangerously-bypass-approvals-and-sandbox` or `--dangerously-bypass-hook-trust`.

Read-only mapping: `-s read-only`. Write mapping: `-s workspace-write`.

## 4. Claude Code CLI — `2.1.274` at `~/.local/bin/claude`

Non-interactive entry point is `claude -p`. Verified flags:

| Flag | Meaning |
|---|---|
| `-p, --print` | print response and exit (reads prompt from arg or stdin) |
| `--output-format <text\|json\|stream-json>` | structured output (`-p` only) |
| `--include-partial-messages` | partial chunks with `stream-json` |
| `--session-id <uuid>` | **use a caller-supplied session id** |
| `-r, --resume [id]` | resume a conversation by session id |
| `-c, --continue` | continue most recent conversation in cwd |
| `--fork-session` | new id when resuming |
| `--permission-mode <acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan>` | permission policy |
| `--tools <names...>` | restrict to a subset of built-in tools |
| `--allowedTools` / `--disallowedTools` | finer tool gating |
| `--add-dir <dirs...>` | extra accessible dirs |
| `--model <model>` | model override (omit → user's config decides) |
| `--max-turns`, `--effort`, `--append-system-prompt` | run shaping |
| `-w, --worktree [name]` | run in a new git worktree (future use) |
| `--bg, --background` | run detached; pairs with `claude agents / attach / logs / stop / rm` |

**No `-C/--cd` flag** — set the working directory via the spawn `cwd` option.

Auth status: **`claude auth status --json`** → `{"loggedIn": true, "authMethod": "claude.ai", …}`
on stdout. The payload also contains the account **email, org id, and org name** — read only
`loggedIn` and `authMethod`, never print or persist the rest. Login: `claude auth login`.

Never pass `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions`.

Read-only mapping: `--permission-mode plan` plus a read-only `--tools` allowlist
(e.g. `Read,Grep,Glob,WebSearch`). Write mapping: default permission mode, or
`acceptEdits` only when the user has opted in via config.

`--session-id` is the single most useful fact here: the extension can **generate** the
worker session UUID instead of scraping it from output, making the OMP↔worker session map
deterministic for Claude.

## 4b. Auth state of this machine (2026-09-18)

| | state |
|---|---|
| Codex | ✅ logged in using ChatGPT |
| Claude Code | ✅ logged in via claude.ai |
| OMP | ❌ **no authenticated models** — `omp models ls --json` → `{"models":[]}` |

OMP's own `/login` is still outstanding. Consequence: the supervisor cannot take a turn yet,
and `auto` routing will degrade to rules until OMP has a model. The workers are unaffected —
they authenticate themselves. `omp auth-broker status` → `{"ok":false,"reason":"not_configured"}`
is normal (optional vault), **not** an auth failure.

## 5. Consequences for the design

1. Session-id acquisition is **asymmetric**: Claude = caller-supplied UUID; Codex = parsed
   from `--json` event stream (with `-o` as the reliable final-message channel).
2. Both CLIs accept prompts on stdin → always feed the task over stdin, never argv.
3. Both CLIs have native worktree support → the future worktree mode (13) is cheap later.
4. `claude --bg` exists, but this extension supervises its own child processes for both
   agents so behaviour, cancellation, and status are uniform. Native background mode is
   recorded as an alternative in `_plan/decisions.md` D-005.
5. Three independent logins (OMP, Codex, Claude) that are **not** interchangeable. OMP's
   auth-broker is never used to feed the workers — Claude Code will not accept externally
   supplied credentials (D-012). Setup must therefore verify all three separately (spec 14).
6. OMP's own auth doubles as the **router model's** auth: `auto` routing calls a small model
   through OMP (spec 09 §Router model), so an unauthenticated OMP silently falls back to
   rule-based routing rather than failing.
