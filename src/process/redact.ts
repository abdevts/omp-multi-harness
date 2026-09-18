/**
 * Redaction for anything that might reach a log line, an error message, a status line, or a
 * persisted session file. See _spec/10-errors-and-security.md ("Logging", "Security
 * requirements (hard)").
 *
 * Every pattern here is a false-negative-averse guess, not a credential validator — we would
 * rather redact a git SHA that merely looks key-shaped than let a real key through. Patterns
 * are ordered so that wider matches (PEM blocks, header lines) run before narrower token
 * matches, and the placeholder text is chosen so it never re-matches any pattern below —
 * that's what makes `redact` idempotent.
 */

const PLACEHOLDER = "[REDACTED]";

/**
 * Applied in order. Each is a standalone RegExp (not a matchAll accumulator) so one giant
 * alternation doesn't become an unreadable, unmaintainable regex — and so PEM blocks (which
 * span lines) can run before line-oriented patterns without them fighting over the same text.
 * `replacement` is passed straight to String#replace, so `$1` etc. refer to that pattern's own
 * capture groups.
 */
const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
	// PEM private key blocks — widest match first, multiline.
	{ re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replacement: PLACEHOLDER },
	// `Authorization: <anything>` header lines — redact the whole value, not just a token shape.
	{ re: /authorization\s*:\s*\S+(?:\s+\S+)?/gi, replacement: PLACEHOLDER },
	// Explicit bearer tokens outside a header line (e.g. logged as `token=Bearer xyz`).
	{ re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: PLACEHOLDER },
	// OpenAI/Anthropic-style secret keys: sk-..., sk-ant-..., sk-proj-..., etc.
	{ re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{10,}/g, replacement: PLACEHOLDER },
	// GitHub tokens: ghp_/gho_/ghu_/ghs_ (36 chars) and the newer github_pat_ format.
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: PLACEHOLDER },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: PLACEHOLDER },
	// AWS access key id.
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: PLACEHOLDER },
	// Google API key.
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: PLACEHOLDER },
	// JWT: three base64url segments joined by dots. Segment length floor keeps this from
	// matching short dotted things like semver (1.20.5) — see redaction.test.ts for the
	// false-positive trade-offs we accept.
	{ re: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: PLACEHOLDER },
	// Shell-style assignments: KEY=..., API_TOKEN=..., DB_SECRET=..., MY_PASSWORD=...
	// Value is everything up to whitespace/quote-close — redact the whole RHS, never just a
	// prefix, since we don't know the value's shape ahead of time. Keep the key name ($1):
	// which var leaked matters for debugging, the value never does.
	{ re: /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, replacement: `$1=${PLACEHOLDER}` },
];

/**
 * Replace anything that looks like a credential with a stable placeholder. Never throws:
 * empty strings, huge strings, and lone surrogates all fall through untouched or redacted,
 * never raise.
 *
 * Idempotent by construction — `PLACEHOLDER` contains no `-`, `_`, `=`, or `.` runs long
 * enough to satisfy any pattern above, so redacting its own output is a no-op.
 */
export function redact(text: string): string {
	if (!text) return text;
	let out = text;
	for (const { re, replacement } of PATTERNS) out = out.replace(re, replacement);
	return out;
}

/**
 * Redact and cap length, for stderr/stdout tails — the main leak path in this codebase (a
 * CLI's own error output routinely echoes back flags, env, or partial request bodies). Cuts
 * from the front and keeps the tail, matching how `RingBuffer` in spawn-agent.ts already
 * thinks about truncation, so a snippet always shows the most recent, most relevant lines.
 */
export function redactTail(text: string, maxChars = 500): string {
	if (!text) return text;
	const redacted = redact(text);
	return redacted.length > maxChars ? `…${redacted.slice(redacted.length - maxChars)}` : redacted;
}

/**
 * Allowlist, not denylist: a denylist over env var *names* fails open — any secret handed to
 * the child under an unanticipated name (CUSTOM_API_SECRET, VENDOR_X_CRED, a typo'd variant)
 * would sail straight through. An allowlist of known-harmless names can only fail closed:
 * worst case we under-log, never leak. Keep this list short and boring.
 */
const ENV_ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TMPDIR",
	"TZ",
	"NODE_ENV",
	"CI",
	"USER",
	"LOGNAME",
	"EDITOR",
	"VISUAL",
	"COLORTERM",
]);

export interface RedactedEnv {
	/** Allowlisted vars that were present, verbatim. */
	kept: Record<string, string>;
	/** How many vars existed but were not on the allowlist — count only, never their names or values. */
	omitted: number;
}

/** Safe-to-log view of an environment object. See ENV_ALLOWLIST for the "why allowlist" note. */
export function redactEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): RedactedEnv {
	const kept: Record<string, string> = {};
	let omitted = 0;
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (ENV_ALLOWLIST.has(name)) kept[name] = value;
		else omitted++;
	}
	return { kept, omitted };
}
