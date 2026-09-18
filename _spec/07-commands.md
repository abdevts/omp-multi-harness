# 07 — Slash Commands

Registered with `pi.registerCommand(name, {description, handler, getArgumentCompletions?})`.

## `/codex <task>` and `/claude <task>`

Direct delegation, bypassing supervisor routing. Arguments are the task text.

Behaviour:
1. Resolve cwd = OMP session cwd. Acquire the appropriate lock (08).
2. Start the run; show live progress via `ctx.ui.setStatus("multi-harness", …)`.
3. On completion, deliver the worker's output back into the conversation with
   `pi.sendUserMessage(text, { attribution: "agent" })` so the supervisor can act on it and
   consumers can tell it apart from user-typed text.
4. Cancellation: the standard OMP abort path cancels the run.

Flags parsed from the argument string: `--read-only`, `--new` (fresh worker session),
`--bg` (background run, returns the run id immediately), `--model <id>` (per-call worker
model override; see spec 09 §Model selection).

## `/agents`

Capability report. Force-refreshes detection.

```text
Codex
  executable: /opt/homebrew/bin/codex
  version:    codex-cli 0.155.0
  status:     ready

Claude
  executable: /Users/…/.local/bin/claude
  version:    2.1.274 (Claude Code)
  status:     ready

Workspace: /Users/…/dev/projects/foo   (write lock: free)
Runs: 2 running, 5 finished
```

Unavailable agent renders as `status: unavailable — executable not found` (or
`not authenticated`) with the exact remediation command. **Never** print token or
credential file contents; showing the resolved executable path is fine.

## `/sessions`

Interactive view of **delegated runs only** — list, watch, switch focus, cancel.

> **Scope rule: do not duplicate what OMP already does.** OMP ships `/resume`, which lists
> and switches OMP's own sessions, and `/resume @claude` / `/resume @codex`, which import a
> foreign Claude Code or Codex session into OMP. `/sessions` therefore never lists OMP
> sessions and never switches the OMP session — it covers only the child agent runs this
> extension started, which nothing in OMP tracks. If a future OMP release grows an
> equivalent run monitor, drop ours and point at theirs.

Rendering: `ctx.ui.custom(...)` when `ctx.hasUI`; a plain text table otherwise
(print/RPC modes). Modeled on `omp ps`'s interactive monitor.

```text
 ▸ ●  r7c1  codex   implement  running   2m14s   fix failing transaction tests
   ●  r7c2  claude  review     running   0m48s   review auth architecture
   ✓  r7b9  codex   debug      done      4m02s   flaky kysely pool test
   ✗  r7a4  claude  plan       failed    0m11s   (session resume failed)
   ⊘  r7a1  codex   test       cancelled 1m30s   run integration suite

 ↑↓ select   enter attach   c cancel   n new   d detach   q close
```

Actions:

| key | action |
|---|---|
| `enter` | **attach/focus** — live output of that run streams into the widget; status line shows its phase |
| `d` | detach focus (runs keep going) |
| `c` | cancel the selected run (confirm first for a writer) |
| `r` | show the finished run's full output in the transcript |
| `n` | start a new run: pick agent → mode → type task |
| `q` | close |

"Switching between sessions" = switching **focus** between concurrently running workers.
It does not switch the OMP session itself — that is `/resume`'s job — and it never pauses a
run: every run keeps executing in the background regardless of focus.

Argument forms (non-interactive): `/sessions list`, `/sessions attach <runId>`,
`/sessions cancel <runId>`, `/sessions clear` (drop finished runs from the list).
`getArgumentCompletions` completes run ids and subcommands.

## `/harness-setup`

Runs the setup checklist from spec 14 inside the session and renders it as a table with a
fix hint per row. `/harness-setup fix` applies the automatic fixes (symlink, config block,
dependencies) after a `ctx.ui.confirm`. Installs and logins are never run — the command is
shown instead.

## `/agents auth <codex|claude>`

Per-agent authentication status and remediation.

```text
Codex    logged in using ChatGPT
Claude   logged in via claude.ai

OMP      no authenticated models — run `omp` and use /login
         (OMP's own login; it is never shared with the workers)
```

When an agent is logged out, prints the exact command (`codex login`, `claude auth login`)
and offers to open it in an interactive shell. The extension never performs the login
itself, never captures credentials, and never reads a credential file — it only reads each
CLI's own status output. Note that `codex login status` writes to **stderr** (spec 14).

## Future commands (do not implement in MVP unless trivial)

`/team`, `/agent-status`, `/agent-reset`.
