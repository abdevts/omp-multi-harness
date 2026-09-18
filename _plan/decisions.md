# Decision Log

| id | decision | rationale | status |
|---|---|---|---|
| D-001 | Target **OMP** (`@oh-my-pi/pi-coding-agent@18.2.6`, binary `omp`), not the `pi` also installed on this machine | They are different projects with different APIs, config dirs, and loaders. The brief says OMP. `omp` was installed and verified 2026-09-18. | accepted |
| D-002 | Do **not** support upstream `pi` in V1 | Would need a schema-builder shim (`pi.zod` vs typebox `Type`) and a second install path for no stated benefit. Revisit only if asked. | accepted |
| D-003 | Prompts are passed on **stdin**, never argv | Keeps task text out of `ps`, shell history, and argv length limits. Both CLIs support it. | accepted |
| D-004 | Extension supervises its own child processes for **both** agents | Uniform status, cancellation, and progress across providers. | accepted |
| D-005 | Do not use `claude --bg` / `claude agents` for background runs | Native background mode is Claude-only; using it would make parallelism and cancellation behave differently per agent. Recorded as an alternative if our supervision proves fragile. | accepted |
| D-006 | Worker-session import is **not built at all** | OMP already ships it as `--from-claude` / `--from-codex` and `/resume @claude` / `/resume @codex`. Point users at the built-in. | accepted |
| D-007 | ~~`auto` routing is rule-based only~~ → **superseded by D-013** | Original reasoning (the supervisor already routes semantically) still holds for the *default path*, but the user asked for a configurable router model. | superseded |
| D-008 | Parallel **reads** unrestricted; parallel **writes** to one tree serialized | MVP safety. Worktree mode (both CLIs support it natively) lifts this later. | accepted |
| D-009 | Ship as `multi-harness` | OMP already contains an unrelated internal `@oh-my-pi/pi-metaharness` benchmark package; avoid the name collision in user-facing text. | accepted |
| D-010 | All background/periodic work uses `ctx.setInterval` / `ctx.setTimeout` | Raw timers that throw become process-level `uncaughtException` and tear down the whole OMP session (OMP extensions run in-process, no isolation). | accepted |
| D-012 | **Worker auth is never routed through OMP's auth integration.** Each CLI keeps its own login; the extension only reads `codex login status` / `claude auth status --json`. | User directive: Claude Code will not accept externally supplied credentials. Also required by the project's core constraints — no token extraction, no impersonation. OMP's auth-broker stays OMP's business (it does feed the router model). | accepted |
| D-013 | `auto` uses a **router model** (`routing.mode: model`, default `routing.model: "@smol"`) with one small classification call, falling back to the rule table on any failure; `routing.mode: rules` disables it. Worker models stay overridable per agent (`codex.model` / `claude.model`) and per call (`model` argument). | User asked for a configurable router plus per-agent model choice. `@smol` uses whatever fast model the user already configured rather than hard-coding a vendor; concrete fallback is Claude Haiku 4.5 — routing is a one-word decision and a frontier model is waste. Failure always degrades to rules, so an unauthenticated OMP never breaks delegation. | accepted |
| D-014 | Setup installs and logins are **never automated**; only directories, symlinks, config blocks, and `bun install` auto-apply | Installing software and authenticating are the user's decisions, and login flows need a TTY/browser anyway. | accepted |
| D-015 | The extension reads `multiHarness` from `config.yml` itself (`Bun.YAML.parse`, user config then project config merged over it) | OMP's `ExtensionAPI`/`ExtensionContext` expose no config accessor, and `Settings.get()` is typed to known setting paths, so a custom key is not reachable through it. Reading the YAML also keeps config testable without the host. | accepted |
| D-011 | **If OMP has the feature, do not rebuild it.** `/sessions` lists delegated agent runs only; OMP session browsing/switching stays with `/resume`, worker-session import stays with `/resume @claude\|@codex`, and service supervision stays with `omp ps`. | User directive, 2026-09-18. Duplicating host features splits the UX and doubles the maintenance against a fast-moving host. Applies to every future addition, not just `/sessions`. | accepted |
| D-016 | **Keep the fresh-session fallback for a forked Codex run; do not adopt `codex exec fork` yet.** `_spec/03`'s and `src/agents/codex.ts`'s premise that Codex has no fork equivalent was wrong — `codex exec fork <SESSION_ID> [PROMPT]` exists and was verified live against `codex-cli 0.155.0` (2026-09-18; see `_spec/03-codex-adapter.md` §"Fork capability" for the verbatim `--help` output). It takes a session/thread id (not a file path) and reads its prompt from stdin, both compatible with this adapter's existing conventions. But `codex exec fork --help` lists no `-C/--cd` and no `-s/--sandbox` — the two flags `buildCodexArgs` sets on every call, for cwd correctness and for the OS-enforced read-only guarantee `codexReadOnlyEnforcement` reports. Whether a fork silently inherits cwd/sandbox from the original session (which would suit our same-cwd parallel-writer case) is unverified; `--help` doesn't say, and getting it wrong would silently break either cwd control or the read-only claim in `AgentResult.metadata.readOnlyEnforced` (T-602's "honest, never guessed" requirement). Current behavior (start fresh, no `resume`/`fork` subcommand, `metadata.forked` reported honestly) stays: safe and correct, just not optimal — it drops the forked session's prior context that a real fork would preserve. **Follow-up** (blocked on `codex.ts`, which this task could not edit — owned elsewhere): verify cwd/sandbox inheritance for `codex exec fork` (read the Codex CLI source, or run a live probe: fork a read-only session and check whether the sandbox held), and if it inherits safely, switch `buildCodexArgs`'s `fork` branch from "omit resume, start fresh" to `["exec", "fork", request.sessionId, ...]`; if it does not, close this out as "verified not adoptable" and remove the TODO rather than leave it open indefinitely. | accepted |

## Resolved

- **Q-001 — does Claude 2.1.x need `--verbose` with `stream-json` under `-p`?** Yes; encoded
  in the capability table. Verified live 2026-09-18.
- **Q-002 — Codex JSONL event names.** Captured from a real run: `thread.started`
  (`thread_id`), `turn.started`, `item.completed` (`item.type`), `turn.completed`,
  `turn.failed`. The candidate-key search stays, for version tolerance.

- **Q-004 — should `/sessions` also list OMP's own sessions?** No. Delegated runs only;
  OMP's `/resume` already covers session browsing, switching, and Claude/Codex import.
  Resolved by the user 2026-09-18 → D-011.

## Open questions

| id | question | blocks | default if unanswered |
|---|---|---|---|
| Q-003 | Does OMP expose an official extension-scoped storage API? | T-407 | Plain JSON files under the runtime-resolved agent dir. (Config turned out to have no API either — D-015.) |
| Q-005 | Install target: symlink into `~/.omp/agent/extensions/`, project-local `.omp/extensions/`, or an npm/git package via `omp install`? | T-607 | Symlink for dev (the doctor offers it); document `omp install` for later distribution. |
| Q-006 | Should the router model ever be allowed to pick *both* agents (fan-out) rather than one? | T-506 | No — `auto` returns exactly one agent. Fan-out stays an explicit supervisor decision via two background calls. |
