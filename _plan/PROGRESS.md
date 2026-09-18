# PROGRESS

Single source of truth for task status. Update in the same change that does the work.

**Legend:** `todo` · `wip` · `done` · `blocked`
**Last updated:** 2026-09-18 — **Phases 0–5 complete; Phase 6 complete except the live
checks.** Parallel runs, `/sessions`, session continuation, background (`--bg`) delegation,
`auto` routing, `delegate` + `agent_runs`, plus hardening: workspace write lock, honest
read-only reporting, cancellation/drain coverage, malformed-output resilience, and
redaction. **378 tests pass, 2 skipped (the gated live suite), 0 fail; typecheck clean.**
Extension load verified against real `omp` with a throwing-canary control.

Three real bugs were found and fixed by the hardening pass, none of which the prior suite
caught: `ClaudeAgent.run()` never forwarded `fork` to `buildClaudeArgs` (so `--fork-session`
could never be emitted); a stray late terminal event could discard an already-successful
answer in both event parsers; and every `AgentError` factory embedded raw CLI stderr into
user-visible messages with **no redaction**, so a credential a worker echoed back could
reach an error message or log.

**Packaging (2026-09-18):** publishable as `omp-multi-harness@0.1.0` — MIT `LICENSE` added,
`files`/`exports`/`repository` set, `prepublishOnly` gates on typecheck + tests, and a
`omp-multi-harness` bin with `link`/`unlink`/`status`/`doctor` (npm install alone does not
register an extension — OMP does not scan `node_modules`). Extension auto-discovery from
`<agentDir>/extensions/` verified with a throwing canary. **Not published** — `npm publish`
is deliberately left to a human.

Two defects found while packaging: `src/sessions/store.ts` contained a literal **NUL byte**
(a hash separator) that made the file binary to grep/ripgrep — replaced with `\0`, hash
proven byte-identical; and `resolveAgentDir()` consulted OMP's resolver before
`PI_CODING_AGENT_DIR`, but upstream `getAgentDir()` memoizes that env var at module load,
so a runtime change could never be honored. The env var is now checked first — production
behavior is unchanged (env preset still wins, profiles still defer to OMP), and the
documented contract is now actually true.

Still unproven: Codex against the real binary (account out of credits → `PROVIDER_LIMIT`),
and model-based `auto` routing (OMP has no authenticated model here, so it falls back to
rules). See [`acceptance-walkthrough.md`](acceptance-walkthrough.md).

## Summary

| Phase | Tasks | Done | Status |
|---|---|---|---|
| 0 — Bootstrap | 8 | 8 | **done** |
| 1 — Skeleton | 10 | 10 | **done** |
| 2 — Codex | 7 | 7 | **done** |
| 3 — Claude | 6 | 6 | **done** |
| 4 — Parallel + `/sessions` | 9 | 9 | **done** |
| 5 — Supervisor | 7 | 7 | **done** |
| 6 — Hardening | 8 | 8 | **done** |
| **Total** | **55** | **55** | |

## Phase 0 — Bootstrap

| id | task | status | notes |
|---|---|---|---|
| T-001 | `package.json`, `tsconfig.json`, `.gitignore`, `.editorconfig`, deps | done | bun 1.4.0; `bun run typecheck` clean |
| T-002 | OMP agent directory initialized | done | `~/.omp/agent` exists; `config.yml` still absent (created on first config write) |
| T-003 | Dev loop: `omp --no-extensions -e ./src/index.ts` | done | verified |
| T-004 | `git init` + first commit | done | |
| T-005 | Pin verified CLI versions in `_spec/01` | done | omp 18.2.6 · codex 0.155.0 · claude 2.1.274 · bun 1.4.0 |
| T-006 | Setup doctor, one module per provider (`scripts/setup/{toolchain,omp,codex,claude}.ts`) orchestrated by `setup.ts` — 14 steps incl. all three auths | done | `bun run doctor`; `--json`, `--only` |
| T-007 | Editor config: `.vscode/{settings,extensions,launch,tasks}.json` + `.editorconfig` | done | |
| T-008 | Prove the factory body executes, not just exit 0 | done | probe via `omp models ls -e <file>` |

