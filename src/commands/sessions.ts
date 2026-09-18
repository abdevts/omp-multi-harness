/**
 * `/sessions` — list, watch, focus, and cancel **delegated runs only**.
 *
 * SCOPE RULE (_spec/07-commands.md): this command never lists or switches OMP's own
 * sessions. OMP already ships `/resume` for that, including `/resume @claude` and
 * `/resume @codex` for importing a foreign worker session. `/sessions` covers only the
 * child-agent runs this extension started, which nothing in OMP tracks. If a future OMP
 * release grows an equivalent run monitor, delete this command and point at theirs rather
 * than keeping two. Do not re-litigate this by adding OMP-session listing here.
 *
 * "Switching sessions" here means switching *focus* between concurrently running workers.
 * Focus is presentation only: this file only ever reads from the registry, so attaching or
 * detaching can never pause, throttle, or reorder a run (_spec/08 §Focus / switching).
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUiComponent,
} from "@oh-my-pi/pi-coding-agent";
import type { MultiHarnessConfig } from "../config/schema.ts";
import { isTerminal, type RunRegistry, type RunStatus, type RunView } from "../runs/types.ts";

/** Status bar / widget key. One key for the whole extension so we never leak two. */
const UI_KEY = "multi-harness";
/** Widget refresh cadence while a run is focused. */
const REFRESH_MS = 500;
/** Output lines kept in the attach widget. */
const TAIL_LINES = 12;

const SUBCOMMANDS = ["list", "attach", "detach", "cancel", "clear"] as const;
const ID_SUBCOMMANDS = new Set<string>(["attach", "cancel"]);

const GLYPHS: Record<RunStatus, string> = {
	running: "●",
	done: "✓",
	failed: "✗",
	cancelled: "⊘",
	queued: "·",
};

/** Key map, rendered as the interactive footer and documented in _spec/07. */
const KEY_HINTS = "↑↓ select   enter attach   d detach   c cancel   r show output   q close";

const EMPTY_HINT = "No delegated runs yet — start one with `/codex <task>` or `/claude <task>`.";

/**
 * Elapsed time in the spec's `2m14s` form (`1h02m14s` past the hour).
 * Pure: exported so the format is unit-testable without any UI.
 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	const tail = `${String(minutes).padStart(hours > 0 ? 2 : 1, "0")}m${String(seconds).padStart(2, "0")}s`;
	return hours > 0 ? `${hours}h${tail}` : tail;
}

/** The one-line phase summary pushed to the status bar for the focused run. */
export function renderStatusLine(run: RunView): string {
	const parts = [run.agent, run.mode, formatElapsed(run.elapsedMs), run.phase || run.status].filter(
		(p): p is string => Boolean(p),
	);
	return parts.join(" · ");
}

/** Column cells for one run, marker excluded (the caller owns the leading marker). */
function cells(run: RunView): string[] {
	return [
		GLYPHS[run.status] ?? "·",
		run.id,
		run.agent,
		run.mode ?? "-",
		run.status,
		formatElapsed(run.elapsedMs),
		run.summary,
	];
}

/** Aligned rows, marker excluded. Shared by the text table and the interactive view. */
function alignedRows(runs: RunView[]): string[] {
	const table = runs.map(cells);
	// Last column is free-form, so it is never padded.
	const widths = table[0]?.map((_, col) => Math.max(...table.map((row) => row[col]?.length ?? 0))) ?? [];
	return table.map((row) =>
		row
			.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
			.join("  ")
			.trimEnd(),
	);
}

/**
 * The plain-text run table (print/RPC modes, and `/sessions list` everywhere).
 * Pure: no UI, no registry — hand it a snapshot and it returns the text.
 */
export function renderRunTable(runs: RunView[], focusedId?: string): string {
	if (runs.length === 0) return EMPTY_HINT;
	const rows = alignedRows(runs);
	return runs.map((run, i) => `${run.id === focusedId ? " ▸ " : "   "}${rows[i]}`).join("\n");
}

/** Attach/detach, including the refresh tick. Owns the only timer this command creates. */
export interface FocusController {
	attach(ctx: ExtensionContext, id: string): void;
	detach(ctx: ExtensionContext): void;
}

/**
 * Stream the focused run's tail into the widget and its phase into the status bar.
 *
 * The tick uses `ctx.setInterval` / `ctx.clearTimer` — never raw timers. A raw timer that
 * throws is a process-fatal `uncaughtException` that tears down the whole OMP session
 * (_spec/01 §2). The handle is cleared on every detach so it cannot leak.
 */
