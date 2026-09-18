# Phase 2 — Codex  (T-201 … T-207)

**Goal:** `ask_codex` and `/codex` working against the real Codex CLI.

Spec: [02](../_spec/02-agent-interface.md), [03](../_spec/03-codex-adapter.md),
[06](../_spec/06-tools.md), [07](../_spec/07-commands.md).

## Tasks

### T-201 — `agents/types.ts`
The provider-neutral interface from spec 02. No Codex/Claude specifics leak in.

### T-202 — `agents/codex.ts` command construction
`buildArgs(version, request)` producing:

```
exec --json -C <cwd> -s <read-only|workspace-write> -o <tmp> [--skip-git-repo-check] -
```

Prompt on **stdin**. `-m` only when `codex.model` is configured. Capability table for
version differences. Resume variant: `exec resume <id> …`.

**DoD:** table-driven tests over {new, resume} × {readOnly, write} × {git repo, not a git
repo} asserting exact argv.

### T-203 — JSONL parser
Line-delimited parse with partial-line carryover. Extract session/thread id via a
candidate-key search (not exact event names), coarse progress events, and counters.
Malformed lines increment `parseErrors` and are ignored.

### T-204 — Final message via `-o`
Temp file 0600 in the OS temp dir, read after exit, unlinked in `finally`. Fallback to the
last assistant text in the stream; empty → `INVALID_OUTPUT`.

### T-205 — `tools/ask-codex.ts`
Schema per spec 06 (`background` accepted but ignored until Phase 4). Compact result +
`details`. Mode → preamble and default `readOnly`. Errors returned as tool errors.

### T-206 — `/codex <task>`
Direct delegation with `--read-only` / `--new` flags. Live status via
`ctx.ui.setStatus`. Result relayed with `pi.sendUserMessage(..., { attribution: "agent" })`.

### T-207 — Fake `codex` fixture + tests
`FAKE_MODE=success|stream|exit-nonzero|malformed|hang|session|auth-error`, including a
`-o` write and a self-spawned child.

## Manual check

```bash
omp -e ./src/index.ts
/codex inspect this repository and summarize its architecture      # → real Codex answer
/codex --read-only list the riskiest files                          # → sandbox read-only
# start a long /codex run, hit the OMP abort → process dies, no zombie
```

## Exit criteria

Spec-12 **C** passes; **H** passes for Codex paths.
