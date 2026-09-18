# 00 — Overview

## Objective

An OMP extension that turns OMP into a **supervisor/orchestrator** delegating work to two
already-installed, already-authenticated coding agents:

- OpenAI Codex CLI — `codex`
- Anthropic Claude Code CLI — `claude`

## Architecture

```text
                        OMP  (supervisor agent)
                              │
      ┌──────────────┬────────┴────────┬──────────────┐
      ▼              ▼                 ▼              ▼
  ask_codex      ask_claude        delegate      agent_runs
      │              │                 │              │
      └──────┬───────┘                 │              │
             ▼                         ▼              ▼
       Run Registry  ◄────────── routing rules   list/status/
     (parallel runs)                             cancel/result
             │
   ┌─────────┴─────────┐
   ▼                   ▼
codex CLI          claude CLI
   │                   │
existing Codex     existing Claude
auth + config      auth + config
```

**OMP owns:** routing, orchestration, tool invocation, high-level conversation context,
run lifecycle, presentation.

**Codex / Claude own:** their authentication, agent loop, repository exploration, model
interaction, native tools, native session state.

## Hard constraints (MUST NOT)

1. Extract, read, or reuse OAuth tokens from either CLI.
2. Call undocumented OpenAI or Anthropic endpoints.
3. Impersonate either CLI's authentication.
4. Require `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.
5. Reimplement Codex or Claude Code internally.
6. Use `shell: true` or string interpolation to build commands.
7. Enable permission-bypass flags by default
   (`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-skip-permissions`).

## Design principles

- **CLI boundary.** `codex` and `claude` are external agent runtimes reached only through
  their documented non-interactive entry points (`codex exec`, `claude -p`).
- **OMP supervises, does not execute.** OMP may do lightweight work itself; specialist
  work is delegated. The supervisor workflow (plan → implement → review → fix) is
  *guidance*, never hard-coded.
- **Do not duplicate context.** Send the task, constraints, cwd, optional handoff context,
  and a prior worker session id. Never the full OMP transcript.
- **Parallel by design.** Multiple delegated runs may execute concurrently; the user can
  list, watch, switch between, and cancel them from `/sessions`. Writes to the same
  working tree are still serialized (see 08).

## Project shape

Standalone OMP extension, TypeScript, loaded by OMP's Bun-based extension loader.

```text
omp-multi-harness/
├── package.json
├── tsconfig.json
├── README.md
├── _spec/                     # this specification
├── _plan/                     # phased implementation plan + progress tracking
└── src/
    ├── index.ts               # ExtensionAPI factory (default export)
    ├── agents/                # types.ts, codex.ts, claude.ts
    ├── process/               # spawn-agent.ts, process-error.ts, executable.ts
    ├── runs/                  # registry.ts, run.ts, lock.ts, types.ts
    ├── sessions/              # store.ts, types.ts, paths.ts
    ├── tools/                 # ask-codex.ts, ask-claude.ts, delegate.ts, agent-runs.ts
    ├── commands/              # codex.ts, claude.ts, agents.ts, sessions.ts
    ├── routing/               # prompt.ts
    └── config/                # schema.ts, load.ts
```

Do not modify OMP itself unless the extension API proves insufficient. Prefer public
`@oh-my-pi/pi-coding-agent` exports over deep internal imports.
