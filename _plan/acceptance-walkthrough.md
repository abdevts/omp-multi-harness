# Acceptance walkthrough (T-606 / T-608 input)

Engineering audit, not a status report. Written against the tree as of 2026-09-18, with
four other agents concurrently editing `src/` — the counts below are a snapshot; re-run
`bun test` to get current numbers before relying on this document.

## 1. Full suite — real numbers

```
$ bun test
 352 pass
 2 skip
 0 fail
 884 expect() calls
Ran 354 tests across 21 files. [~6s]
```

Per-file breakdown (`bun test test/<file>.test.ts`, run individually so one file's failure
cannot be misattributed to another):

| File | pass | skip | fail |
|---|---|---|---|
| agent-runs.test.ts | 14 | 0 | 0 |
| availability.test.ts | 7 | 0 | 0 |
| cancellation.test.ts | 13 | 0 | 0 |
| claude.test.ts | 18 | 0 | 0 |
| codex.test.ts | 18 | 0 | 0 |
| config.test.ts | 20 | 0 | 0 |
| delegate-args.test.ts | 11 | 0 | 0 |
| errors.test.ts | 16 | 0 | 0 |
| executable.test.ts | 7 | 0 | 0 |
| live.test.ts | 0 | 2 | 0 |
| read-only.test.ts | 20 | 0 | 0 |
| redaction.test.ts | 43 | 0 | 0 |
| ring-buffer.test.ts | 9 | 0 | 0 |
| routing-behavior.test.ts | 42 | 0 | 0 |
| routing.test.ts | 27 | 0 | 0 |
| run-lock.test.ts | 10 | 0 | 0 |
| run-registry.test.ts | 17 | 0 | 0 |
| sessions-command.test.ts | 19 | 0 | 0 |
| sessions-resume.test.ts | 18 | 0 | 0 |
| sessions-store.test.ts | 12 | 0 | 0 |
| spawn-agent.test.ts | 11 | 0 | 0 |

`cancellation.test.ts`, `read-only.test.ts` and `redaction.test.ts` were added by other
agents mid-session (Phase 6 work landing concurrently); a first full-suite run during this
audit briefly caught them at 5 failing (in-progress edits), a re-run seconds later was green.
Treat "0 fail" above as current at time of writing, not a permanent guarantee — this
document does not own those files.

## 2. Live-CLI gating — verified

```
$ grep -rn "MULTI_HARNESS_LIVE_TESTS" test/ src/
test/live.test.ts:2: * Live integration tests. Skipped unless MULTI_HARNESS_LIVE_TESTS=1.
test/live.test.ts:13:const LIVE = process.env.MULTI_HARNESS_LIVE_TESTS === "1";
```

Only `test/live.test.ts` references the env var, and it is the only file that constructs
`ClaudeAgent`/`CodexAgent` against a real executable name (`DEFAULTS.claude`/`DEFAULTS.codex`,
i.e. `claude`/`codex` on `PATH`, no fixture override). Every other file that touches
`ClaudeAgent`, `CodexAgent`, or `spawnAgent` points `executable`/`command` at
`test/fixtures/bin/{codex,claude}` or a `test/fixtures/*.sh` script — confirmed by grepping
for `executable:` and `command:` across `test/*.test.ts`. **No ungated live CLI call found
in the default suite.** `bun test` (no env var set) never shells out to a real `codex` or
`claude` binary.

## 3. Running the opt-in live suite

```
MULTI_HARNESS_LIVE_TESTS=1 bun test test/live.test.ts
```

- Cost: two real agent turns (one Claude Code run, one Codex run), each up to 180s timeout,
  each billed against whatever account is authenticated for that CLI. Not free, not
  sandboxed — it runs the actual CLI in a scratch temp directory it creates and deletes
  nothing of (mkdtemp, never cleaned up in the test itself).
- Never run in CI — the suite is `describe.skip`ped by default specifically so CI cannot
  trigger it by accident.
- **Known blocker (Codex):** the Codex account available in this environment is out of
  credits. A live run surfaces this as `AgentErrorCode: PROVIDER_LIMIT` (see
  `src/process/process-error.ts` — `providerLimit(...)`), not a generic failure. The Codex
  half of `live.test.ts` cannot be verified green here for that reason — it is a credits
  problem, not a code defect, but it is unverified in this environment as of this writing.
