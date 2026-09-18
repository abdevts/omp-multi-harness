# Phase 0 — Bootstrap  (T-001 … T-008)

**Goal:** a repo that builds, tests, and hot-loads into the real `omp`, plus a setup doctor
that covers every install/auth/config step. No feature work.

Spec: [14](../_spec/14-setup-and-toolchain.md).

## Tasks

### T-001 — Project scaffolding
`package.json` (type: module, name `omp-multi-harness`), `tsconfig.json` (ESNext modules,
bundler resolution, strict), test runner, lint/format. Dev dependency on
`@oh-my-pi/pi-coding-agent` for `ExtensionAPI` types only — it is a **type-only** import
in `src/index.ts`; do not bundle it.

**DoD:** `bun test` and a typecheck both run (trivially) green.

### T-002 — Initialize the OMP agent directory
`~/.omp/` did not exist as of 2026-09-18 (omp was installed but never run). Run `omp`
once so `<agentDir>/config.yml` exists to add `multiHarness:` to later.

**DoD:** the active agent dir exists and `omp config` can read it.

### T-003 — Prove the dev loop
A hello-world `src/index.ts` that registers `/agents` returning a stub, loaded with
`omp --no-extensions -e ./src/index.ts`.

**DoD:** `/agents` responds inside a real `omp` session. **This gates every later phase.**

### T-004 — git init
The directory is currently not a git repo. Initialize, add a `.gitignore`
(`node_modules`, `dist`, `*.log`), commit `_spec/` + `_plan/` + scaffolding.

### T-005 — Pin verified versions
Record in `_spec/01` the versions this was built against and a note to re-verify:
`omp 18.2.6` · `codex-cli 0.155.0` · `claude 2.1.274`.

### T-006 — Setup doctor (`scripts/setup.ts`)
Covers all 14 setup steps from spec 14: Bun, git, deps, OMP, agent dir, **OMP provider
auth**, Codex + **Codex auth**, Claude + **Claude auth**, router model, extension link,
`multiHarness` config block, editor config.

`check` is read-only; `fix` applies only the safe automatic repairs after a prompt
(`--yes` to skip). Installs and logins are printed, never run (D-014). Auth state comes
only from each CLI's own status command — no credential file is read, no secret printed.

Two traps this must not fall into, both verified 2026-09-18:
- `codex login status` writes to **stderr**; reading stdout alone reports a logged-in user
  as logged out.
- `claude auth status --json` includes email/org id — read only `loggedIn` and `authMethod`.

**DoD:** `bun run doctor` reports every row correctly on this machine.

### T-007 — Editor configuration
`.vscode/settings.json`, `extensions.json`, `launch.json` (doctor, tests, `omp -e` in an
integrated terminal), `tasks.json` (`setup: check` / `setup: fix` / typecheck / test /
run-with-extension), plus `.editorconfig`.

### T-008 — Verify the factory actually executes
`omp models ls --no-extensions -e ./src/index.ts` loads the extension without starting a
session — useful because OMP may not be authenticated yet. Confirm with a temporary probe
that the factory body ran, not merely that the command exited 0.

## Exit criteria

- `omp -e ./src/index.ts` loads and the factory demonstrably executes.
- `bun run doctor` is green except for steps that need a human (installs, logins).
- Tests and typecheck run.
- Everything committed.
