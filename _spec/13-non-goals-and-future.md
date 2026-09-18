# 13 — Non-Goals and Future Shape

## V1 non-goals (do not build)

Git worktree orchestration · agent voting · three or more external providers · remote
execution · Docker sandboxing · Kubernetes · web dashboard · distributed workers ·
automatic PR creation · cost accounting · token extraction · direct OpenAI/Anthropic API
integration · custom OAuth flows · model proxy · an MCP server (unless it proves necessary)
· automatic git merge · arbitrary parallel *write* agents against one tree.

Keep V1 small.

## Future: generic worker registry

Do not build this now, but do not adopt designs that block it. The adapter boundary in 02
is already this shape.

```ts
interface WorkerDescriptor {
  id: string;
  capabilities: AgentMode[];
  priority?: number;
  available(): Promise<boolean>;
  run(request: AgentRequest): Promise<AgentResult>;
}
```

Future workers: Gemini CLI, OpenCode, a local model agent, a remote SSH agent — added
without changing the OMP tool interface.

## Future: worktree mode

```text
main repository
    ├── worktree/codex
    └── worktree/claude
```

Unlocks true parallel *writers* and A/B implementations (Claude implements A, Codex
implements B, OMP compares). Cheap to add later: `codex exec --worktree` and
`claude -w/--worktree` already exist (01 §3–4). Explicitly out of scope for the MVP.

## Not ours: OMP-native session import

`omp --from-claude` / `--from-codex`, and their slash form `/resume @claude` / `/resume
@codex`, already import a Claude Code or Codex session into OMP. This is a richer handoff
than text context — and it already exists, so **this extension does not build it**. When a
user wants to pull a worker session into the conversation, point them at `/resume @codex`.
See `_plan/decisions.md` D-006 / D-011.

## Desired end-state UX

```text
User:  Refactor authentication so session persistence is separated from token validation.

OMP:   I'll have Claude examine the architecture first.        [ask_claude · review · read-only]
       → SessionRepository is coupled to token verification; AuthService owns too much;
         recommends extracting SessionService.

OMP:   I'll have Codex implement that design and run the tests. [ask_codex · implement]
       → extracted SessionService, updated AuthService and tests, suite passes.

OMP:   I'll have Claude review it read-only.                    [ask_claude · review · read-only]
       → cleaner; one concurrency concern remains.

OMP:   I'll have Codex address that.                            [ask_codex · debug]
OMP:   Implementation complete.
```

The user stays inside OMP the whole time, and can open `/sessions` at any point to watch
or cancel any of those runs.
