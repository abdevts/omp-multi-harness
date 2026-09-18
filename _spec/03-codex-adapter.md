# 03 — Codex Adapter (`src/agents/codex.ts`)

Target: `codex-cli 0.155.0`. All Codex flags live in this file only.

## Availability

1. Resolve the executable from config (`codex.executable`, default `"codex"`) via PATH
   lookup — no shell.
2. Run `<exe> --version` with a 5 s timeout; parse `codex-cli <semver>`.
3. Cache `{available, executablePath, version}` per process; `/agents` may force-refresh.

## Invocation — new session

```text
codex exec
  --json                       # JSONL events on stdout
  -C <cwd>
  -s <read-only | workspace-write>
  -o <tmpfile>                 # final message, authoritative
  [--skip-git-repo-check]      # only when cwd is not a git repo
  -                            # prompt read from stdin
```

- **Prompt goes on stdin**, written then closed. Rationale: no prompt text in `ps`, no
  argv length limits. (§10 security requirement.)
- `-m/--model` is **omitted** unless `codex.model` is explicitly configured. The user's
  `~/.codex/config.toml` decides the model.
- Never `--dangerously-bypass-approvals-and-sandbox`, never `--dangerously-bypass-hook-trust`.
- `--add-dir` only when `codex.additionalDirs` is configured.

## Invocation — resume

```text
codex exec resume <SESSION_ID> --json -C <cwd> -s <sandbox> -o <tmpfile> -
```

On a resume failure (unknown/garbage-collected id) → surface `SESSION_RESUME_FAILED`,
then automatically retry once as a **fresh session with the handoff context prepended**,
and set `metadata.resumedFallback = true`.

## Read-only mapping

| requested | flag | `readOnlyEnforced` |
|---|---|---|
| `readOnly: true` | `-s read-only` | `true` |
| `readOnly: false` | `-s workspace-write` | `false` |

## Output parsing

Two channels, used together:

1. **`-o <tmpfile>`** — the final agent message. This is the authoritative `output`.
   Read after exit, then unlink the temp file (temp file lives in the OS temp dir with
   mode 0600).
2. **`--json` JSONL on stdout** — parsed line by line for:
   - the session / thread id → `AgentResult.sessionId`
   - coarse progress events → `onProgress` (tool starts, command execution, turn boundaries)
   - token/turn counts → `metadata`

### Event shapes captured from codex-cli 0.155.0 (2026-09-18)

```json
{"type":"thread.started","thread_id":"01a0b606-9c69-7c20-98e0-9426e6cb7bd6"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened…"}}
{"type":"error","message":"Your workspace is out of credits."}
{"type":"turn.failed","error":{"message":"Your workspace is out of credits."}}
```

So: the session id is `thread_id` on `thread.started`; turns bracket the run as
`turn.started` → `turn.completed` | `turn.failed`; work items arrive as `item.completed`
with an `item.type` (`agent_message`, `command_execution`, `file_change`, `reasoning`,
`error`, …).

Two traps:

1. **An `error` *item* is informational, not terminal** — the observed one was a truncated
   skill-description notice on an otherwise healthy run. Only a top-level `{"type":"error"}`
   or `turn.failed` ends the run.
2. **stderr is noisy on success**: Codex logs unrelated warnings (e.g. skill files with bad
   frontmatter) to stderr, so stderr must never be the failure signal. Use the events plus
   the exit code (a failed turn exits 1).

Parser rules:

- Parse **line-delimited JSON**, tolerate partial trailing lines across chunks.
- A line that does not parse is counted (`metadata.parseErrors++`), logged at debug level,
  and otherwise ignored — never fatal.
- Event *shapes* vary across Codex versions. Do not switch on exact event names; search
  each object for the first of a candidate key list:
  - session id: `session_id`, `thread_id`, `conversation_id`, `id` under a `session`/`thread` object
  - final text: `last_agent_message`, `message`, `text` on a terminal/completed event
- If `-o` produced no text, fall back to the last assistant text found in the stream; if
  that is also empty → `INVALID_OUTPUT`.
- **Never parse ANSI/interactive output.** If `--json` is unsupported by the installed
  version (detected by version or by zero parsable lines), report `INVALID_OUTPUT` with a
  message naming the detected version.

## Version compatibility

Centralize a `buildArgs(version, request)` function with a small capability table
(`supportsJson`, `supportsOutputLastMessage`, `supportsResumeSubcommand`). Unknown/newer
versions default to the newest known capability set.
