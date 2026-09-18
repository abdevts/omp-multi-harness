# Phase 4 — Parallel Runs, Sessions, `/sessions`  (T-401 … T-409)

**Goal:** many delegated runs alive at once, visible and switchable from `/sessions`, plus
the OMP↔worker session mapping that makes `continueSession` work.

This is the phase that satisfies the "multiple sessions in parallel + `/sessions` to
display and switch between them" requirement.

Spec: [08](../_spec/08-sessions-and-parallelism.md), [07](../_spec/07-commands.md).

## Tasks

### T-401 — Run registry
`runs/types.ts` + `runs/registry.ts` per spec 08: `start`, `list`, `get`, `cancel`, `wait`,
`focus`. Session-scoped, created on `session_start`. Short user-typeable run ids.

**DoD:** tests for lifecycle, `maxConcurrentRuns` queuing, idempotent cancel, and `wait`
timeout semantics.

### T-402 — Ring buffer
Byte-capped live output buffer per run (`limits.ringBufferBytes`), line-aware so the attach
view never renders a half line.

### T-403 — Progress plumbing
Adapter `onProgress` → run `phase` → UI. The UI refresh tick uses **`ctx.setInterval`**;
raw `setInterval`/detached promises are forbidden — an uncaught throw in one tears down the
entire OMP session (spec 01 §2). Every detached promise gets a `.catch` that fails the run.

**DoD:** a test that a throwing progress callback fails only its own run.

### T-404 — `background: true`
`ask_codex` / `ask_claude` return `{ runId, status: "running" }` immediately. The finished
result is retrievable via `agent_runs` (Phase 5) and `/sessions`, and is persisted with
`pi.appendEntry` so it survives a reload.

### T-405 — `/sessions`
**Delegated runs only** (D-011): do not list or switch OMP sessions — `/resume` already
does that, including `/resume @claude` / `/resume @codex` for importing a worker session.
Before implementing, run `/help` in the installed `omp` and confirm no built-in already
covers run monitoring; if one appeared, drop `/sessions` and point at it.

Interactive list via `ctx.ui.custom()` when `ctx.hasUI`; plain text table otherwise.
Columns: focus marker, run id, agent, mode, status, elapsed, task summary.
Subcommands: `list`, `attach <id>`, `cancel <id>`, `clear`.
`getArgumentCompletions` completes subcommands and live run ids.

### T-406 — Focus / attach / detach
`enter` attaches: the focused run's tail streams into `ctx.ui.setWidget` and its phase into
`ctx.ui.setStatus`. `d` detaches. Switching focus must **never** pause, throttle, or
reorder any run — verify with two concurrent runs that both keep producing output while
focus moves between them.

### T-407 — Session store
`sessions/store.ts` per spec 08: keyed by `(ompSessionId, realpath(cwd))`, JSON under the
**runtime-resolved** agent dir (`--profile` / `PI_CODING_AGENT_DIR` aware — never hard-code
`~/.omp/agent`), 0600 files in a 0700 dir, non-sensitive metadata only. Mirror into the OMP
session with `pi.appendEntry`.

### T-408 — Resume + fallback handoff
`continueSession` semantics, one automatic fresh-session fallback on resume failure with
the compact handoff block from `routing/handoff.ts`, `metadata.resumedFallback = true`, and
a visible note in the result. Parallel same-agent/same-cwd runs get a fresh session (Codex)
or `--fork-session` (Claude) with `metadata.forked = true`.

### T-409 — Shutdown drain
`session_shutdown` cancels every non-terminal run and awaits termination within
`killGraceMs`; no child or grandchild outlives OMP.

## Manual check

```bash
# two concurrent read-only runs
/claude --bg review the auth architecture
/codex  --bg --read-only summarize the test suite
/sessions                # both listed as running, elapsed ticking
# attach one, watch output; press d, attach the other — both still progressing
/sessions cancel r7c1    # terminates just that run
# quit omp mid-run → `ps` shows no leftover codex/claude processes
```

## Exit criteria

Spec-12 **J**, **K**, **L**, **M** pass.
