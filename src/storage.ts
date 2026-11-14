// Default import (not a namespace) so tests can spy on readFileSync and prove untrusted projects read nothing.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export interface GlobalConfig {
	version: 1;
	disabled: Record<string, true>;
	off?: boolean;
	show_paths?: boolean;
	migration?: { from: "pi-skill-manager"; version: 1 };
	[key: string]: unknown;
}

export interface ProjectConfig {
	version: 1;
	overrides: Record<string, "on" | "off">;
	[key: string]: unknown;
}

export interface ConfigLoad<T> {
	state: T;
	existed: boolean;
	valid: boolean;
	issues: string[];
}

const CONFIG_FILE = "pi-skill-palette.json";

export function globalConfigPath(agentDir: string): string {
	return join(agentDir, "config", CONFIG_FILE);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "config", CONFIG_FILE);
}

function defaultGlobal(): GlobalConfig {
	return { version: 1, disabled: {} };
}

function defaultProject(): ProjectConfig {
	return { version: 1, overrides: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMigration(value: unknown): value is { from: "pi-skill-manager"; version: 1 } {
	return isRecord(value) && value.from === "pi-skill-manager" && value.version === 1;
}

function parseGlobal(data: unknown): GlobalConfig | null {
	if (!isRecord(data) || data.version !== 1) return null;
	const disabled = data.disabled ?? {};
	if (!isRecord(disabled) || Object.values(disabled).some((value) => value !== true)) return null;
	if (data.off !== undefined && typeof data.off !== "boolean") return null;
	if (data.show_paths !== undefined && typeof data.show_paths !== "boolean") return null;
	if (data.migration !== undefined && !isMigration(data.migration)) return null;
	return { ...data, version: 1, disabled: disabled as Record<string, true> };
}

function parseProject(data: unknown): ProjectConfig | null {
	if (!isRecord(data) || data.version !== 1) return null;
	const overrides = data.overrides ?? {};
	if (!isRecord(overrides)) return null;
	const valid: Record<string, "on" | "off"> = {};
	for (const [skillPath, override] of Object.entries(overrides)) {
		if (override !== "on" && override !== "off") return null;
		valid[skillPath] = override;
	}
	return { ...data, version: 1, overrides: valid };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readConfig<T>(path: string, parse: (data: unknown) => T | null, empty: () => T): ConfigLoad<T> {
	let raw: string;
	try {
		raw = fs.readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: empty(), existed: false, valid: true, issues: [] };
		return { state: empty(), existed: true, valid: false, issues: [`${path} could not be read (${errorMessage(error)}); ignoring it`] };
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return { state: empty(), existed: true, valid: false, issues: [`${path} is not valid JSON; ignoring it`] };
	}

	const state = parse(data);
	if (!state) return { state: empty(), existed: true, valid: false, issues: [`${path} has an invalid shape; ignoring it`] };
	return { state, existed: true, valid: true, issues: [] };
}

export function loadGlobalConfig(agentDir: string): ConfigLoad<GlobalConfig> {
	return readConfig(globalConfigPath(agentDir), parseGlobal, defaultGlobal);
}

export function loadProjectConfig(cwd: string, trusted: boolean): ConfigLoad<ProjectConfig> {
	// No project file is read while untrusted, so project policy cannot leak into an untrusted session.
	if (!trusted) return { state: defaultProject(), existed: false, valid: true, issues: [] };
	return readConfig(projectConfigPath(cwd), parseProject, defaultProject);
}

function assertReplaceable(path: string, loaded: ConfigLoad<unknown>): void {
	if (loaded.existed && !loaded.valid) throw new Error(`${path} is invalid; refusing to replace it (${loaded.issues.join("; ")})`);
}

function writeConfig(path: string, data: unknown, createOnly = false): void {
	const dir = dirname(path);
	fs.mkdirSync(dir, { recursive: true });
	const tempPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	let created = false;
	try {
		fd = fs.openSync(tempPath, "wx", 0o600);
		created = true;
		fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		if (createOnly) {
			// Hard-link the complete temp into place: EEXIST fails instead of clobbering a concurrent writer.
			fs.linkSync(tempPath, path);
			// The target is committed; nothing below may throw.
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// A leftover temp is harmless.
			}
			return;
		}
		fs.renameSync(tempPath, path);
	} catch (error) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// The temp file is discarded below either way.
			}
		}
		if (created) {
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// Nothing left to clean up.
			}
		}
		throw error;
	}
}

export function saveGlobalConfig(agentDir: string, state: GlobalConfig): void {
	const path = globalConfigPath(agentDir);
	const current = loadGlobalConfig(agentDir);
	assertReplaceable(path, current);
	const next: GlobalConfig = { ...current.state, ...state, version: 1 };
	// The caller owns the master switch: omitting it means off, never a stale on.
	if (state.off === true) next.off = true;
	else delete next.off;
	writeConfig(path, next);
}

export function createGlobalConfigIfAbsent(agentDir: string, state: GlobalConfig): void {
	writeConfig(globalConfigPath(agentDir), state, true);
}

export function saveProjectConfig(cwd: string, trusted: boolean, state: ProjectConfig): void {
	if (!trusted) throw new Error(`project skill policy can only be saved for a trusted project (${projectConfigPath(cwd)})`);
	const path = projectConfigPath(cwd);
	const current = loadProjectConfig(cwd, true);
	assertReplaceable(path, current);
	const overrides: Record<string, "on" | "off"> = {};
	for (const [skillPath, override] of Object.entries(state.overrides)) {
		if (override === "on" || override === "off") overrides[skillPath] = override;
	}
	writeConfig(path, { ...current.state, ...state, version: 1, overrides });
}
