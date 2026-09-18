import { describe, expect, test } from "bun:test";
import {
	authRequired,
	fromSpawnError,
	invalidOutput,
	processFailed,
	providerLimit,
} from "../src/process/process-error.ts";
import { redact, redactEnv, redactTail } from "../src/process/redact.ts";

// Only ever obviously-fake secrets below — never a real credential shape from a real vendor.
const FAKE_SECRETS = {
	openai: "sk-FAKE0000000000000000000000000000000000",
	anthropic: "sk-ant-FAKE00000000000000000000000000000000000000",
	ghp: "ghp_FAKE0000000000000000000000000000",
	ghPat: "github_pat_FAKE00000000000000000000_0000000000000000000000000000000000000000000000000000000000000000000",
	aws: "AKIAFAKEFAKEFAKEFAKE",
	google: "AIzaFAKE0FAKE0FAKE0FAKE0FAKE0FAKE0FAKE0",
	jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.FAKEsignature000000000000000",
	bearer: "Bearer FAKE0000000000000000000000000000",
	authHeader: "Authorization: Bearer FAKE0000000000000000000000",
	pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEfakefakefakefakefakefakefakefake==\n-----END RSA PRIVATE KEY-----",
};

describe("redact — each token shape, in isolation", () => {
	test.each(Object.entries(FAKE_SECRETS))("redacts %s", (_name, secret) => {
		const out = redact(secret);
		expect(out).not.toContain(secret);
		expect(out).toContain("[REDACTED]");
	});
});

describe("redact — embedded in realistic multi-line stderr", () => {
	test("codex-style crash dump", () => {
		const stderr = [
			"Error: request failed",
			`  Authorization: Bearer ${FAKE_SECRETS.openai}`,
			`  OPENAI_API_KEY=${FAKE_SECRETS.openai}`,
			"  at Client.request (client.js:42)",
			"  cwd: /Users/dev/project",
		].join("\n");
		const out = redact(stderr);
		expect(out).not.toContain(FAKE_SECRETS.openai);
		expect(out).toContain("Error: request failed");
		expect(out).toContain("at Client.request (client.js:42)");
	});

	test("claude-style env dump", () => {
		const stderr = [
			"debug: spawning with env",
			`ANTHROPIC_API_KEY=${FAKE_SECRETS.anthropic}`,
			`GITHUB_TOKEN=${FAKE_SECRETS.ghp}`,
			"PATH=/usr/bin:/bin",
		].join("\n");
		const out = redact(stderr);
		expect(out).not.toContain(FAKE_SECRETS.anthropic);
		expect(out).not.toContain(FAKE_SECRETS.ghp.replace("ghp_", "")); // full token gone too
		expect(out).toContain("PATH=/usr/bin:/bin"); // ordinary var untouched
	});

	test("PEM block spanning multiple lines inside a larger dump", () => {
		const stderr = `loading key\n${FAKE_SECRETS.pem}\nkey loaded`;
		const out = redact(stderr);
		expect(out).not.toContain("MIIFAKE");
		expect(out).toContain("loading key");
		expect(out).toContain("key loaded");
	});
});

describe("redact — idempotency", () => {
	test.each(Object.entries(FAKE_SECRETS))("redacting %s twice equals redacting once", (_name, secret) => {
		const once = redact(secret);
		const twice = redact(once);
		expect(twice).toBe(once);
	});

	test("idempotent over a realistic multi-secret blob", () => {
		const blob = Object.values(FAKE_SECRETS).join("\n");
		const once = redact(blob);
		const twice = redact(once);
		expect(twice).toBe(once);
	});
});

describe("redact — no false positives on ordinary text", () => {
	test("git SHAs pass through untouched", () => {
		const sha = "e359ed6e359ed6e359ed6e359ed6e359ed6e359";
		expect(redact(`commit ${sha}`)).toContain(sha);
	});

	test("semver-shaped dotted numbers pass through", () => {
		expect(redact("upgraded to 1.20.5")).toContain("1.20.5");
	});

	test("plain prose and code are untouched", () => {
		const code = "const total = a.reduce((sum, x) => sum + x.value, 0);";
		expect(redact(code)).toBe(code);
	});

	test("ordinary KEY-less assignments are untouched", () => {
		expect(redact("count=42")).toBe("count=42");
	});

	// Trade-off we accept: a long base64 chunk embedded in prose with no surrounding dots
	// or key markers is NOT flagged — only base64url text that already has JWT's three-dot
	// shape, a key-name prefix, or a known vendor prefix trips the redactor. A bare base64
	// blob (e.g. a pasted image chunk) looks statistically identical to "some encoded data"
	// and flagging it would make ordinary debug output unreadable for little safety gain.
	test("a bare base64 chunk with no dots or key markers is not touched", () => {
		const chunk = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		expect(redact(`image data: ${chunk}`)).toContain(chunk);
	});
});

