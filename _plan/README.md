# _plan — Implementation Plan & Tracking

Implements [`../_spec`](../_spec). Nothing here contradicts the spec; if reality forces a
change, edit the spec in the same commit and log it in [decisions.md](decisions.md).

| File | Purpose |
|---|---|
| [PROGRESS.md](PROGRESS.md) | **The tracker.** Single source of truth for task status. Update it as work lands. |
| [decisions.md](decisions.md) | Decision log (D-xxx) + open questions |
| [phase-0-bootstrap.md](phase-0-bootstrap.md) | Repo, toolchain, OMP dev loop |
| [phase-1-skeleton.md](phase-1-skeleton.md) | Extension shell, config, detection, `/agents`, process runner |
| [phase-2-codex.md](phase-2-codex.md) | Codex adapter, `ask_codex`, `/codex` |
| [phase-3-claude.md](phase-3-claude.md) | Claude adapter, `ask_claude`, `/claude` |
| [phase-4-parallel-sessions.md](phase-4-parallel-sessions.md) | Run registry, parallel runs, `/sessions`, session mapping |
| [phase-5-supervisor.md](phase-5-supervisor.md) | `delegate`, `agent_runs`, routing guidance |
| [phase-6-hardening.md](phase-6-hardening.md) | Locking, read-only, cancellation cleanup, fake-CLI suite, docs |

## Conventions

- **Task ids** `T-<phase><nn>` (e.g. `T-203`). Referenced in commits: `T-203: parse codex JSONL`.
- **Status** `todo` → `wip` → `done` / `blocked`. Only `PROGRESS.md` carries status;
  phase docs describe the work.
- A task is `done` only when its **Definition of Done** and its tests pass. Reporting a
  task done with failing tests is a defect in itself.
- Each phase ends with a manual check against the real CLIs before the next begins.

## Dev loop

```bash
omp -e ./src/index.ts            # load the extension without installing it
omp --no-extensions -e ./src/index.ts   # clean baseline: only this extension
```

Install for real use (Phase 6):

```bash
ln -s "$PWD" ~/.omp/agent/extensions/multi-harness
```
