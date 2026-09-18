# 11 — Testing Strategy

Everything that does not require a live provider call is automated. `bun test` (OMP is a
Bun project) — or `vitest` if the extension is packaged standalone; pick one in Phase 1 and
keep it.

## Unit tests

- executable resolution (found / not found / configured absolute path / spaces in path)
- `buildArgs` for both adapters × {new, resume} × {readOnly, write} × capability sets
- JSONL stdout parser: well-formed, partial lines split across chunks, interleaved noise,
  malformed lines, empty stream
- session-id extraction (Codex: candidate-key search; Claude: generated-id echo + mismatch)
- final-output resolution incl. `-o` file path and fallbacks
- timeout → SIGTERM → SIGKILL escalation
- cancellation before spawn, during spawn, after exit (idempotent)
- process-group kill actually reaps grandchildren
- workspace lock: FIFO order, reader parallelism, writer exclusion, release on throw and on
  cancel, `WORKSPACE_BUSY` when `writerQueue: false`
- run registry: start/list/cancel/wait, `maxConcurrentRuns` queuing, shutdown drain
- config load: defaults, partial override, invalid values, unknown keys
- routing rules incl. fallback when the preferred agent is unavailable
- error normalization for every `AgentErrorCode`
- redaction: assert no prompt text, token-shaped string, or env value ever reaches the
  logger (property-style test over a fixture prompt containing a fake secret)

## Fake CLI fixtures

`test/fixtures/fake-codex` and `test/fixtures/fake-claude` — executable scripts driven by
env vars (`FAKE_MODE=success|stream|exit-nonzero|malformed|hang|session|auth-error`) that
simulate:

- successful structured output (+ `-o` file for Codex)
- streaming progress events
- non-zero exit with an auth-style stderr
- malformed / partially-malformed output
- hang (for timeout and cancellation tests)
- session-id emission and resume acknowledgement
- a child process of its own (to prove process-group kill works)

Tests point `multiHarness.<agent>.executable` at the fixture. **No live provider calls in
the default suite.**

## Integration tests (opt-in, never in CI)

Gated behind `MULTI_HARNESS_LIVE_TESTS=1`. Runs a trivial read-only task against the real
`codex` and `claude` in a scratch git repo and asserts: exit 0, non-empty output, a session
id captured, and `/agents` reporting both ready.

## Manual verification checklist (per phase)

Each phase doc in `_plan` ends with a manual checklist run against the real
`omp -e ./src/index.ts` (fast loop, no install needed).
