/**
 * Streaming JSON-lines reader.
 *
 * Both CLIs emit line-delimited JSON on stdout, and a chunk boundary can fall anywhere —
 * including mid-line. This carries the partial line across chunks and never throws: a line
 * that does not parse is counted and handed back as raw text for debug logging.
 */
export interface JsonlStats {
	lines: number;
	parsed: number;
	parseErrors: number;
}

export class JsonlReader {
	#partial = "";
	readonly stats: JsonlStats = { lines: 0, parsed: 0, parseErrors: 0 };

	constructor(private readonly onValue: (value: unknown, raw: string) => void) {}

	push(chunk: string): void {
		this.#partial += chunk;
		let index: number;
		while ((index = this.#partial.indexOf("\n")) >= 0) {
			const line = this.#partial.slice(0, index);
			this.#partial = this.#partial.slice(index + 1);
			this.#consume(line);
		}
	}

	/** Flush whatever is left after the stream closes (a final line without a newline). */
	end(): void {
		if (this.#partial.length > 0) {
			this.#consume(this.#partial);
			this.#partial = "";
		}
	}

	#consume(rawLine: string): void {
		const line = rawLine.trim();
		if (line.length === 0) return;
		this.stats.lines++;
		if (line[0] !== "{" && line[0] !== "[") {
			// Plain text interleaved with the event stream (progress banners, warnings).
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
