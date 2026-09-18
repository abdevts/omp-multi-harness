# _spec — OMP Multi-Harness

Normative specification. The plan in [`../_plan`](../_plan) implements exactly what is here.
If implementation and spec disagree, fix one of them in the same change — never leave them divergent.

| # | Document | Contents |
|---|----------|----------|
| 00 | [overview.md](00-overview.md) | Objective, architecture, hard constraints |
| 01 | [environment-findings.md](01-environment-findings.md) | **Verified** facts about omp / codex / claude on this machine |
| 02 | [agent-interface.md](02-agent-interface.md) | Provider-neutral types |
| 03 | [codex-adapter.md](03-codex-adapter.md) | Codex CLI invocation contract |
| 04 | [claude-adapter.md](04-claude-adapter.md) | Claude Code CLI invocation contract |
| 05 | [process-runner.md](05-process-runner.md) | Subprocess abstraction |
| 06 | [tools.md](06-tools.md) | LLM-callable tools |
| 07 | [commands.md](07-commands.md) | Slash commands incl. `/sessions` |
| 08 | [sessions-and-parallelism.md](08-sessions-and-parallelism.md) | Run registry, parallel runs, switching, locking |
| 09 | [config.md](09-config.md) | Configuration schema |
| 10 | [errors-and-security.md](10-errors-and-security.md) | Error model + security requirements |
| 11 | [testing.md](11-testing.md) | Fake-CLI test strategy |
| 12 | [acceptance-criteria.md](12-acceptance-criteria.md) | MVP definition of done |
| 13 | [non-goals-and-future.md](13-non-goals-and-future.md) | Out of scope, future shape |
| 14 | [setup-and-toolchain.md](14-setup-and-toolchain.md) | Prerequisites, install, auth, doctor, editor config |

## Status of the source material

This spec is derived from the user's original brief, then **corrected against reality**
(see 01). Where the brief assumed something that is not true on this machine, the
correction is called out explicitly rather than silently applied.
