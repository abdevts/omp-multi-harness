# Phase 5 — Supervisor Guidance  (T-501 … T-507)

**Goal:** the OMP model routes sensibly on its own, and can manage parallel work without
the user driving `/sessions`.

Spec: [06](../_spec/06-tools.md).

## Tasks

### T-501 — `tools/delegate.ts`
`agent: "codex" | "claude" | "auto"`. `auto` resolves via the router (T-506) with the mode
map as fallback and `routing.default` as final tiebreak. Always reports
`metadata.routedBy: "model" | "rules" | "explicit"`.

### T-506 — Router model (`routing/router.ts`)
`routing.mode: model` (default): one classification call through `ctx.models.resolve(spec)`
using `routing.model` (default `@smol`) and `routing.modelFallbacks`. Task text capped at
1 000 chars, single token answer (`codex` | `claude`), `routing.modelTimeoutMs` budget
(default 5 s), one attempt, **no retry and no recursion** — this is never a second agent
turn. Any failure (unresolvable model, timeout, unauthenticated OMP, junk answer) falls
back silently to the rule table.

**DoD:** tests for model-answer parsing, timeout → rules, unresolvable model → fallback
chain → rules, and `routing.mode: rules` skipping the call entirely.

### T-507 — Worker model overrides
Per-call `model` argument and `--model` flag on `/codex` / `/claude`, over
`multiHarness.<agent>.model`, over the CLI's own config (which stays the default — no
`-m`/`--model` is passed when nothing is set). Validate the token before it reaches argv.

### T-502 — `tools/agent-runs.ts`
`list | status | result | cancel | wait`. This is what lets the supervisor fan out several
background runs and then join them.

### T-503 — Routing guidance
**OMP has no `promptSnippet` / `promptGuidelines` on `ToolDefinition`** (verified 18.2.6 —
those are upstream pi fields). Guidance therefore lives in each tool's `description`, which
is already written that way. If more is needed, use OMP's system-prompt-customization
surface — do not invent tool fields.

Guidance content (preferences, not rules):

```text
Codex   → implementation, debugging, refactoring, tests, repository modification,
          targeted code review.
Claude  → architecture analysis, planning, design review, broad repository reasoning,
          second opinions, conceptual risk.

For hard tasks consider: Claude plans → Codex implements → Claude reviews read-only →
Codex fixes. Do not delegate trivial work. Do not invoke both agents when one suffices.
Prefer a read-only review before giving another agent write access.
Use background runs when two tasks are genuinely independent; join them with agent_runs.
```

Configurable via `routing.promptGuidance: false`.

### T-504 — Availability-aware fallback
If the preferred agent is unavailable or disabled, `delegate` falls back to the other and
says so in the result rather than failing.

### T-505 — Routing behavior checks
Scripted checks (not assertions on model output, but recorded manual runs):
"Implement this endpoint." → Codex. "Review whether this architecture will scale." →
Claude. Confirm the supervisor is **not** forced into a fixed four-step workflow.

## Exit criteria

Spec-12 **E** passes.
