/**
 * Byte-capped, line-aware live output buffer (T-402, _spec/08).
 *
 * Worker output is unbounded; the attach view is not. We cap by **UTF-8 bytes** (never
 * `String.length`, which lies about anything non-ASCII) and evict whole lines from the
 * front, so the oldest thing the user sees is always a complete line rather than the tail
 * of one.
 */
import type { RingBuffer } from "./types.ts";

/**
 * Keep at most `maxBytes` bytes from the end of `text`, starting at a valid UTF-8
 * character boundary — slicing a Buffer mid-sequence would decode as U+FFFD.
 */
function tailBytes(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let start = buf.length - maxBytes;
	// 0b10xxxxxx is a continuation byte: walk forward until we are on a lead byte.
	while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
	return buf.toString("utf8", start);
}

/**
 * Create a ring buffer holding at most `maxBytes` UTF-8 bytes.
 *
 * Eviction drops whole lines from the front. A single line longer than the whole cap
 * cannot be evicted line-wise, so it is hard-truncated from the front (at a character
 * boundary) — the alternative is blowing the cap, which is worse.
 */
export function createRingBuffer(maxBytes: number): RingBuffer {
	const cap = Math.max(1, Math.floor(maxBytes));
	let text = "";
	let bytes = 0;
	let droppedBytes = 0;

	function evict(): void {
		while (bytes > cap) {
			const nl = text.indexOf("\n");
			if (nl === -1) break;
			const removedBytes = Buffer.byteLength(text.slice(0, nl + 1), "utf8");
			text = text.slice(nl + 1);
			bytes -= removedBytes;
			droppedBytes += removedBytes;
		}
		// Left with one over-long partial line: keep its tail, honestly counting the loss.
		if (bytes > cap) {
			const kept = tailBytes(text, cap);
			const keptBytes = Buffer.byteLength(kept, "utf8");
			droppedBytes += bytes - keptBytes;
			text = kept;
			bytes = keptBytes;
		}
	}

	return {
		push(chunk: string): void {
			if (!chunk) return;
			text += chunk;
			bytes += Buffer.byteLength(chunk, "utf8");
			evict();
		},
		lines(limit?: number): string[] {
			if (!text) return [];
			const all = text.split("\n");
			// A trailing newline yields an empty final element — that is a terminator, not a line.
			if (all[all.length - 1] === "") all.pop();
			if (limit === undefined) return all;
			return all.slice(Math.max(0, all.length - Math.max(0, limit)));
		},
		text(): string {
			return text;
		},
		get bytes(): number {
			return bytes;
		},
		get droppedBytes(): number {
			return droppedBytes;
		},
	};
}
