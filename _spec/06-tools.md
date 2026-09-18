# 06 — Tools

Registered with `pi.registerTool(...)`. Schemas use `pi.zod` (OMP's Zod-compatible builder
backed by omptype). Tools must be registered during the load phase; runtime actions happen
inside `execute`.

## Shared result shape

Every tool returns a **compact** result. Never dump raw JSON event streams into OMP
context.

```text
[codex · implement · 2m14s · session 0f3a…]
<final agent output, truncated at 32k with a marker>

changed: 3 files · tools: 24 · read-only: no
```

`details` (not shown to the model as text) carries `{ runId, agent, sessionId, exitCode,
durationMs, readOnlyEnforced, truncated, model?, routedBy? }` so state survives session reconstruction
(OMP state-management pattern: state lives in tool-result `details`).

## `ask_codex` / `ask_claude`

Identical schemas; the agent is fixed by the tool.

```ts
{
  task: string;                    // required
  mode?: "analyze"|"plan"|"implement"|"debug"|"review"|"test";
  context?: string;                // compact handoff, not a transcript
  continueSession?: boolean;       // default true — reuse this OMP session's worker session
  readOnly?: boolean;              // default from mode
  background?: boolean;            // default false — see below
  cwd?: string;                    // default: the OMP session cwd; must be inside the workspace
  model?: string;                  // per-call worker model override (see spec 09)
  timeoutMs?: number;
}
```

- `background: false` (default) — awaits the run and returns the final output.
- `background: true` — returns immediately with
  `{ runId, status: "running" }`; the supervisor collects the result later via
  `agent_runs`, and the user can watch it in `/sessions`. This is what makes parallel
  delegation possible (see 08).

`promptSnippet` / `promptGuidelines` are set so the tools appear in the system prompt with
routing guidance (see 08 in the brief / `src/routing/prompt.ts`). Guideline bullets are
appended flat with no tool-name prefix, so **each bullet must name its tool explicitly**
("Use ask_codex when…", never "Use this tool when…").

## `delegate`

Higher-level routing entry point, mainly for commands/API use — the OMP model already does
semantic routing itself.

```ts
{
  agent: "codex" | "claude" | "auto";
  task: string;
  mode?: AgentMode;
  context?: string;
  continueSession?: boolean;
  readOnly?: boolean;
  background?: boolean;
  model?: string;
}
```

`"auto"` resolves via the **router model** (`routing.mode: model`, default) — one small
classification call through `ctx.models`, budgeted and non-recursive — falling back to the
**rule table** on any failure, or always when `routing.mode: rules`. See spec 09 §Router
model. The result always reports `metadata.routedBy: "model" | "rules" | "explicit"` and
the agent chosen. If the chosen agent is unavailable, fall back to the other one and say so.

Rule table (also the router's fallback):

| mode | agent |
|---|---|
| `plan`, `analyze`, `review` | claude |
| `implement`, `debug`, `test` | codex |

## `agent_runs`

Lets the supervisor manage parallel work without the user having to drive `/sessions`.

```ts
{
  action: "list" | "status" | "result" | "cancel" | "wait";
  runId?: string;         // required for status/result/cancel/wait
  waitMs?: number;        // for "wait": cap, default 60_000
}
```

- `list` → compact table of runs for this OMP session: id, agent, mode, status, elapsed,
  one-line task summary.
- `status` → one run's status + last progress phase, no output body.
- `result` → final output of a finished run (same shape as `ask_*`); errors if still running.
- `cancel` → aborts the run; always succeeds idempotently.
- `wait` → resolves when the run finishes or `waitMs` elapses (returns `status` either
  way). Lets the supervisor fan out N runs and then join them.

## Tool errors

A failed run returns a **tool error with an actionable message** (10), not a thrown
exception. A missing executable, auth failure, timeout, cancellation, malformed output, or
non-zero exit must never crash OMP.
