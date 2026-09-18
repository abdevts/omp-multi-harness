/**
 * Streaming JSON-lines reader.
 *
 * Both CLIs emit line-delimited JSON on stdout, and a chunk boundary can fall anywhere —
 * including mid-line, or mid-character for a multi-byte UTF-8 code point. This carries the
 * partial line (and, when fed raw bytes, partial code point) across chunks and never
 * throws: a line that does not parse is counted and handed back as raw text for debug
 * logging, rather than being silently swallowed.
 */
export interface JsonlStats {
	lines: number;
	parsed: number;
	parseErrors: number;
	/** Subset of parseErrors: a line dropped for exceeding MAX_LINE_CHARS. */
	oversizeLines: number;
}

/**
 * Cap on a single line, in UTF-16 code units (a good proxy for bytes on the ASCII-heavy
 * JSON these CLIs emit). A real event line from either CLI is a few KB at most; 1 MiB is
 * generous headroom while still bounding memory against a line that never ends — a hung
 * write, a binary blob accidentally sent to stdout, or a hostile/buggy worker. Chosen to
 * match spawnAgent's own `maxBufferBytes` default (src/process/spawn-agent.ts) so the two
 * caps reason about the same order of magnitude.
 */
export const MAX_LINE_CHARS = 1_048_576;

export class JsonlReader {
	#partial = "";
	/** Only allocated when bytes are pushed; keeps decode state across a split code point. */
	#byteDecoder: TextDecoder | undefined;
	readonly stats: JsonlStats = { lines: 0, parsed: 0, parseErrors: 0, oversizeLines: 0 };

	constructor(private readonly onValue: (value: unknown, raw: string) => void) {}

	/**
	 * Feed one chunk. Accepts either text (the normal path — callers that already own a
	 * persistent decoder, e.g. spawnAgent's stdout handler) or raw bytes; bytes are run
	 * through a decoder kept alive across calls, so a multi-byte UTF-8 character split
	 * across two `push` calls is reassembled correctly instead of corrupted.
	 */
	push(chunk: string | Uint8Array): void {
		const text = typeof chunk === "string" ? chunk : this.#decodeBytes(chunk);
		if (text.length === 0) return;
		this.#partial += text;
		let index: number;
		while ((index = this.#partial.indexOf("\n")) >= 0) {
			const line = this.#partial.slice(0, index);
			this.#partial = this.#partial.slice(index + 1);
			this.#consume(line);
		}
		// Memory-exhaustion guard: nothing terminated this line yet, so it is still growing
		// unbounded. Drop it rather than let a runaway stream buffer forever.
		if (this.#partial.length > MAX_LINE_CHARS) this.#dropOversize();
	}

	#decodeBytes(chunk: Uint8Array): string {
		this.#byteDecoder ??= new TextDecoder("utf-8");
		return this.#byteDecoder.decode(chunk, { stream: true });
	}

	/** Flush whatever is left after the stream closes (a final line without a newline). */
	end(): void {
		if (this.#byteDecoder) {
			// Flush any trailing partial code point rather than silently dropping it.
			this.#partial += this.#byteDecoder.decode();
			this.#byteDecoder = undefined;
		}
		if (this.#partial.length > 0) {
			this.#consume(this.#partial);
			this.#partial = "";
		}
	}

	#dropOversize(): void {
		this.stats.lines++;
		this.stats.oversizeLines++;
		this.stats.parseErrors++;
		this.onValue(undefined, `<line exceeded ${MAX_LINE_CHARS} chars, dropped>`);
		this.#partial = "";
	}

	#consume(rawLine: string): void {
		const line = rawLine.trim();
		if (line.length === 0) return;
		if (line.length > MAX_LINE_CHARS) {
			// A single newline-terminated line arrived already oversized (e.g. one huge
			// chunk containing its own trailing "\n") — the loop above only guards the
			// still-buffering case, so this line needs its own check.
			this.stats.lines++;
			this.stats.oversizeLines++;
			this.stats.parseErrors++;
			this.onValue(undefined, `<line exceeded ${MAX_LINE_CHARS} chars, dropped>`);
			return;
		}
		this.stats.lines++;
		if (line[0] !== "{" && line[0] !== "[") {
			// Plain text interleaved with the event stream (progress banners, warnings,
			// ANSI-decorated spinners).
			this.stats.parseErrors++;
			this.onValue(undefined, line);
			return;
		}
		try {
			const value: unknown = JSON.parse(line);
			this.stats.parsed++;
			this.onValue(value, line);
		} catch {
			this.stats.parseErrors++;
			this.onValue(undefined, line);
		}
	}
}

/** Convenience for tests and non-streaming callers. */
export function parseJsonl(text: string): { values: unknown[]; stats: JsonlStats } {
	const values: unknown[] = [];
	const reader = new JsonlReader((value) => {
		if (value !== undefined) values.push(value);
	});
	reader.push(text);
	reader.end();
	return { values, stats: reader.stats };
}
