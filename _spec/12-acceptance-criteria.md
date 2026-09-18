# 12 — MVP Acceptance Criteria

The MVP is complete when every item passes. Each maps to a task id in `_plan/PROGRESS.md`.

| # | Criterion | Verified by |
|---|---|---|
| A | **Extension loads.** `omp -e ./src/index.ts` starts cleanly; `omp` with the extension installed starts cleanly; no startup errors with either agent missing. | manual + smoke test |
| B | **Agent detection.** `/agents` correctly reports presence, path, version, and status for `codex` and `claude`, and degrades gracefully when one is absent. | unit + manual |
| C | **Direct Codex delegation.** `/codex inspect this repository and summarize its architecture` runs the installed Codex CLI and returns its answer in OMP. | manual |
| D | **Direct Claude delegation.** Same via `/claude`. | manual |
| E | **Tool invocation.** The OMP supervisor autonomously calls `ask_codex` / `ask_claude` through ordinary tool calling. | manual |
| F | **Native auth preserved.** No API key required by the extension; existing CLI logins are used; no credential file is read. | code review + test |
| G | **CWD preserved.** Workers operate against the repo OMP is running in; an out-of-workspace cwd is rejected. | unit + manual |
| H | **Errors don't crash OMP.** Missing executable, auth failure, cancellation, malformed output, timeout, and non-zero exit all produce controlled tool errors. | unit |
| I | **Concurrent writes prevented.** Two write-capable runs cannot modify the same working tree simultaneously; the second waits (or returns `WORKSPACE_BUSY`). | unit |
| J | **Session continuation.** Native resume works for at least one agent; the other falls back cleanly to a fresh session with compact handoff context. | unit + manual |
| **K** | **Parallel runs.** Two or more delegated runs execute concurrently (e.g. read-only Claude review while Codex implements in another repo, or two background reads), and both complete correctly. | unit + manual |
| **L** | **`/sessions` works.** Lists running and finished runs with status and elapsed time; attach shows live output; focus switches between runs without pausing any; cancel terminates the selected run and releases its lock. | manual |
| M | **No leaks.** Ending the OMP session terminates every child process and its descendants; no zombies, no orphaned locks. | unit + manual |
| N | **Secrets never logged.** Redaction test passes with `debug: true` and `debug: false`. | unit |