- **Known blocker (OMP model routing):** OMP itself has no authenticated model in this
  environment, so `routing.mode: "model"` (the default) cannot make its classification call
  here — `ctx.models.resolve(spec)` has nothing to resolve, or `getApiKeyAndHeaders` fails,
  either of which `route()` treats as an ordinary router-model failure and falls back to
  `routeByRules` silently (this is by design — see `route.ts`'s catch-and-fall-through).
  Practically: in this environment, **all routing decisions are rules-based**, never
  model-based, regardless of `routing.mode`. This is worth knowing when reading `/sessions`
  or `delegate` output that says `routedBy: "rules"` — it is not evidence the model path was
  exercised, only that the fallback works.

## 4. Spec-12 acceptance table (A–N)

Legend: **Verified** = an automated test exercises the real behavior end to end (including
against a fake-CLI fixture that stands in for the real process boundary). **Fake-CLI
coverage only** = tests exist and pass, but only through the fixture scripts, not the real
`codex`/`claude` binaries, and the corresponding live check has not been run in this
environment. **Unverified** = no automated test and no recorded manual run found in this
tree for this criterion.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| A | Extension loads; no startup errors with either agent missing | **Verified (manual, 2026-09-18)** | `omp models ls -e ./src/index.ts` against the wired extension loads clean — no output, no extension error. Crucially this was run with a control: a deliberately throwing extension (`export default function boom() { throw new Error("PROBE_CANARY_FACTORY_RAN") }`) under the same invocation reports `Failed to load extension: … PROBE_CANARY_FACTORY_RAN`, proving `-e` genuinely executes the factory body and surfaces throws — so a clean run is real evidence, not a silently-ignored flag. This exercises the load phase where `ExtensionRuntimeNotInitializedError` would fire (_spec/01 §2), covering registry creation, session-store creation, and all eight registrations. Still unverified: the "either agent missing" half, which needs a PATH without `codex`/`claude`. |
| B | `/agents` reports presence/path/version/status, degrades gracefully | **Verified** (rules) / **Fake-CLI coverage only** (real binaries) | `test/availability.test.ts` (7 tests): missing executable → unavailable with reason not a throw; disabled config never spawns; auth probe skip; caching. Uses fixture/fake paths, not real `codex`/`claude`. |
| C | `/codex ...` runs the installed Codex CLI and returns its answer | **Unverified (here)** | Marked manual-only in spec. `test/live.test.ts` covers this path against the real CLI but is gated and, per §3, blocked by `PROVIDER_LIMIT` for Codex in this environment. |
| D | `/claude ...` same, via Claude | **Unverified (here)** | Same as C. The Claude half of `live.test.ts` is not blocked by credits, but there is no record in this tree of it having been run (`MULTI_HARNESS_LIVE_TESTS=1 bun test test/live.test.ts` was not executed as part of this audit — running it spends real quota, which this audit did not authorize itself to do). |
| E | Supervisor autonomously calls `ask_codex`/`ask_claude` via tool calling; **no rigid workflow imposed** | **Verified** (routing logic) / **Unverified** (live supervisor behavior) | `test/routing.test.ts` + `test/routing-behavior.test.ts` (this file) assert the rule table's decisions on a 30-item realistic corpus, that an explicit agent always wins, that config overrides (`modeMap`, `default`) change outcomes, and explicitly that no field or sequencing in a `RouteDecision` forces a plan→implement chain. What is **not** verified: that a live OMP supervisor, given real model reasoning, actually chooses to call the tools autonomously and does not itself invent a rigid workflow — that is a property of the calling model's behavior at runtime, not of `route.ts`, and needs a manual/live check. |
| F | Native auth preserved; no API key required by the extension; no credential file read | **Verified (code review)** / **Partially verified (test)** | `src/agents/*.ts` never construct or read an API key for the worker CLIs — confirmed by reading `agents/claude.ts` and `agents/codex.ts` (delegates entirely to CLI's own login state). `test/availability.test.ts` asserts auth is *detected* (parsed from CLI output) not supplied. No test asserts "no credential file is ever opened" as a property — that is an absence claim, verified only by code review, not by a positive test. |
| G | CWD preserved; out-of-workspace cwd rejected | **Verified by construction, not by a rejection test** | `delegate`/`ask_codex`/`ask_claude` take `cwd` only from `ctx.cwd` (OMP's own session context) — grep of `src/tools/*.ts` and `src/commands/*.ts` shows no tool parameter lets a caller supply an arbitrary `cwd`. So "out-of-workspace cwd" cannot occur through the exposed surface; there is no dedicated unit test proving a rejection path, because there is no path to reject. This is a materially different guarantee than an enforced runtime check — worth flagging if a future change adds a caller-supplied `cwd`. |
| H | Errors don't crash OMP: missing exe, auth failure, cancellation, malformed output, timeout, non-zero exit → controlled tool errors | **Verified** | `test/errors.test.ts` (16 tests, every `AgentErrorCode` constructor + `fromSpawnError` ENOENT/EACCES/other), `test/cancellation.test.ts` (13 tests, SIGTERM→SIGKILL escalation, grandchildren reaped, idempotent cancel), `test/codex.test.ts`/`test/claude.test.ts` (malformed/partial JSONL, non-zero exit with auth-style stderr) — all against fake-CLI fixtures. |
| I | Concurrent writes prevented; second write waits or `WORKSPACE_BUSY` | **Verified** | `test/run-lock.test.ts` (10 tests: FIFO order, reader parallelism, writer exclusion, release-on-throw, release-on-cancel, `queue:false` → `WORKSPACE_BUSY`, no deadlock after aborted writer) and `test/run-registry.test.ts`'s concurrency describe block (two writers serialize; `writerQueue:false` fails the second). |
| J | Native session resume for at least one agent; other falls back to fresh session with compact handoff | **Verified (unit)** / **Unverified (live resume)** | `test/sessions-resume.test.ts` covers `decideSession`, `buildResumeFallbackTask`, `isResumeFailure`, `runWithResume` against fake agents. `test/read-only.test.ts` verifies the exact argv difference (codex `resume <id>`, claude `--fork-session`). Whether the *real* Codex/Claude CLIs actually honor these resume flags end to end is not exercised — that would need a live run. |
| K | Parallel runs: two+ delegated runs execute concurrently and both complete correctly | **Verified (unit)** / **Unverified (manual, real CLIs)** | `test/run-registry.test.ts` "concurrency" describe: `maxConcurrentRuns` caps live children with the rest queued; readers unaffected by a writer elsewhere. All against fixtures — no recorded manual run of two real background CLI runs completing side by side. |
| L | `/sessions` works: list/attach/focus-switch/cancel, doesn't pause others | **Verified** | `test/sessions-command.test.ts` (19 tests): bare list, attach sets focus + widget, refresh scheduled through `ctx.setInterval` (not a raw timer — matters for OMP's own lifecycle), terminal run stops ticking but keeps widget until detach, cancel names the run, cancelling an already-finished run reports rather than errors, unknown/missing run id and unknown subcommand notify rather than throw. |
| M | No leaks: ending the OMP session kills every child/descendant; no zombies, no orphaned locks | **Verified (unit)** | `test/cancellation.test.ts` "grandchildren" + "temp-file cleanup" describes (three-generation process tree reaped via process-group kill; no leftover temp files after cancel/timeout/spawn failure) and `test/run-registry.test.ts` "shutdown cancels every non-terminal run, queued ones included". All fixture-based (`grandchildren-chain.sh`, `ignore-sigterm.sh`) — process-group semantics are OS-level and the fixtures genuinely spawn real OS processes, so this is a strong proxy even without a real CLI in the loop. No live check of the actual `codex`/`claude` process trees. |
| N | Secrets never logged; redaction holds with `debug: true` and `debug: false` | **Verified** | `test/redaction.test.ts` (43 tests) — per-token-shape redaction, realistic multi-line stderr (Codex crash dump, Claude env dump, PEM block), idempotency, false-positive avoidance (git SHAs, semver, plain prose untouched), `redactEnv` as an allowlist not a denylist, every `AgentError` factory redacts its stderr tail, and a regression-guard sweep over all factories. This is the most thoroughly tested criterion in the suite. Note: tests assert redaction of the *tail text passed into error construction*; they do not additionally spin up the actual `pi.logger` and assert on its output stream, so "never appears in logger output" is verified at the point secrets would reach the logger call, not by capturing stdout/stderr of a running OMP process. |

### Summary

- **Solidly verified by automated tests (fake-CLI or pure-unit):** F (code review + partial test), H, I, L, M, N, and the routing-logic half of E.
- **Verified only against fake CLIs, not real ones, in this environment:** B, J, K.
- **Genuinely unverified here, requiring a manual or live run this audit did not perform:** A, C, D, the live-supervisor-behavior half of E, G's "no exposed path" claim (verified by code structure, not a runtime check), and the real-CLI end of J and K.

## 5. Routing-behavior findings (T-505)

Full corpus and assertions are in `test/routing-behavior.test.ts` (~30 task strings, split
evenly claude-leaning / codex-leaning per spec 12-E's split, plus explicit-agent-wins,
config-override, and no-rigid-workflow checks). One disagreement found and recorded rather
than silently accommodated:

- **`"Analyze the test coverage gaps in the billing service."`** reads as analysis/assessment
  work to a human dispatcher (it's asking "how good is our test coverage," not "write more
  tests"), but `routeByRules` sends it to **codex**. Cause: `"Analyze"` scores one Claude
  point via `analy\w+`; `"test"` (from "test coverage") scores one Codex point via the bare
  `\btest\b` signal in `CODEX_SIGNALS`; the tie falls through to `routing.default`, which
  defaults to `"codex"` for an ambiguous task with `routing.default: "auto"`. This is not a
  bug exactly — the tie-break is documented, deliberate behavior in `route.ts` — but it is a
  real corpus item where the *tie-break*, not the *signal words*, produces a surprising
  answer, and the word "test" is common enough in review/analysis language ("test coverage,"
  "test the hypothesis," "does this pass the smell test") that it will keep colliding with
  Codex's much more literal `\btest\b`. Recorded as a test (`test/routing-behavior.test.ts`,
  "disagreement: ...") asserting the *current* behavior, not endorsing it — no change made to
  `route.ts`, which is out of scope for this task.

No other corpus item produced a result this audit disagreed with; the ~29 remaining items
route the way a human dispatcher reading spec 12-E's split would expect.

## 6. What this document does not cover

- README (T-607) — out of scope for this file/agent, owned elsewhere.
- `_plan/PROGRESS.md` ticking — explicitly excluded from this agent's file ownership; someone
  with write access to that file should transcribe §4's table into it.
- Any change to `src/routing/route.ts` to "fix" §5's finding — that file is owned by another
  agent in this session; the finding is reported, not acted on.
