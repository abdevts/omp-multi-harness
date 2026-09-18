# Phase 6 — Hardening  (T-601 … T-608)

**Goal:** the safety properties the spec promises are actually enforced and tested.

Spec: [05](../_spec/05-process-runner.md), [08](../_spec/08-sessions-and-parallelism.md),
[10](../_spec/10-errors-and-security.md), [11](../_spec/11-testing.md), [12](../_spec/12-acceptance-criteria.md).

## Tasks

### T-601 — Workspace write lock
`runs/lock.ts`: key = realpath cwd; async FIFO queue; readers unrestricted; one writer per
workspace; release in `finally` (cancellation and throws included); `WORKSPACE_BUSY` when
`concurrency.writerQueue: false`.

**DoD:** tests for FIFO order, reader parallelism, writer exclusion, release-on-throw,
release-on-cancel, and no deadlock after a cancelled writer.

### T-602 — Read-only enforcement, honestly reported
Codex `-s read-only`; Claude `--permission-mode plan` + read-only `--tools`. When the
installed version cannot guarantee it, set `readOnlyEnforced: false` and say so in the
result. Never claim isolation that does not exist.

**DoD:** a real-CLI manual check that `git status` is clean after a read-only run.

### T-603 — Cancellation cleanup
End-to-end: OMP abort → run abort → process-group SIGTERM → grace → SIGKILL → lock
released → registry marks `cancelled`. Verified with a fixture that spawns a grandchild.

### T-604 — Malformed output resilience
Truncated JSON, interleaved plain text, empty stream, huge single line, non-UTF8 bytes,
and a CLI that exits 0 with no result event. None may throw out of the tool.

### T-605 — Redaction tests
Property-style: run a task containing a fake secret with `debug: true` and `debug: false`;
assert the secret, any token-shaped string, and env values never appear in logger output or
in persisted session files.

### T-606 — Test suite
Full fake-CLI matrix green. Document the opt-in live suite (`MULTI_HARNESS_LIVE_TESTS=1`)
and keep it out of CI.

### T-607 — README
Install (symlink into the agent extensions dir, or `omp install`), configuration reference,
tool/command reference, troubleshooting (not authenticated, executable not found, workspace
busy, resume failed), and the security posture.

### T-608 — Acceptance walkthrough
Run criteria **A–N** from spec 12 against the real CLIs; tick the table in `PROGRESS.md`
with the date and any caveats.

## Exit criteria

All of spec 12 ticked. Anything that cannot be made true is recorded as a documented
limitation, not silently dropped.
