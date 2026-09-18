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

## Resolved

- **Q-004 — should `/sessions` also list OMP's own sessions?** No. Delegated runs only;
  OMP's `/resume` already covers session browsing, switching, and Claude/Codex import.
  Resolved by the user 2026-09-18 → D-011.

## Open questions

| id | question | blocks | default if unanswered |
|---|---|---|---|
| Q-001 | Does Claude Code 2.1.x still require `--verbose` alongside `--output-format stream-json` under `-p`? | T-301 | Pass `--verbose`; drop it if the capability probe shows it is unnecessary. |
| Q-002 | Exact Codex 0.155 JSONL event names for session id and completion | T-203 | Candidate-key search across a key list, version-tolerant by design. |
| Q-003 | Does OMP expose an official extension-scoped storage API? | T-407 | Plain JSON files under the runtime-resolved agent dir. (Config turned out to have no API either — D-015.) |
| Q-005 | Install target: symlink into `~/.omp/agent/extensions/`, project-local `.omp/extensions/`, or an npm/git package via `omp install`? | T-607 | Symlink for dev (the doctor offers it); document `omp install` for later distribution. |
| Q-006 | Should the router model ever be allowed to pick *both* agents (fan-out) rather than one? | T-506 | No — `auto` returns exactly one agent. Fan-out stays an explicit supervisor decision via two background calls. |
