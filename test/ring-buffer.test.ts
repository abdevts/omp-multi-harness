import { describe, expect, test } from "bun:test";
import { createRingBuffer } from "../src/runs/ring-buffer.ts";

describe("createRingBuffer", () => {
	test("keeps everything while under the cap", () => {
		const b = createRingBuffer(1024);
		b.push("one\n");
		b.push("two\n");
		expect(b.text()).toBe("one\ntwo\n");
		expect(b.lines()).toEqual(["one", "two"]);
		expect(b.bytes).toBe(8);
		expect(b.droppedBytes).toBe(0);
	});

	test("evicts whole lines from the front, never half a line", () => {
		const b = createRingBuffer(20);
		for (const line of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) b.push(`${line}\n`);
		expect(b.bytes).toBeLessThanOrEqual(20);
		// Whatever survived starts at a line boundary.
		for (const line of b.lines()) expect(line).toMatch(/^(a{8}|b{8}|c{8})$/);
		expect(b.lines().at(-1)).toBe("cccccccc");
		expect(b.droppedBytes).toBe(9);
	});

	test("counts UTF-8 bytes, not code units", () => {
		const b = createRingBuffer(1024);
		b.push("héllo→\n"); // 1 two-byte + 1 three-byte char
		expect(b.bytes).toBe(Buffer.byteLength("héllo→\n", "utf8"));
		expect(b.bytes).toBeGreaterThan("héllo→\n".length);
	});

	test("hard-truncates a single line longer than the whole cap, at a character boundary", () => {
		const b = createRingBuffer(8);
		b.push("→→→→→→"); // 18 bytes, one line, no newline to evict on
		expect(b.bytes).toBeLessThanOrEqual(8);
		expect(b.text()).not.toContain("�");
		expect(b.text()).toBe("→→");
		expect(b.droppedBytes).toBe(12);
	});

	test("droppedBytes accumulates across evictions", () => {
		const b = createRingBuffer(16);
		let expectedDropped = 0;
		for (let i = 0; i < 20; i++) b.push(`line-${i}\n`);
		expect(b.bytes).toBeLessThanOrEqual(16);
		expect(b.droppedBytes).toBeGreaterThan(0);
		// Nothing is invented: retained + dropped equals everything pushed.
		for (let i = 0; i < 20; i++) expectedDropped += Buffer.byteLength(`line-${i}\n`, "utf8");
		expect(b.bytes + b.droppedBytes).toBe(expectedDropped);
	});

	test("lines(limit) returns the most recent lines, oldest first", () => {
		const b = createRingBuffer(4096);
		for (let i = 0; i < 10; i++) b.push(`l${i}\n`);
		expect(b.lines(3)).toEqual(["l7", "l8", "l9"]);
		expect(b.lines(0)).toEqual([]);
		expect(b.lines(100)).toHaveLength(10);
	});

	test("includes the trailing partial line — it is the live edge of output", () => {
		const b = createRingBuffer(4096);
		b.push("done\npart");
		expect(b.lines()).toEqual(["done", "part"]);
		b.push("ial\n");
		expect(b.lines()).toEqual(["done", "partial"]);
	});

	test("assembles a line split across pushes", () => {
		const b = createRingBuffer(4096);
		b.push("he");
		b.push("llo");
		b.push(" world\n");
		expect(b.lines()).toEqual(["hello world"]);
	});

	test("an empty push is a no-op and nothing throws on an empty buffer", () => {
		const b = createRingBuffer(64);
		b.push("");
		expect(b.lines()).toEqual([]);
		expect(b.text()).toBe("");
		expect(b.bytes).toBe(0);
	});
});