export function createFocusController(getRegistry: () => RunRegistry | undefined): FocusController {
	let timer: ReturnType<ExtensionContext["setInterval"]> | undefined;

	const paint = (ctx: ExtensionContext): void => {
		const registry = getRegistry();
		const id = registry?.focused();
		if (!registry || !id) return;
		const run = registry.get(id);
		if (!run) return;
		const tail = registry.tail(id, TAIL_LINES);
		ctx.ui.setWidget(UI_KEY, [`${run.id} ${run.agent}${run.mode ? ` · ${run.mode}` : ""} — ${run.summary}`, ...tail]);
		ctx.ui.setStatus(UI_KEY, renderStatusLine(run));
		// Focus survives completion (08); the widget keeps the final view until detach, so
		// only the tick stops here.
		if (isTerminal(run.status) && timer) {
			ctx.clearTimer(timer);
			timer = undefined;
		}
	};

	return {
		attach(ctx, id) {
			getRegistry()?.focus(id);
			if (timer) ctx.clearTimer(timer);
			// Scheduled before the first paint so that paint can stop the tick itself when the
			// run is already terminal.
			timer = ctx.setInterval(() => paint(ctx), REFRESH_MS);
			paint(ctx);
		},
		detach(ctx) {
			getRegistry()?.focus(undefined);
			if (timer) ctx.clearTimer(timer);
			timer = undefined;
			ctx.ui.setWidget(UI_KEY, undefined);
			ctx.ui.setStatus(UI_KEY, undefined);
		},
	};
}

export interface SessionsCommandDeps {
	pi: ExtensionAPI;
	getConfig: () => MultiHarnessConfig;
	/** The registry only exists once a session started, hence the getter rather than a value. */
	getRegistry: () => RunRegistry | undefined;
}

/** What the interactive view asks the command handler to do once it closes. */
type Intent =
	| { kind: "attach"; id: string }
	| { kind: "detach" }
	| { kind: "cancel"; id: string }
	| { kind: "show"; id: string }
	| { kind: "close" };

/** Non-interactive subcommand dispatch. Exported for tests; never throws on bad input. */
export async function handleSessionsArgs(
	args: string,
	ctx: ExtensionCommandContext,
	registry: RunRegistry,
	focus: FocusController,
): Promise<void> {
	const argv = args.trim().split(/\s+/).filter(Boolean);
	const sub = argv[0] ?? "list";
	const id = argv[1];

	const requireRun = (): RunView | undefined => {
		if (!id) {
			ctx.ui.notify(`Usage: /sessions ${sub} <runId>`, "error");
			return undefined;
		}
		const run = registry.get(id);
		if (!run) ctx.ui.notify(`Unknown run id: ${id}. Run \`/sessions list\` to see live runs.`, "error");
		return run;
	};

	switch (sub) {
		case "list":
			ctx.ui.notify(renderRunTable(registry.list(), registry.focused()), "info");
			return;
		case "attach": {
			const run = requireRun();
			if (!run) return;
			focus.attach(ctx, run.id);
			ctx.ui.notify(`Attached to ${run.id} (${run.agent}). Runs keep going either way.`, "info");
			return;
		}
		case "detach":
			focus.detach(ctx);
			ctx.ui.notify("Detached. Every run keeps executing.", "info");
			return;
		case "cancel": {
			const run = requireRun();
			if (!run) return;
			const cancelled = await registry.cancel(run.id);
			ctx.ui.notify(cancelled ? `Cancelled ${run.id}.` : `${run.id} had already finished (${run.status}).`, "info");
			return;
		}
		case "clear": {
			const dropped = registry.clearFinished();
			ctx.ui.notify(`Dropped ${dropped} finished run${dropped === 1 ? "" : "s"}.`, "info");
			return;
		}
		default:
			ctx.ui.notify(
				`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.join(", ")} (ids come from \`/sessions list\`).`,
				"error",
			);
	}
}