describe("redactTail", () => {
	test("redacts and truncates from the front, keeping the tail", () => {
		// A space before the key, not glued to the padding — a real stderr tail never runs a
		// key straight into adjacent prose with zero separator, and gluing them defeats the
		// `\b` word-boundary check by construction (no boundary exists between two word chars).
		const body = "x".repeat(1000) + " " + FAKE_SECRETS.openai;
		const out = redactTail(body, 50);
		expect(out.length).toBeLessThanOrEqual(51); // 50 + ellipsis
		expect(out).not.toContain(FAKE_SECRETS.openai);
	});

	test("short input is redacted but not truncated", () => {
		expect(redactTail("hello world", 500)).toBe("hello world");
	});

	test("never throws on empty string, huge string, or lone surrogates", () => {
		expect(() => redactTail("")).not.toThrow();
		expect(() => redact("")).not.toThrow();
		expect(() => redact("x".repeat(2_000_000))).not.toThrow();
		expect(() => redact("\uD800")).not.toThrow(); // lone high surrogate
		expect(() => redact("\uDC00")).not.toThrow(); // lone low surrogate
		expect(() => redactTail("𐀀 normal text " + FAKE_SECRETS.openai)).not.toThrow();
	});
});

describe("redactEnv — allowlist, not denylist", () => {
	test("keeps only allowlisted vars", () => {
		const { kept, omitted } = redactEnv({
			PATH: "/usr/bin:/bin",
			HOME: "/home/user",
			OPENAI_API_KEY: FAKE_SECRETS.openai,
			CUSTOM_VENDOR_SECRET: "whatever-shape-this-has",
			SOME_UNANTICIPATED_NAME: "still not logged",
		});
		expect(kept).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/user" });
		expect(omitted).toBe(3);
	});

	test("an unrecognized secret-shaped var name is dropped, not pattern-matched", () => {
		// Proves the allowlist works on NAME, not on sniffing the value — a name the list has
		// never seen is dropped outright, which is the point: it fails closed even when our
		// value-sniffing patterns in `redact` would have missed it.
		const { kept, omitted } = redactEnv({ WEIRDLY_NAMED_CRED_THING: "sk-should-never-appear" });
		expect(kept).toEqual({});
		expect(omitted).toBe(1);
	});

	test("empty env yields empty kept and zero omitted", () => {
		expect(redactEnv({})).toEqual({ kept: {}, omitted: 0 });
	});

	test("undefined values are skipped, not counted as omitted", () => {
		const { kept, omitted } = redactEnv({ PATH: "/usr/bin", GHOST: undefined });
		expect(kept).toEqual({ PATH: "/usr/bin" });
		expect(omitted).toBe(0);
	});
});

describe("AgentError factories redact their stderr tail", () => {
	test("authRequired", () => {
		const e = authRequired("codex", `login failed\nAuthorization: Bearer ${FAKE_SECRETS.openai}`);
		expect(e.message).not.toContain(FAKE_SECRETS.openai);
		expect(e.stderrTail).not.toContain(FAKE_SECRETS.openai);
	});

	test("processFailed", () => {
		const e = processFailed("claude", 1, `crash: ${FAKE_SECRETS.anthropic}`);
		expect(e.message).not.toContain(FAKE_SECRETS.anthropic);
		expect(e.stderrTail).not.toContain(FAKE_SECRETS.anthropic);
	});

	test("providerLimit", () => {
		const e = providerLimit("codex", `out of credits, key ${FAKE_SECRETS.openai} suspended`);
		expect(e.message).not.toContain(FAKE_SECRETS.openai);
	});

	test("invalidOutput", () => {
		const e = invalidOutput("claude", `raw fragment: ${FAKE_SECRETS.jwt}`);
		expect(e.message).not.toContain(FAKE_SECRETS.jwt);
	});

	test("fromSpawnError keeps the cause but redacts the message", () => {
		const err = Object.assign(new Error(`spawn failed: ${FAKE_SECRETS.aws}`), { code: "EPIPE" });
		const e = fromSpawnError("codex", "codex", err as NodeJS.ErrnoException);
		expect(e.message).not.toContain(FAKE_SECRETS.aws);
		expect(e.cause).toBe(err); // cause is preserved for debugging, only .message is user-facing
	});

	test("existing remediation text and error codes are untouched by redaction", () => {
		// Regression guard for the spec's "never change codes/signatures/remediation" rule.
		expect(authRequired("claude").code).toBe("AUTH_REQUIRED");
		expect(authRequired("claude").message).toContain("claude auth login");
		expect(processFailed("codex", 3).code).toBe("PROCESS_FAILED");
	});
});

describe("regression guard — no fake secret literal survives into any built error message", () => {
	const allFakes = Object.values(FAKE_SECRETS);

	test("sweep every AgentError factory that accepts CLI-derived text", () => {
		const errors = [
			authRequired("codex", `boom ${FAKE_SECRETS.openai} ${FAKE_SECRETS.pem}`),
			processFailed("claude", 1, `boom ${FAKE_SECRETS.ghp} ${FAKE_SECRETS.jwt}`),
			providerLimit("codex", `boom ${FAKE_SECRETS.google} ${FAKE_SECRETS.authHeader}`),
			invalidOutput("claude", `boom ${FAKE_SECRETS.aws} ${FAKE_SECRETS.bearer}`),
			fromSpawnError("codex", "codex", Object.assign(new Error(`boom ${FAKE_SECRETS.ghPat}`), { code: "EPIPE" })),
		];

		for (const e of errors) {
			for (const secret of allFakes) {
				expect(e.message.includes(secret)).toBe(false);
				if (e.stderrTail) expect(e.stderrTail.includes(secret)).toBe(false);
			}
		}
	});
});
