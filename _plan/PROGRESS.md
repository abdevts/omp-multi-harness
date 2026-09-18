# PROGRESS

Single source of truth for task status. Update in the same change that does the work.

**Legend:** `todo` · `wip` · `done` · `blocked`
**Last updated:** 2026-09-18 — **Phases 0–2 complete.** Config, process runner,
executable + auth detection, `/agents`, `/agents auth`, `/harness-setup`, and 61 passing
tests. Consumer setup documented in the README. Codex delegation works end-to-end against a fake
CLI (90 tests); **real-CLI verification is blocked: the Codex account is out of credits.**
Next: Phase 3 (Claude adapter).

## Summary

| Phase | Tasks | Done | Status |
|---|---|---|---|
| 0 — Bootstrap | 8 | 8 | **done** |
| 1 — Skeleton | 10 | 10 | **done** |
| 2 — Codex | 7 | 7 | **done** |
| 3 — Claude | 6 | 0 | todo |
| 4 — Parallel + `/sessions` | 9 | 0 | todo |
| 5 — Supervisor | 7 | 0 | todo |
| 6 — Hardening | 8 | 0 | todo |
| **Total** | **55** | **25** | |

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
| T-301 | `agents/claude.ts` `buildArgs` + capability table | todo | spec 04 |
| T-302 | Generated `--session-id` UUID + echo verification | todo | spec 04 |
| T-303 | stream-json parser (system/assistant/result events) | todo | spec 04 |
| T-304 | `tools/ask-claude.ts` | todo | spec 06 |
| T-305 | `commands/claude.ts` (`/claude`) | todo | spec 07 |
| T-306 | Fake `claude` fixture + adapter tests | todo | spec 11 |

## Phase 4 — Parallel runs + `/sessions`

| id | task | status | notes |
|---|---|---|---|
| T-401 | `runs/types.ts` + `runs/registry.ts` | todo | spec 08 |
| T-402 | Ring buffer for live output | todo | spec 08 |
| T-403 | Progress plumbing → `ctx.setInterval` UI ticks (never raw timers) | todo | spec 01§2, 08 |
| T-404 | `background: true` on `ask_*` | todo | spec 06 |
| T-405 | `commands/sessions.ts` — `/sessions` interactive + text fallback (delegated runs only, D-011) | todo | spec 07 |
| T-406 | Focus/attach/detach, widget + status line | todo | spec 08 |
| T-407 | `sessions/store.ts` — OMP↔worker mapping, 0600 files, profile-aware agent dir | todo | spec 08 |
| T-408 | Resume + fallback handoff (`routing/handoff.ts`) | todo | spec 02, 08 |
| T-409 | `session_shutdown` drain: cancel + await every run | todo | spec 08 |

## Phase 5 — Supervisor guidance

| id | task | status | notes |
|---|---|---|---|
| T-501 | `tools/delegate.ts` with rule-based `auto` (no extra LLM call) | todo | spec 06 |
| T-502 | `tools/agent-runs.ts` (list/status/result/cancel/wait) | todo | spec 06 |
| T-503 | `routing/prompt.ts` — `promptSnippet` + `promptGuidelines` naming each tool | todo | spec 06 |
| T-504 | Availability-aware fallback when the preferred agent is missing | todo | spec 06 |
| T-505 | Routing behavior checks (plan→claude, implement→codex, no rigid workflow) | todo | spec 12-E |
| T-506 | Router model for `auto` (`routing.mode: model`, default `@smol`, rules fallback) | todo | spec 09 §Router model; D-013 |
| T-507 | Worker model overrides: per-call `model` > `<agent>.model` > CLI config | todo | spec 09 §Model selection |

## Phase 6 — Hardening

| id | task | status | notes |
|---|---|---|---|
| T-601 | `runs/lock.ts` workspace write lock (FIFO, release in finally) | todo | spec 08 |
| T-602 | Read-only enforcement + honest `readOnlyEnforced` reporting | todo | spec 02, 10 |
| T-603 | Cancellation cleanup incl. process-group kill | todo | spec 05 |
| T-604 | Malformed/partial output resilience | todo | spec 03/04 |
| T-605 | Redaction test suite (no prompts/tokens/env in logs) | todo | spec 10 |
| T-606 | Full fake-CLI suite green; opt-in live suite documented | todo | spec 11 |
| T-607 | `README.md` — install, config, usage, troubleshooting | done (v1) | consumer setup written in Phase 1; revisit when tools land |
| T-608 | Acceptance walkthrough A–N recorded in this file | todo | spec 12 |

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
| ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
