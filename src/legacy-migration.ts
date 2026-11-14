import fs from "node:fs";
import { join } from "node:path";

import { createGlobalConfigIfAbsent, globalConfigPath, loadGlobalConfig, type GlobalConfig } from "./storage.js";

interface CatalogSkill {
	name: string;
	filePath: string;
	pack: string;
}

const LEGACY_FILE = "pi-skill-manager.json";

export function legacySkillManagerPath(agentDir: string): string {
	return join(agentDir, "config", LEGACY_FILE);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLegacyKey(catalog: readonly CatalogSkill[], legacyKey: string, issues: string[]): string | undefined {
	const exact = catalog.filter((skill) => `${skill.pack}/${skill.name}` === legacyKey);
	if (exact.length === 1) return exact[0].filePath;
	if (exact.length > 1) {
		issues.push(`legacy key "${legacyKey}" is ambiguous (${exact.length} catalog matches); not imported`);
		return undefined;
	}
	const name = legacyKey.split("/").at(-1) ?? "";
	const byName = catalog.filter((skill) => skill.name === name);
	if (byName.length === 1) return byName[0].filePath;
	if (byName.length > 1) {
		issues.push(`legacy key "${legacyKey}" is ambiguous (${byName.length} skills named "${name}"); not imported`);
	} else {
		issues.push(`legacy key "${legacyKey}" matches no installed skill; not imported`);
	}
	return undefined;
}

export interface LegacyImportResult {
	imported: boolean;
	issues: string[];
	/** A provisional import found relative keys it cannot resolve yet; nothing was written. */
	deferred?: boolean;
}

export function importLegacySkillManagerOnce(args: {
	agentDir: string;
	catalog: CatalogSkill[];
	/**
	 * Startup may run before extension resource discovery. In this mode, an unresolved relative
	 * key defers the whole import instead of writing a marker that would block a later retry.
	 */
	deferUnresolved?: boolean;
}): LegacyImportResult {
	const issues: string[] = [];
	const targetPath = globalConfigPath(args.agentDir);
	const existing = loadGlobalConfig(args.agentDir);
	if (existing.existed) {
		if (!existing.valid) issues.push(`${targetPath} is invalid; legacy import skipped`);
		return { imported: false, issues };
	}

	const legacyPath = legacySkillManagerPath(args.agentDir);
	let raw: string;
	try {
		raw = fs.readFileSync(legacyPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { imported: false, issues };
		issues.push(`${legacyPath} could not be read (${errorMessage(error)}); nothing imported`);
		return { imported: false, issues };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		issues.push(`${legacyPath} is not valid JSON; nothing imported`);
		return { imported: false, issues };
	}
	if (!isRecord(parsed)) {
		issues.push(`${legacyPath} is not a skillmgr config object; nothing imported`);
		return { imported: false, issues };
	}
	const legacyDisabled = parsed.disabled ?? {};
	if (!isRecord(legacyDisabled)) {
		issues.push(`${legacyPath} has an invalid "disabled" record; nothing imported`);
		return { imported: false, issues };
	}

	const disabled: Record<string, true> = {};
	let unresolvedRelative = false;
	for (const [key, value] of Object.entries(legacyDisabled)) {
		if (value !== true) continue;
		if (key.startsWith("/")) {
			disabled[key] = true;
			continue;
		}
		// A provisional startup import discards these messages: the key may resolve after discovery.
		const filePath = resolveLegacyKey(args.catalog, key, args.deferUnresolved ? [] : issues);
		if (filePath) disabled[filePath] = true;
		else if (args.deferUnresolved) unresolvedRelative = true;
	}
	if (args.deferUnresolved && unresolvedRelative) {
		return { imported: false, issues: [], deferred: true };
	}

	const projects = parsed.projects;
	if (projects !== undefined && projects !== null && (!isRecord(projects) || Object.keys(projects).length > 0)) {
		issues.push(`legacy "projects" data in ${legacyPath} is reserved and was not imported`);
	}

	const next: GlobalConfig = {
		version: 1,
		disabled,
		migration: { from: "pi-skill-manager", version: 1 },
	};
	if (parsed.off === true) next.off = true;

	try {
		createGlobalConfigIfAbsent(args.agentDir, next);
	} catch (error) {
		issues.push(`could not write ${targetPath} (${errorMessage(error)}); legacy import not marked complete`);
		return { imported: false, issues };
	}
	return { imported: true, issues };
}
