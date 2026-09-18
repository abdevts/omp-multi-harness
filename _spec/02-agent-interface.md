# 02 — Agent Interface

Provider-neutral. All provider-specific command construction lives in the adapter
(`src/agents/codex.ts`, `src/agents/claude.ts`) and nowhere else.

```ts
export type AgentName = "codex" | "claude";

export type AgentMode =
  | "analyze" | "plan" | "implement" | "debug" | "review" | "test";

export interface AgentRequest {
  agent: AgentName;
  task: string;
  cwd: string;
  mode?: AgentMode;
  /** Prior worker session id to resume. */
  sessionId?: string;
  /** Compact handoff context (see 12 in the brief / §Handoff below). */
  context?: string;
  timeoutMs?: number;
  /** Request provider-enforced read-only execution. */
  readOnly?: boolean;
}

export interface AgentResult {
  agent: AgentName;
  success: boolean;
  /** Final textual answer only — never the raw event stream. */
  output: string;
  sessionId?: string;
  exitCode: number | null;
  durationMs: number;
  stderr?: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalAgent {
  readonly name: AgentName;
  /** Executable resolution + `--version`, cached per process. */
  isAvailable(): Promise<AgentAvailability>;
  run(request: AgentRequest, opts: AgentRunOptions): Promise<AgentResult>;
}

export interface AgentAvailability {
  available: boolean;
  executablePath?: string;
  version?: string;
  /** Present when `available === false`. */
  reason?: string;
}

export interface AgentRunOptions {
  signal: AbortSignal;
  /** Coarse progress for UI. Never one callback per model token. */
  onProgress?: (event: AgentProgress) => void;
}

export interface AgentProgress {
  /** e.g. "starting", "inspecting repository", "running tests", "completed" */
  phase: string;
  detail?: string;
  /** Provider-native event kind, for debug logs only. */
  raw?: string;
}
```

## Result contract

- `output` is the agent's **final message**, plain text. Raw JSONL events are kept
  internally (ring buffer + optional debug log) and never returned into OMP context.
- `metadata` carries non-sensitive facts worth showing: `{ model?, turns?, toolCalls?,
  filesChanged?, readOnlyEnforced: boolean, cliVersion, truncated: boolean }`.
- `readOnlyEnforced` is **honest**: `false` when the CLI/version could not guarantee it.
  Never claim isolation that does not exist (see 10).
- Output larger than `limits.maxOutputChars` (default 32 000) is truncated from the middle
  with an explicit marker, and `metadata.truncated = true`.

## Mode → intent mapping

`mode` shapes the prompt preamble and the default `readOnly` value. It does **not** change
which model runs — the user's own CLI config decides that.

| mode | default `readOnly` | preamble intent |
|---|---|---|
| `analyze` | true | explain, do not change |
| `plan` | true | produce a plan, do not change |
| `review` | true | review, list findings, do not change |
| `implement` | false | make the change, keep it minimal |
| `debug` | false | find root cause, then fix |
| `test` | false | run/repair tests |

An explicit `readOnly` in the request always wins over the mode default.

## Handoff formatter (`src/routing/handoff.ts`)

Renders `context` into a short, fixed-shape block. Never include the OMP transcript,
unrelated tool results, or a whole-repo summary — the worker can read the repo itself.

```text
Objective:      <one line>
Relevant context: <2–5 lines>
Current state:  <what is already done / already failing>
Files likely involved:
  - path
Task:           <the actual instruction>
Constraints:    <e.g. do not change the public API>
```

Hard cap: `limits.maxHandoffChars` (default 4 000), truncated with a marker.
