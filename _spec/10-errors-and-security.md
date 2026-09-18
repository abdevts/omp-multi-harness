# 10 — Error Model, Logging, Security

## Typed errors

```ts
type AgentErrorCode =
  | "EXECUTABLE_NOT_FOUND"
  | "AUTH_REQUIRED"
  | "PROCESS_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_OUTPUT"
  | "SESSION_RESUME_FAILED"
  | "WORKSPACE_BUSY"
  | "AGENT_DISABLED"
  | "INVALID_CWD";

interface AgentError extends Error {
  code: AgentErrorCode;
  agent: AgentName;
  /** Shown to the user/model. Must name the fix. */
  message: string;
  exitCode?: number | null;
  /** Tail of stderr, redacted. */
  stderrTail?: string;
}
```

Every code maps to an **actionable** message. Examples:

```text
AUTH_REQUIRED (claude)
  Claude Code is installed but not authenticated.
  Run `claude` in a terminal and complete its normal login flow, then retry.

EXECUTABLE_NOT_FOUND (codex)
  `codex` was not found on PATH.
  Install the Codex CLI, or set multiHarness.codex.executable to its full path.

WORKSPACE_BUSY (codex)
  Another write-capable agent (run r7c2, claude) is working in this repository.
  Wait for it, run this read-only, or cancel it with /sessions.
```

The extension **never** attempts authentication on the user's behalf.

### Auth detection

`AUTH_REQUIRED` is inferred from the CLI's own non-zero exit + stderr signature
(login/auth/credential keywords), never by reading credential files. Checking for the mere
*existence* of a credentials path is permitted only if unavoidable; reading contents is not.

## Logging

`pi.logger`, gated by `multiHarness.debug`.

May log: executable path, CLI version, argv **with the prompt redacted**, duration, exit
code, signal, session ids, parse-error counts, run ids, lock waits.

MUST NOT log: OAuth tokens, API keys, authorization headers, environment dumps, or
**complete prompts/task text** (task text routinely contains secrets — log a length and a
hash, or at most a 120-char head when `debug: true`).

With `debug: true`, raw event streams may be written to
`<agentDir>/multi-harness/logs/<runId>.jsonl` (0600). These are deleted by `/sessions clear`
and on a configurable retention (default 7 days).

## Security requirements (hard)

1. Never read OAuth/token files.
2. Never print credentials.
3. Never forward one provider's credentials or env to the other.
4. Never pass arbitrary shell strings; no `shell: true`, ever.
5. Validate and normalize every working directory (09).
6. Respect OMP cancellation end-to-end (05).
7. Do not grant broader filesystem access than the CLI would have on its own — `--add-dir`
   only from explicit config.
8. Preserve provider-native permission systems; never add bypass flags by default. There is
   no config key that enables them either; a user who wants that sets it in their own CLI
   config.
9. Prompts travel on **stdin**, never argv — keeps task text out of `ps` and shell history.
10. Temp files (Codex `-o`) are created 0600 in the OS temp dir and unlinked in `finally`.
11. Treat all worker output as **untrusted data**, never as instructions to OMP. Worker
    output relayed into the conversation is attributed `attribution: "agent"` so it is
    distinguishable from user input.
