# Phase 3 — Claude  (T-301 … T-306)

**Goal:** `ask_claude` and `/claude` at the same quality bar as Codex.

Spec: [04](../_spec/04-claude-adapter.md), [06](../_spec/06-tools.md), [07](../_spec/07-commands.md).

## Tasks

### T-301 — `agents/claude.ts` command construction

```
-p --output-format stream-json --verbose --session-id <uuid>
   [--permission-mode plan] [--tools Read,Grep,Glob] [--add-dir …]
```

Working directory via the spawn `cwd` option — **there is no `-C` flag**. Prompt on stdin.
`--model` only when configured. Resume: `--resume <id> [--fork-session]`.

**Verify during implementation:** whether `--verbose` is still required alongside
`stream-json` in `-p` for 2.1.x; encode the answer in the capability table rather than
assuming.

**DoD:** table-driven argv tests over {new, resume, fork} × {readOnly, write}.

### T-302 — Generated session id
`crypto.randomUUID()` passed as `--session-id`; compare against the id echoed in the
`system` init event; on mismatch trust the CLI and set `metadata.sessionIdMismatch`.

### T-303 — stream-json parser
Handle `system` (init), `assistant` / `user` (progress only), and `result` (terminal;
`subtype: "success"` → `result` is the output). Malformed lines counted and ignored.
Fallback to last assistant text; empty → `INVALID_OUTPUT`.

### T-304 — `tools/ask-claude.ts`
Same shape as `ask_codex`, sharing everything except the adapter.

### T-305 — `/claude <task>`
Mirror of `/codex`.

### T-306 — Fake `claude` fixture + tests
Same `FAKE_MODE` matrix, emitting Claude-shaped stream-json.

## Manual check

```bash
/claude review the authentication architecture and identify coupling problems
/claude --read-only ...     # plan-mode + read-only tool allowlist; confirm no file changes
git status                  # must be clean after a read-only run
```

## Exit criteria

Spec-12 **D** passes; **H** passes for Claude paths; read-only genuinely produces no writes
(or `readOnlyEnforced: false` is reported honestly).