## Phase 1 — Skeleton

| id | task | status | notes |
|---|---|---|---|
| T-101 | `src/index.ts` ExtensionAPI factory (registration-only load phase) | done | factory execution verified in `omp`, not just exit 0 |
| T-102 | `config/schema.ts` + `config/load.ts` — defaults, validation, user+project merge | done | reads YAML via `Bun.YAML`; OMP exposes no config API (D-015) |
| T-103 | `process/executable.ts` — PATH resolution, no shell | done | no `which` subprocess; PATHEXT handled |
| T-104 | `process/spawn-agent.ts` — full runner | done | process-group kill proven by a grandchild test |
| T-105 | `process/process-error.ts` — typed errors + messages | done | 10 codes,every message names its fix |
| T-106 | Capability detection with per-process cache | done | auth via each CLI's own status command only |
| T-107 | `/agents` command (executable + version + auth per agent) | done | + `getArgumentCompletions` |
| T-108 | Unit tests: runner, executable, config, errors, availability | done | 61 tests, no live provider calls |
| T-109 | `/harness-setup` — setup checklist inside OMP | done | `fix` actions deferred to the doctor script |
| T-110 | `/agents auth <codex\|claude>` — status + exact login command | done | never performs a login |

## Phase 2 — Codex

| id | task | status | notes |
|---|---|---|---|
| T-201 | `agents/types.ts` (AgentRequest/Result/ExternalAgent) | done | landed in Phase 1 |
| T-202 | `agents/codex.ts` `buildArgs` + capability table | done | argv asserted exactly; prompt never in argv |
| T-203 | Codex JSONL parser (`process/jsonl.ts` + `agents/codex-events.ts`) | done | built from **real captured events**, candidate-key search |
| T-204 | `-o` final-message temp file handling | done | mkdtemp + `rmSync` in `finally` |
| T-205 | `tools/ask-agent.ts` → `ask_codex` (shared factory, ready for Claude) | done | spec 06 |
| T-206 | `commands/delegate-command.ts` → `/codex` | done | flag parser unit-tested |
| T-207 | Fake `codex` fixture + adapter tests | done | fixture reproduces the real quirks |

## Phase 3 — Claude

| id | task | status | notes |
|---|---|---|---|
| T-301 | `agents/claude.ts` `buildArgs` + capability table | done | Q-001 answered: `--verbose` IS required with stream-json under `-p` |
| T-302 | Generated `--session-id` UUID + echo verification | done | confirmed echoed on every event |
| T-303 | `agents/claude-events.ts` stream-json parser | done | built from real captured output |
| T-304 | `ask_claude` via the shared tool factory | done | spec 06 |
| T-305 | `/claude` via the shared delegate command | done | spec 07 |
| T-306 | Fake `claude` fixture + adapter tests + live test | done | `MULTI_HARNESS_LIVE_TESTS=1` — **live run passed** |

## Phase 4 — Parallel runs + `/sessions`

| id | task | status | notes |
|---|---|---|---|
| T-401 | `runs/types.ts` + `runs/registry.ts` | done | short ids, queueing, idempotent cancel, bounded drain |
| T-402 | Ring buffer for live output | done | byte-capped, line-aware, UTF-8 safe; `droppedBytes` surfaced |
| T-403 | Progress plumbing → `ctx.setInterval` UI ticks (never raw timers) | done | `ctx.setInterval` only; a throwing progress path fails just its own run |
| T-404 | `background: true` on `ask_*` | done | returns `{runId, status}`; completion notifies + `pi.appendEntry` |
| T-405 | `commands/sessions.ts` — `/sessions` interactive + text fallback (delegated runs only, D-011) | done | delegated runs only (D-011); interactive + text fallback |
| T-406 | Focus/attach/detach, widget + status line | done | focus is presentation only — never pauses or reorders a run |
| T-407 | `sessions/store.ts` — OMP↔worker mapping, 0600 files, profile-aware agent dir | done | 0600/0700, profile-aware agent dir, ids+paths+timestamps only |
| T-408 | Resume + fallback handoff (`routing/handoff.ts`) | done | one fallback, `resumedFallback`; fork (Claude) / fresh (Codex) |
| T-409 | `session_shutdown` drain: cancel + await every run | done | drains on shutdown *and* on a fresh `session_start` |

