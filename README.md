# omp-multi-harness

An [OMP](https://github.com/can1357/oh-my-pi) extension that turns OMP into a supervisor
delegating work to the **Codex CLI** (`codex`) and **Claude Code CLI** (`claude`) through
their own binaries and their own existing authentication — no API keys, no token
extraction, no reimplementation.

> **Status: Phase 0 complete** — scaffolding, setup doctor, editor config, and a skeleton
> extension verified loading in `omp 18.2.6`. Feature work starts at Phase 1.
> Tracker: [`_plan/PROGRESS.md`](_plan/PROGRESS.md).

## Quick start

```bash
bun install
bun run doctor          # checks every setup step: tools, installs, all three logins, config
bun run setup fix       # applies the safe fixes (never installs or logs in for you)
bun run dev             # omp --no-extensions -e ./src/index.ts
```

Three separate logins are required and are **not** interchangeable — OMP (`omp` → `/login`),
Codex (`codex login`), and Claude Code (`claude auth login`). The extension never reads,
forwards, or stores any of them; it only reads each CLI's own status output.
See [`_spec/14-setup-and-toolchain.md`](_spec/14-setup-and-toolchain.md).

- [`_spec/`](_spec/) — normative specification (start at [`_spec/README.md`](_spec/README.md))
- [`_plan/`](_plan/) — phased implementation plan and the task tracker

Built and verified against: `omp 18.2.6` · `codex-cli 0.155.0` · `claude 2.1.274`
(see [`_spec/01-environment-findings.md`](_spec/01-environment-findings.md)).