/** Minimal keyboard list. Kept small on purpose — anything richer belongs in OMP itself. */
function createListComponent(
	registry: RunRegistry,
	requestRender: () => void,
	done: (intent: Intent) => void,
): ExtensionUiComponent {
	let selected = 0;
	let rows: RunView[] = registry.list();
	const unsubscribe = registry.subscribe(() => {
		rows = registry.list();
		requestRender();
	});

	const finish = (intent: Intent): void => {
		unsubscribe();
		done(intent);
	};

	return {
		debugKind: "MultiHarnessRunList",
		render(): readonly string[] {
			rows = registry.list();
			if (rows.length === 0) return [EMPTY_HINT, "", " q close"];
			selected = Math.min(selected, rows.length - 1);
			const focused = registry.focused();
			const aligned = alignedRows(rows);
			const lines = rows.map((run, i) => {
				const cursor = i === selected ? ">" : " ";
				return `${cursor}${run.id === focused ? "▸" : " "} ${aligned[i]}`;
			});
			return [...lines, "", ` ${KEY_HINTS}`];
		},
		handleInput(data: string): void {
			const current = rows[selected];
			switch (data) {
				case "[A":
				case "k":
					selected = Math.max(0, selected - 1);
					requestRender();
					return;
				case "[B":
				case "j":
					selected = Math.min(Math.max(0, rows.length - 1), selected + 1);
					requestRender();
					return;
				case "\r":
				case "\n":
					if (current) finish({ kind: "attach", id: current.id });
					return;
				case "d":
					finish({ kind: "detach" });
					return;
				case "c":
					if (current) finish({ kind: "cancel", id: current.id });
					return;
				case "r":
					if (current) finish({ kind: "show", id: current.id });
					return;
				case "q":
				case "":
					finish({ kind: "close" });
					return;
				default:
					return;
			}
		},
		dispose(): void {
			unsubscribe();
		},
	};
}

/**
 * Interactive view. Returns false when no custom UI could be shown, so the caller falls
 * back to the text table instead of failing the command.
 */
async function showInteractive(
	deps: SessionsCommandDeps,
	ctx: ExtensionCommandContext,
	registry: RunRegistry,
	focus: FocusController,
): Promise<boolean> {
	if (typeof ctx.ui.custom !== "function") return false;
	// Bounded so a component that immediately re-opens cannot spin forever.
	for (let round = 0; round < 50; round++) {
		let intent: Intent;
		try {
			intent = await ctx.ui.custom<Intent>((tui, _theme, _keybindings, done) =>
				createListComponent(registry, () => tui.requestRender(), done),
			);
		} catch {
			return round > 0; // a later round failing is not a reason to re-print the table
		}

		switch (intent.kind) {
			case "attach":
				focus.attach(ctx, intent.id);
				return true;
			case "detach":
				focus.detach(ctx);
				break;
			case "cancel": {
				const run = registry.get(intent.id);
				if (!run) break;
				// Killing a writer mid-edit can leave a half-applied tree, so confirm that one.
				const ok =
					run.readOnly ||
					(await ctx.ui.confirm("Cancel run", `${run.id} (${run.agent}) is writing to ${run.cwd}. Cancel it?`));
				if (ok) await registry.cancel(run.id);
				break;
			}
			case "show": {
				const run = registry.get(intent.id);
				if (run) {
					const body = run.output ?? run.errorMessage ?? registry.tail(run.id).join("\n");
					await deps.pi.sendUserMessage(`Run ${run.id} (${run.agent}) — ${run.summary}\n\n${body}`, {
						attribution: "agent",
					});
				}
				return true;
			}
			default:
				return true;
		}
	}
	return true;
}

/** Register `/sessions`. Delegated runs only — see the scope rule at the top of this file. */
export function registerSessionsCommand(deps: SessionsCommandDeps): void {
	const { pi, getRegistry } = deps;
	const focus = createFocusController(getRegistry);

	pi.registerCommand("sessions", {
		description: "List, attach to, and cancel delegated Codex / Claude runs",
		getArgumentCompletions: (prefix: string) => {
			const match = /^([\s\S]*?)(\S*)$/.exec(prefix);
			const head = match?.[1] ?? "";
			const last = match?.[2] ?? "";
			const wantsIdOnly = ID_SUBCOMMANDS.has(head.trim());
			const items: { value: string; label: string }[] = wantsIdOnly
				? []
				: SUBCOMMANDS.map((s) => ({ value: s, label: s }));
			if (wantsIdOnly || head.trim() === "") {
				for (const run of getRegistry()?.list() ?? []) {
					items.push({ value: run.id, label: `${run.id}  ${run.agent} ${run.status} — ${run.summary}` });
				}
			}
			return items
				.filter((item) => item.value.startsWith(last))
				.map((item) => ({ value: `${head}${item.value}`, label: item.label }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const registry = getRegistry();
			if (!registry) {
				ctx.ui.notify("No run registry yet — delegated runs appear after the session starts.", "error");
				return;
			}

			// Bare `/sessions` gets the interactive view; every explicit subcommand stays
			// non-interactive so scripts and print mode behave identically.
			if (args.trim() === "" && ctx.hasUI && ctx.mode === "tui") {
				if (await showInteractive(deps, ctx, registry, focus)) return;
			}
			await handleSessionsArgs(args, ctx, registry, focus);
		},
	});
}