## Phase 5 — Supervisor guidance

| id | task | status | notes |
|---|---|---|---|
| T-501 | `tools/delegate.ts` with rule-based `auto` (no extra LLM call) | done | rule-based `auto`; no extra LLM call on the rules path |
| T-502 | `tools/agent-runs.ts` (list/status/result/cancel/wait) | done | list/status/result/cancel/wait over the registry |
| T-503 | `routing/prompt.ts` — `promptSnippet` + `promptGuidelines` naming each tool | done | via `before_agent_start` + tool descriptions — no invented API |
| T-504 | Availability-aware fallback when the preferred agent is missing | done | unavailable agent falls back; neither available → typed refusal |
| T-505 | Routing behavior checks (plan→claude, implement→codex, no rigid workflow) | done | 30-item corpus; asserts **no** rigid plan→implement workflow |
| T-506 | Router model for `auto` (`routing.mode: model`, default `@smol`, rules fallback) | done | every router failure falls back to rules, silently |
| T-507 | Worker model overrides: per-call `model` > `<agent>.model` > CLI config | done | one `resolveWorkerModel`; callers must not re-derive it |

## Phase 6 — Hardening

| id | task | status | notes |
|---|---|---|---|
| T-601 | `runs/lock.ts` workspace write lock (FIFO, release in finally) | done | FIFO, realpath-keyed, release-in-`finally`, abort-safe |
| T-602 | Read-only enforcement + honest `readOnlyEnforced` reporting | done | **enforcement derived from built argv**, never from the request |
| T-603 | Cancellation cleanup incl. process-group kill | done | no bug found — coverage only: SIGKILL ladder, 3-gen reap, listener hygiene |
| T-604 | Malformed/partial output resilience | done | 1 MiB line cap; streaming UTF-8 decode; terminal-event `settled` guard |
| T-605 | Redaction test suite (no prompts/tokens/env in logs) | done | **found a real leak** in every `AgentError` factory; allowlist env view |
| T-606 | Full fake-CLI suite green; opt-in live suite documented | done | no ungated live CLI call; live suite documented with its blockers |
| T-607 | `README.md` — install, config, usage, troubleshooting | done (v1) | consumer setup written in Phase 1; revisit when tools land |
| T-608 | Acceptance walkthrough A–N recorded in this file | done | recorded in `acceptance-walkthrough.md`, with evidence per criterion |

## Environment state (from `bun run doctor`, 2026-09-18)

| check | state |
|---|---|
| Bun / git / deps / typecheck | ✔ |
| OMP 18.2.6 + agent dir | ✔ |
| **OMP provider auth** | ✘ no authenticated models — user must run `omp` → `/login` |
| Codex 0.155.0 + auth | ✔ logged in using ChatGPT |
| Claude Code 2.1.274 + auth | ✔ logged in via claude.ai |
| **Codex credits** | ✘ "Your workspace is out of credits" — `codex exec` fails; blocks real-CLI verification of Phase 2 |
| Router model available | ! unverifiable until OMP is authenticated (falls back to rules) |
| Extension linked into OMP | ! not linked — dev loop uses `-e` |
| `multiHarness` config block | ! absent — defaults apply |

## Acceptance criteria status (spec 12)

| A | B | C | D | E | F | G | H | I | J | K | L | M | N |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ☑ | ~ | ☐ | ~ | ~ | ☑ | ☑ | ☑ | ☑ | ~ | ~ | ☑ | ☑ | ☑ |

- **A** extension loads in `omp 18.2.6`; **B** `/agents` reports both correctly.
- **C** `/codex` is implemented and passes fake-CLI tests, but cannot be verified live until
  the Codex account has credits — marked `~`, not done.
- **D** `/claude` verified live end-to-end.
- **F/G/H** enforced and unit-tested; **M** partially: process-group kill is proven, the
  session-shutdown drain lands with the run registry in Phase 4.
