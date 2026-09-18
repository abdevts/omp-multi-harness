/**
 * Executable resolution without a shell.
 *
 * Deliberately does not call `which`: no shell, no PATH re-parsing by a child process, and
 * it works identically in tests where PATH is stubbed. See _spec/05-process-runner.md.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve, sep } from "node:path";

const IS_WINDOWS = process.platform === "win32";

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function candidateNames(name: string): string[] {
	if (!IS_WINDOWS) return [name];
	const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	return name.includes(".") ? [name, ...exts.map((e) => name + e)] : exts.map((e) => name + e).concat(name);
}

/**
 * Resolve an executable name or path to an absolute path, or null.
 * A value containing a path separator is treated as a path, not a PATH lookup.
 */
export function resolveExecutable(nameOrPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
	if (!nameOrPath) return null;

	if (nameOrPath.includes(sep) || nameOrPath.includes("/") || isAbsolute(nameOrPath)) {
		const abs = resolve(nameOrPath);
		return isExecutableFile(abs) ? abs : null;
	}

	const pathValue = env.PATH ?? env.Path ?? "";
	for (const dir of pathValue.split(delimiter)) {
		if (!dir) continue;
		for (const candidate of candidateNames(nameOrPath)) {
			const full = resolve(dir, candidate);
			if (isExecutableFile(full)) return full;
		}
	}
	return null;
}
