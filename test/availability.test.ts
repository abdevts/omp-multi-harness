import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { clearAvailabilityCache, detect, isReady } from "../src/agents/availability.ts";
import { DEFAULTS } from "../src/config/schema.ts";

const BIN = join(import.meta.dir, "fixtures", "bin");
const REPO = join(import.meta.dir, "..");
const env = { ...process.env, PATH: BIN };

beforeEach(() => clearAvailabilityCache());

describe("detect", () => {
	test("codex: reads the auth line from STDERR, where the real CLI writes it", async () => {
		const a = await detect("codex", DEFAULTS.codex, { cwd: REPO, env, force: true });
		expect(a.available).toBe(true);
		expect(a.version).toBe("codex-cli 9.9.9");
		expect(a.auth).toBe("ok");
		expect(a.authDetail).toBe("Logged in using ChatGPT");
		expect(isReady(a)).toBe(true);
	});

	test("claude: reports auth without leaking the email or org from the payload", async () => {
		const a = await detect("claude", DEFAULTS.claude, { cwd: REPO, env, force: true });
		expect(a.auth).toBe("ok");
		expect(a.authDetail).toBe("logged in via claude.ai");

		const serialized = JSON.stringify(a);
		expect(serialized).not.toContain("secret@example.com");
		expect(serialized).not.toContain("org_SECRET");
		expect(serialized).not.toContain("Secret Org");
	});

	test("logged out is detected, not mistaken for a missing CLI", async () => {
		const loggedOutEnv = { ...env, FAKE_LOGGED_OUT: "1" };
		const codex = await detect("codex", DEFAULTS.codex, { cwd: REPO, env: loggedOutEnv, force: true });
		expect(codex.available).toBe(true);
		expect(codex.auth).toBe("logged-out");
		expect(codex.authDetail).toContain("codex login");
		expect(isReady(codex)).toBe(false);
	});

	test("missing executable is unavailable with a reason, not a throw", async () => {
		const a = await detect("codex", DEFAULTS.codex, { cwd: REPO, env: { PATH: "/nonexistent" }, force: true });
		expect(a.available).toBe(false);
		expect(a.reason).toContain("not found on PATH");
	});

	test("disabled in config is reported as such and never spawns anything", async () => {
		const a = await detect("claude", { ...DEFAULTS.claude, enabled: false }, { cwd: REPO, env, force: true });
		expect(a.available).toBe(false);
		expect(a.reason).toContain("disabled in config");
	});

	test("results are cached until cleared", async () => {
		const first = await detect("codex", DEFAULTS.codex, { cwd: REPO, env, force: true });
		const cached = await detect("codex", DEFAULTS.codex, { cwd: REPO, env: { PATH: "/nonexistent" } });
		expect(cached).toBe(first);
		clearAvailabilityCache();
		const fresh = await detect("codex", DEFAULTS.codex, { cwd: REPO, env: { PATH: "/nonexistent" } });
		expect(fresh.available).toBe(false);
	});

	test("skipAuth avoids the auth probe", async () => {
		const a = await detect("codex", DEFAULTS.codex, { cwd: REPO, env, force: true, skipAuth: true });
		expect(a.available).toBe(true);
		expect(a.auth).toBe("unknown");
		expect(a.authDetail).toBe("not checked");
	});
});
