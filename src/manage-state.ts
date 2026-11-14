import fs from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { skillKey } from "./identity.js";
import { resolvePolicy } from "./policy.js";
import { blockLengths } from "./prompt-gate.js";
import type { PaletteSkill } from "./skill-content.js";
import type { GlobalConfig, ProjectConfig } from "./storage.js";

export type ManageScope = "global" | "project";
export type GlobalPending = { scope: "global"; disabled: Record<string, true>; off: boolean; show_paths?: boolean };
export type ProjectPending = { scope: "project"; overrides: Record<string, "on" | "off"> };
export type PendingPolicy = GlobalPending | ProjectPending;

export function createPending(scope: "global", global: GlobalConfig, project: ProjectConfig): GlobalPending;
export function createPending(scope: "project", global: GlobalConfig, project: ProjectConfig): ProjectPending;
export function createPending(scope: ManageScope, global: GlobalConfig, project: ProjectConfig): PendingPolicy;
export function createPending(scope: ManageScope, global: GlobalConfig, project: ProjectConfig): PendingPolicy {
	return scope === "global"
		? {
			scope: "global",
			disabled: { ...global.disabled },
			off: global.off === true,
			...(global.show_paths === undefined ? {} : { show_paths: global.show_paths }),
		}
		: { scope: "project", overrides: { ...project.overrides } };
}

export function togglePendingRow(pending: GlobalPending, filePath: string): GlobalPending;
export function togglePendingRow(pending: ProjectPending, filePath: string): ProjectPending;
export function togglePendingRow(pending: PendingPolicy, filePath: string): PendingPolicy;
export function togglePendingRow(pending: PendingPolicy, filePath: string): PendingPolicy {
	if (pending.scope === "global") {
		const disabled = { ...pending.disabled };
		if (disabled[filePath] === true) delete disabled[filePath];
		else disabled[filePath] = true;
		return { ...pending, disabled };
	}
	const overrides = { ...pending.overrides };
	// Inherit is the absent entry, so the cycle Inherit -> On -> Off removes the row on the last step.
	if (overrides[filePath] === "on") overrides[filePath] = "off";
	else if (overrides[filePath] === "off") delete overrides[filePath];
	else overrides[filePath] = "on";
	return { ...pending, overrides };
}

export function togglePendingPack(pending: GlobalPending, skills: PaletteSkill[]): GlobalPending;
export function togglePendingPack(pending: ProjectPending, skills: PaletteSkill[]): ProjectPending;
export function togglePendingPack(pending: PendingPolicy, skills: PaletteSkill[]): PendingPolicy;
export function togglePendingPack(pending: PendingPolicy, skills: PaletteSkill[]): PendingPolicy {
	if (skills.length === 0) return pending;
	const keys = skills.map(skillKey);
	if (pending.scope === "global") {
		const disable = keys.every((key) => pending.disabled[key] !== true);
		const disabled = { ...pending.disabled };
		for (const key of keys) {
			if (disable) disabled[key] = true;
			else delete disabled[key];
		}
		return { ...pending, disabled };
	}
	// Project bulk staging cycles On -> Off -> Inherit so a pack can return to Global defaults.
	const states = keys.map((key) => pending.overrides[key]);
	const next = states.every((state) => state === "on") ? "off" : states.every((state) => state === "off") ? undefined : "on";
	const overrides = { ...pending.overrides };
	for (const key of keys) {
		if (next === undefined) delete overrides[key];
		else overrides[key] = next;
	}
	return { ...pending, overrides };
}

export function togglePendingMaster(pending: GlobalPending): GlobalPending;
export function togglePendingMaster(pending: ProjectPending): ProjectPending;
export function togglePendingMaster(pending: PendingPolicy): PendingPolicy;
export function togglePendingMaster(pending: PendingPolicy): PendingPolicy {
	return pending.scope === "global" ? { ...pending, off: !pending.off } : pending;
}

