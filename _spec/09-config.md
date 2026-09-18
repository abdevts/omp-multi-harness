# 09 — Configuration

Loaded from OMP config (`<agentDir>/config.yml` merged with `<cwd>/.omp/config.yml`) under
the `multiHarness` key, with defaults applied and the result validated. Unknown keys are
warned about, not fatal.

```yaml
multiHarness:
  enabled: true

  codex:
    enabled: true
    executable: codex
    timeoutMs: 1800000        # 30 min
    model: null               # null → the user's ~/.codex/config.toml decides. Set to pass `-m`.
    additionalDirs: []

  claude:
    enabled: true
    executable: claude
    timeoutMs: 1800000
    model: null               # null → the user's Claude Code config decides. Set to pass `--model`.
    acceptEdits: false        # true → --permission-mode acceptEdits for write runs
    additionalDirs: []

  routing:
    default: auto             # auto | codex | claude
    mode: model               # model | rules  — how `auto` decides
    model: "@smol"            # router model: role alias, "provider/id", or bare id
    modelFallbacks:           # tried in order when `model` does not resolve
      - anthropic/claude-haiku-4-5
      - openai/gpt-5.2-mini
      - google/gemini-2.5-flash
    modelTimeoutMs: 5000      # router call budget; on timeout → rules
    modeMap:                  # the rule table (also the fallback for mode: model)
      plan: claude
      analyze: claude
      review: claude
      implement: codex
      debug: codex
      test: codex
    promptGuidance: true      # inject routing guidance into the system prompt

  sessions:
    persist: true

  concurrency:
    maxConcurrentRuns: 4
    allowParallelReads: true
    allowParallelWrites: false    # per workspace; different cwd is always allowed
    writerQueue: true             # false → reject with WORKSPACE_BUSY instead of waiting

  limits:
    maxOutputChars: 32000
    maxHandoffChars: 4000
    ringBufferBytes: 1048576
    killGraceMs: 5000

  debug: false                # verbose logging + keep raw event streams on disk
```

## Model selection

Three independent choices, never conflated:

| what | setting | default |
|---|---|---|
| which **worker model** Codex runs | `codex.model`, or per-call `model` | the user's `~/.codex/config.toml` |
| which **worker model** Claude runs | `claude.model`, or per-call `model` | the user's Claude Code config |
| which **router model** resolves `agent: "auto"` | `routing.model` | `@smol` |

**Precedence for worker models:** per-call `model` argument → `multiHarness.<agent>.model` →
the CLI's own config. When none is set, **no `-m` / `--model` flag is passed at all** — the
user's own CLI configuration decides, which is the default this project promises.

A per-call model is validated as a plain token (`^[A-Za-z0-9._:@\/-]{1,120}$`) before it
reaches argv. It is a CLI argument, not a shell string, but the check keeps garbage out of
error messages and logs.

## Router model (`routing.mode: model`)

`auto` resolves to an agent with **one small classification call** through OMP's own model
facade (`ctx.models.resolve(spec)`) — not a second agent turn, not a nested tool loop.

- Input: the task text (capped at 1 000 chars), the `mode` if given, and the one-line
  capability summary of each agent.
- Output: a single token, `codex` or `claude`. Anything else counts as a failure.
- Budget: `routing.modelTimeoutMs` (default 5 s), one attempt, no retry.
- **Any** failure — unresolvable model, timeout, unauthenticated OMP, unparseable answer —
  falls back silently to `modeMap` rules and records `metadata.routedBy: "rules"`.
- `routing.mode: rules` skips the call entirely. Cost-sensitive users set this.
- The chosen agent and `routedBy` are always reported in the result, so routing is never a
  black box.

**Why `@smol` is the default.** It is OMP's own "fast/cheap model" role alias, so the router
uses whatever the user already configured as their small model instead of a hard-coded
vendor choice, and it costs a fraction of a cent per route. When no `smol` role is
configured, `modelFallbacks` picks the first authenticated model in the list — Claude Haiku
4.5 first, since it is fast, cheap, and reliable at single-token classification. Routing is
a one-word decision; spending a frontier model on it is waste, and the supervisor can
always override the router by calling `ask_codex` / `ask_claude` directly.

## Rules

- **No other model-specific settings.** Authentication always comes from each CLI itself.
- `enabled: false` on an agent → its tool and command are still registered but return a
  clear "disabled in config" tool error (so the supervisor gets a useful message instead
  of a missing tool).
- `multiHarness.enabled: false` → the extension registers nothing beyond `/agents`, which
  reports that it is disabled.

## Working directory rules

1. Default cwd = the OMP session's current project directory (`ctx.cwd`).
2. An explicit `cwd` argument is resolved, realpath-normalized, and must be **inside the
   OMP workspace** (cwd or a configured `--add-dir` root). Otherwise → error; never
   silently run against another repository.
3. The path must exist and be a directory before spawning.
4. Symlink escapes are caught by comparing realpaths, not strings.
