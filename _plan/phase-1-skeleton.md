# Phase 1 — Skeleton  (T-101 … T-108)

**Goal:** extension shell, config, executable detection, `/agents`, and the shared process
runner. No agent orchestration yet.

Spec: [00](../_spec/00-overview.md), [05](../_spec/05-process-runner.md),
[09](../_spec/09-config.md), [10](../_spec/10-errors-and-security.md).

## Tasks

### T-101 — `src/index.ts`
Default-export the `ExtensionAPI` factory. **Registration only** during load — calling
`pi.sendMessage` etc. at load time throws `ExtensionRuntimeNotInitializedError`.
Set `pi.setLabel("Multi-Harness")`. Wire `session_start` / `session_shutdown` handlers
(no-ops for now).

### T-102 — Config
`config/schema.ts` (shape + defaults per spec 09) and `config/load.ts` reading
`multiHarness` from merged OMP config. Invalid values → warn + fall back to default;
never throw at load.

**DoD:** unit tests for defaults, partial override, invalid value, unknown key.

### T-103 — `process/executable.ts`
Resolve a configured executable name or absolute path via PATH lookup **without a shell**.
Handle spaces in paths, non-executable matches, and Windows extensions (even if untested).

### T-104 — `process/spawn-agent.ts`
The full runner per spec 05: arg arrays, `shell: false`, stdin write+close, independent
capped ring buffers, timeout, AbortSignal, `SIGTERM`→grace→`SIGKILL` on the **process
group**, single-resolution guarantee, listener cleanup in `finally`, streaming decode with
a persistent `TextDecoder`.

**DoD:** tests for normal exit, non-zero exit, timeout, pre-aborted signal, mid-run abort,
ENOENT, and a fixture that spawns its own child (proves group kill).

### T-105 — `process/process-error.ts`
`AgentError` + `AgentErrorCode` and the message table from spec 10. Map spawn errno and
stderr signatures (auth keywords) to codes.

### T-106 — Capability detection
`isAvailable()` for both agents: resolve executable, run `--version` (5 s timeout), parse,
cache per process, expose a force-refresh.

### T-107 — `/agents`
Render the report from spec 07, including workspace path and lock state (stubbed until
Phase 6) and run counts (stubbed until Phase 4). Degrades gracefully when one or both CLIs
are missing.

### T-108 — Unit tests
Runner, executable resolution, config, error mapping.

## Manual check

```bash
omp --no-extensions -e ./src/index.ts
/agents            # both ready, correct paths and versions
PATH= omp -e ./src/index.ts   # (or configure a bogus executable) → graceful "unavailable"
```

## Exit criteria

Spec-12 criteria **A** and **B** pass. Nothing spawns an agent yet.