function sameEntries(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

export function isPendingDirty(saved: GlobalConfig | ProjectConfig, pending: PendingPolicy): boolean {
	if (pending.scope === "global") {
		const global = saved as GlobalConfig;
		return (global.off === true) !== pending.off
			|| (global.show_paths !== false) !== (pending.show_paths !== false)
			|| !sameEntries(global.disabled, pending.disabled);
	}
	return !sameEntries((saved as ProjectConfig).overrides, pending.overrides);
}

export function formatNativeTag(skill: PaletteSkill): string {
	return skill.disableModelInvocation ? " (native)" : "";
}

/** Display-only path label: the verbatim source path with the home directory shortened. */
export function formatSkillPathLabel(skill: PaletteSkill): string {
	const home = homedir();
	const sourcePath = skill.sourceInfo.path;
	return sourcePath.startsWith(`${home}/`) ? `~${sourcePath.slice(home.length)}` : sourcePath;
}

export type SkillLockEntries = Record<string, { source?: string } | undefined>;

/**
 * Read-only view of ~/.agents/.skill-lock.json: a missing file or unknown shape degrades to
 * no entries, matching pi-skill-manager's "never an error, worst case an uglier label" rule.
 */
export function loadSkillLock(home = homedir()): SkillLockEntries {
	try {
		const data = JSON.parse(fs.readFileSync(join(home, ".agents", ".skill-lock.json"), "utf8")) as {
			skills?: unknown;
		};
		return data.skills && typeof data.skills === "object" ? (data.skills as SkillLockEntries) : {};
	} catch {
		return {};
	}
}

/**
 * Display-only group label, ported from pi-skill-manager discovery.ts: git package repo,
 * lockfile owner (folder fallback) for top-level skill folders, scoped/unscoped node_modules owner,
 * Hermes global/project procedural memory, else the parent folder. Pack labels never replace source identity.
 */
export function packLabel(skill: { sourceInfo: { path: string } }, lock: SkillLockEntries = {}, home = homedir()): string {
	const sourcePath = skill.sourceInfo.path.split(sep).join("/");

	const installed = /\/\.pi\/agent\/git\/[^/]+\/[^/]+\/([^/]+)\//.exec(sourcePath);
	if (installed) return installed[1];

	const agentsPrefix = sourcePath.startsWith(`${home}/.pi/agent/skills/`)
		? `${home}/.pi/agent/skills/`
		: sourcePath.startsWith(`${home}/.agents/skills/`)
			? `${home}/.agents/skills/`
			: null;
	if (agentsPrefix !== null) {
		const folder = sourcePath.slice(agentsPrefix.length).split("/")[0];
		const source = lock[folder]?.source;
		return typeof source === "string" ? source.split("/")[0] : folder;
	}

	const module = /\/node_modules\/(@[^/]+)\/[^/]+\//.exec(sourcePath);
	if (module) return module[1].slice(1);

	const unscopedModule = /\/node_modules\/([^/@][^/]*)\/skills\//.exec(sourcePath);
	if (unscopedModule) return unscopedModule[1];

	if (/\/\.pi\/agent\/(?:pi-hermes-memory|projects-memory)\//.test(sourcePath)) return "auto-learned";

	return sourcePath.split("/").filter(Boolean).at(-2) ?? "unknown";
}

/** Compact per-row effective state from the combined pending Global+Project+trust policy. */
export function formatEffectiveState(
	skill: PaletteSkill,
	global: GlobalConfig,
	project: ProjectConfig,
	projectTrusted: boolean,
): "on" | "off" {
	return resolvePolicy(global, project, projectTrusted).isEnabled(skillKey(skill)) ? "on" : "off";
}

function formatSize(size: number): string {
	return size >= 1000 ? `${(size / 1000).toFixed(1)}k` : `${size}`;
}

export function formatEffectiveSummary(
	global: GlobalConfig,
	project: ProjectConfig,
	projectTrusted: boolean,
	skills: PaletteSkill[],
): string {
	const policy = resolvePolicy(global, project, projectTrusted);
	const enabled = skills.filter((skill) => policy.isEnabled(skillKey(skill)));
	const before = blockLengths(skills, new Set()).before;
	const after = enabled.length === skills.length ? before : blockLengths(enabled, new Set()).before;

	const globalState = global.off === true ? "master off" : `${Object.keys(global.disabled).length} off`;
	const projectOn = Object.values(project.overrides).filter((override) => override === "on").length;
	const projectOff = Object.values(project.overrides).filter((override) => override === "off").length;
	const projectState = projectTrusted ? `${projectOn} on / ${projectOff} off` : "untrusted";

	return `${enabled.length}/${skills.length} on · prompt ${formatSize(after)}/${formatSize(before)} · global ${globalState} · project ${projectState}`;
}
