/**
 * pi-skill-policy
 *
 * Skill loading palette with persistent Global and Project visibility controls.
 * /skill loads or pins skills and opens policy management.
 *
 * https://github.com/ZeR020/pi-skill-policy
 */

import { DynamicBorder, getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type InputSource, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type AutocompleteProvider } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { firstSkillByName, firstWinnerPerName, skillKey } from "./src/identity.js";
import {
	createPending,
	formatEffectiveState,
	formatEffectiveSummary,
	formatNativeTag,
	formatSkillPathLabel,
	isPendingDirty,
	loadSkillLock,
	packLabel,
	togglePendingMaster,
	togglePendingPack,
	togglePendingRow,
	type GlobalPending,
	type ManageScope,
	type PendingPolicy,
	type ProjectPending,
	type SkillLockEntries,
} from "./src/manage-state.js";
import {
	loadGlobalConfig,
	loadProjectConfig,
	saveGlobalConfig,
	saveProjectConfig,
	type GlobalConfig,
	type ProjectConfig,
} from "./src/storage.js";
import {
	MAX_QUEUED_SKILLS,
	resolveInvocationPolicy,
	resolveNativeSkillTarget,
	skillsEnabledByPolicy,
} from "./src/input-gate.js";
import { resolvePolicy, type EffectivePolicy } from "./src/policy.js";
import { createBeforeAgentStartHandler } from "./src/runtime-policy.js";
import { importLegacySkillManagerOnce } from "./src/legacy-migration.js";
import type { PaletteSkill } from "./src/skill-content.js";

type Skill = PaletteSkill;
// Public alias retained for palette compatibility; distinct from Pi's Skill type.
export type { PaletteSkill as Skill };

interface SkillPaletteState {
	queuedSkills: Skill[];
	pinnedSkills: Skill[];
}

type PaletteAction = "select" | "pin" | "unqueue" | "unpin";
export type PaletteResult =
	| { action: "cancel"; skill: null }
	| { action: PaletteAction; skill: Skill }
	| { action: "saved"; scope: ManageScope; masterOff: boolean };

// Shared state across the extension
export const state: SkillPaletteState = {
	queuedSkills: [],
	pinnedSkills: [],
};

// Task 9 wires persistent Global/Project loading; until then the default allows every skill.
let currentPolicy: EffectivePolicy = resolvePolicy({}, null, false);

// Tasks 8/9 set the resolved policy here; every gated path reads it.
export function setCurrentPolicy(policy: EffectivePolicy): void {
	currentPolicy = policy;
}

// One-shot runtime warnings persist until reload; keys classify the warning.
const warnedOnceKeys = new Set<string>();

// ═══════════════════════════════════════════════════════════════════════════
// Theming
// ═══════════════════════════════════════════════════════════════════════════

interface PaletteTheme {
	border: string;        // Box borders
	title: string;         // Title text
	selected: string;      // Selected item highlight
	selectedText: string;  // Selected item text
	queued: string;        // Queued badge
	searchIcon: string;    // Search icon
	placeholder: string;   // Placeholder text
	description: string;   // Skill descriptions
	hint: string;          // Footer hints
	confirm: string;       // Confirm button (keep)
	cancel: string;        // Cancel button (remove)
}

const DEFAULT_THEME: PaletteTheme = {
	border: "2",           // dim
	title: "33",           // yellow
	selected: "36",        // cyan
	selectedText: "36",    // cyan
	queued: "32",          // green
	searchIcon: "2",       // dim
	placeholder: "2;3",    // dim italic
	description: "2",      // dim
	hint: "2",             // dim
	confirm: "32",         // green
	cancel: "31",          // red
};

function loadTheme(): PaletteTheme {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-skill-palette", "theme.json");
	try {
		if (fs.existsSync(configPath)) {
			const content = fs.readFileSync(configPath, "utf-8");
			const custom = JSON.parse(content) as Partial<PaletteTheme>;
			return { ...DEFAULT_THEME, ...custom };
		}
	} catch {
		// Ignore errors, use default
	}
	return DEFAULT_THEME;
}

function fg(code: string, text: string): string {
	if (!code) return text;
	// Handle compound codes like "2;3" (dim + italic)
	return `\x1b[${code}m${text}\x1b[0m`;
}

// Rainbow colors (matching powerline-footer thinking:high)
const RAINBOW_COLORS = [
	"38;2;178;129;214",  // #b281d6 purple
	"38;2;215;135;175",  // #d787af pink
	"38;2;254;188;56",   // #febc38 orange
	"38;2;228;192;15",   // #e4c00f yellow
	"38;2;137;210;129",  // #89d281 green
	"38;2;0;175;175",    // #00afaf cyan
	"38;2;23;143;185",   // #178fb9 blue
];

// Render spaced rainbow progress dots
function rainbowProgress(filled: number, total: number): string {
	const dots: string[] = [];
	for (let i = 0; i < total; i++) {
		const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length];
		const dot = i < filled ? "●" : "○";
		dots.push(fg(color, dot));
	}
	return dots.join(" ");
}

// Load theme once at startup
const paletteTheme = loadTheme();

// Cache keyed on array identity: pi rebuilds its system-prompt options (new skills
// array) on reload, so an identity change is exactly when re-indexing is needed.
let loadedSkillsSource: ReturnType<ExtensionCommandContext["getSystemPromptOptions"]>["skills"];
let loadedSkillsCache: Skill[] = [];
let commandSkillsCache: Skill[] | null = null;

function isPinnedByDefault(filePath: string): boolean {
	try {
		return parseFrontmatter(fs.readFileSync(filePath, "utf-8")).frontmatter.pinned === true;
	} catch {
		return false;
	}
}

type IndexedSkillFields = Pick<Skill, "name" | "description" | "filePath" | "baseDir" | "sourceInfo" | "disableModelInvocation">;

function indexSkills(skills: IndexedSkillFields[]): Skill[] {
	return [...skills]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((skill, sortIndex) => ({
			...skill,
			pinByDefault: isPinnedByDefault(skill.filePath),
			searchName: skill.name.toLowerCase(),
			searchDescription: skill.description.toLowerCase(),
			sortIndex,
		}));
}

export function getSelectableSkills(
	ctx: Pick<ExtensionCommandContext, "getSystemPromptOptions">,
	policy: EffectivePolicy,
): Skill[] {
	return skillsEnabledByPolicy(firstWinnerPerName(getLoadedSkills(ctx)), policy);
}

function getLoadedSkills(ctx: Pick<ExtensionCommandContext, "getSystemPromptOptions">): Skill[] {
	const source = ctx.getSystemPromptOptions().skills;
	if (source === loadedSkillsSource) return loadedSkillsCache;

	loadedSkillsSource = source;
	loadedSkillsCache = indexSkills((source ?? []).map((skill) => ({
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		sourceInfo: skill.sourceInfo,
		disableModelInvocation: skill.disableModelInvocation,
	})));
	return loadedSkillsCache;
}

function isSkillCommand(command: SlashCommandInfo): boolean {
	return command.source === "skill" && command.name.startsWith("skill:") && Boolean(command.sourceInfo.path);
}

function commandSkill(command: SlashCommandInfo): IndexedSkillFields {
	return {
		name: command.name.slice("skill:".length),
		description: command.description ?? "",
		filePath: command.sourceInfo.path,
		baseDir: command.sourceInfo.baseDir ?? path.dirname(command.sourceInfo.path),
		sourceInfo: command.sourceInfo,
		// SlashCommandInfo carries no visibility flag; management reads the system-prompt catalog.
		disableModelInvocation: false,
	};
}

function getCommandSkills(pi: ExtensionAPI): Skill[] {
	commandSkillsCache ??= indexSkills(pi.getCommands().filter(isSkillCommand).map(commandSkill));
	return commandSkillsCache;
}

function getQueuedSkillKeys(): Set<string> {
	return new Set(state.queuedSkills.map(skillKey));
}

function getPinnedSkillKeys(): Set<string> {
	return new Set(state.pinnedSkills.map(skillKey));
}

function formatSkillList(skills: Skill[]): string {
	return skills.map((skill) => skill.name).join(", ");
}

type QueueSkillsResult =
	| { status: "queued" }
	| { status: "full" };

export function queueSkills(skills: Skill[]): QueueSkillsResult {
	const keys = getQueuedSkillKeys();
	const next = [...state.queuedSkills];

	for (const skill of skills) {
		if (keys.has(skillKey(skill))) continue;
		if (next.length >= MAX_QUEUED_SKILLS) {
			return { status: "full" };
		}
		next.push(skill);
		keys.add(skillKey(skill));
	}

	state.queuedSkills = next;
	return { status: "queued" };
}

export function pruneDisabledPendingSkills(policy: EffectivePolicy): void {
	if (policy.offPaths.size === 0) return;
	// Only replace the arrays when something was dropped, so callers can detect a prune
	// by identity instead of re-rendering indicators on every input.
	const queued = skillsEnabledByPolicy(state.queuedSkills, policy);
	if (queued.length !== state.queuedSkills.length) state.queuedSkills = queued;
	const pinned = skillsEnabledByPolicy(state.pinnedSkills, policy);
	if (pinned.length !== state.pinnedSkills.length) state.pinnedSkills = pinned;
}

/**
 * Save one management scope, then adopt it: the runtime policy and pending queue change only
 * after the file write succeeded, so a failed save leaves the previous behavior in place.
 */
export function applyPendingPolicy(args: {
	agentDir: string;
	cwd: string;
	trusted: boolean;
	pending: PendingPolicy;
}): void {
	const { pending } = args;
	if (pending.scope === "global") {
		saveGlobalConfig(args.agentDir, {
			version: 1,
			disabled: pending.disabled,
			...(pending.off ? { off: true } : {}),
			...(pending.show_paths === undefined ? {} : { show_paths: pending.show_paths }),
		});
	} else {
		saveProjectConfig(args.cwd, args.trusted, { version: 1, overrides: pending.overrides });
	}
	const global = loadGlobalConfig(args.agentDir);
	const project = loadProjectConfig(args.cwd, args.trusted);
	setCurrentPolicy(resolvePolicy(global.state, project.state, args.trusted));
	pruneDisabledPendingSkills(currentPolicy);
}

/** Headless Pi discards ui.notify, so text goes to stderr (which never corrupts JSON stdout). */
function notifyText(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(message);
}

/** Compatibility /skillmgr disable|enable: save first, adopt policy second, reload third. */
async function setMasterBypass(ctx: ExtensionCommandContext, off: boolean): Promise<void> {
	const agentDir = getAgentDir();
	try {
		const current = loadGlobalConfig(agentDir);
		saveGlobalConfig(agentDir, { ...current.state, version: 1, off });
	} catch (error) {
		notifyText(
			ctx,
			`skill palette master switch: save failed — ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	const trusted = ctx.isProjectTrusted();
	const global = loadGlobalConfig(agentDir);
	const project = loadProjectConfig(ctx.cwd, trusted);
	setCurrentPolicy(resolvePolicy(global.state, project.state, trusted));
	pruneDisabledPendingSkills(currentPolicy);
	updateSkillIndicators(ctx);
	notifyText(
		ctx,
		off ? "skill palette master switch off — restrictions bypassed; /skillmgr enable to resume" : "skill palette master switch on",
		"info",
	);
	await ctx.reload();
}

let startupIssues: string[] = [];
// Handlers can exist before session_start; only a deferred startup import needs finalization.
let startupReady = true;
let startupContext: ExtensionContext | undefined;

/** Migration needs path identities only; a fresh catalog avoids caching skills before resource_discover. */
function migrationCatalog(pi: ExtensionAPI): Array<{ name: string; filePath: string; pack: string }> {
	const lock = loadSkillLock();
	return pi.getCommands().filter(isSkillCommand).map(commandSkill).map((skill) => ({
		name: skill.name,
		filePath: skill.filePath,
		pack: packLabel(skill, lock),
	}));
}

function adoptStartupPolicy(ctx: ExtensionContext, importedIssues: readonly string[]): void {
	const trusted = ctx.isProjectTrusted();
	const global = loadGlobalConfig(getAgentDir());
	const project = loadProjectConfig(ctx.cwd, trusted);
	startupIssues = [...new Set([...importedIssues, ...global.issues, ...project.issues])];
	setCurrentPolicy(resolvePolicy(global.state, project.state, trusted));
	pruneDisabledPendingSkills(currentPolicy);
	for (const issue of startupIssues) notifyText(ctx, issue, "warning");
}

function loadStartupPolicy(pi: ExtensionAPI, ctx: ExtensionContext): void {
	commandSkillsCache = null;
	startupContext = ctx;
	// Provisional startup may precede extension resource discovery; unresolved relative keys defer
	// the import instead of writing a marker that would block the post-discovery retry.
	const imported = importLegacySkillManagerOnce({
		agentDir: getAgentDir(),
		catalog: migrationCatalog(pi),
		deferUnresolved: true,
	});
	adoptStartupPolicy(ctx, imported.issues);
	startupReady = imported.deferred !== true;
}

/** First post-discovery use finalizes a deferred import before any policy is read. */
function ensureStartupPolicy(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (startupReady) return;
	const imported = importLegacySkillManagerOnce({ agentDir: getAgentDir(), catalog: migrationCatalog(pi) });
	adoptStartupPolicy(ctx, imported.issues);
	commandSkillsCache = null;
	startupReady = true;
}

/** Headless modes get text instead of the overlay, matching the compatibility design. */
function formatHeadlessSummary(ctx: ExtensionCommandContext): string {
	const trusted = ctx.isProjectTrusted();
	const global = loadGlobalConfig(getAgentDir());
	const project = loadProjectConfig(ctx.cwd, trusted);
	const catalog = firstWinnerPerName(getLoadedSkills(ctx));
	const issues = [...new Set([...startupIssues, ...global.issues, ...project.issues])];
	const summary = formatEffectiveSummary(global.state, project.state, trusted, catalog);
	return issues.length === 0 ? summary : `${summary}\n${issues.join("\n")}`;
}

function pinSkill(skill: Skill): void {
	if (getPinnedSkillKeys().has(skillKey(skill))) return;
	state.pinnedSkills = [...state.pinnedSkills, skill];
}

function removeQueuedSkill(skill: Skill): void {
	state.queuedSkills = state.queuedSkills.filter((queuedSkill) => skillKey(queuedSkill) !== skillKey(skill));
}

function removePinnedSkill(skill: Skill): void {
	state.pinnedSkills = state.pinnedSkills.filter((pinnedSkill) => skillKey(pinnedSkill) !== skillKey(skill));
}

function updateSkillIndicators(ctx: Pick<ExtensionContext, "ui">): void {
	const queuedSkills = state.queuedSkills;
	const pinnedSkills = state.pinnedSkills;
	if (queuedSkills.length === 0 && pinnedSkills.length === 0) {
		ctx.ui.setStatus("skill", undefined);
		ctx.ui.setWidget("skill", undefined);
		return;
	}

	const statusParts: string[] = [];
	const widgetLines: string[] = [];
	if (queuedSkills.length > 0) {
		const names = formatSkillList(queuedSkills);
		const count = `${queuedSkills.length}/${MAX_QUEUED_SKILLS}`;
		statusParts.push(`📚 ${count} ${names}`);
		widgetLines.push(`\x1b[2m📚 Queued (${count}): \x1b[0m\x1b[36m${names}\x1b[0m\x1b[2m — will be applied to next message\x1b[0m`);
	}
	if (pinnedSkills.length > 0) {
		const names = formatSkillList(pinnedSkills);
		statusParts.push(`📌 ${names}`);
		widgetLines.push(`\x1b[2m📌 Pinned: \x1b[0m\x1b[36m${names}\x1b[0m\x1b[2m — active as instructions\x1b[0m`);
	}

	ctx.ui.setStatus("skill", statusParts.join("  "));
	ctx.ui.setWidget("skill", widgetLines);
}

/**
 * Simple fuzzy match scoring. Expects query and text to be pre-lowercased.
 */
export function fuzzyScore(query: string, text: string): number {
	if (text.includes(query)) {
		return 100 + (query.length / text.length) * 50;
	}

	let score = 0;
	let queryIndex = 0;
	let consecutiveBonus = 0;

	for (let i = 0; i < text.length && queryIndex < query.length; i++) {
		if (text[i] === query[queryIndex]) {
			score += 10 + consecutiveBonus;
			consecutiveBonus += 5;
			queryIndex++;
		} else {
			consecutiveBonus = 0;
		}
	}

	return queryIndex === query.length ? score : 0;
}

/**
 * Filter and sort skills by fuzzy match
 */
export function filterSkills(skills: Skill[], query: string): Skill[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return skills;

	const scored: Array<{ skill: Skill; score: number }> = [];
	for (const skill of skills) {
		const score = Math.max(
			fuzzyScore(normalizedQuery, skill.searchName),
			fuzzyScore(normalizedQuery, skill.searchDescription) * 0.8
		);
		if (score > 0) scored.push({ skill, score });
	}
	scored.sort((a, b) => b.score - a.score || a.skill.sortIndex - b.skill.sortIndex);
	return scored.map((item) => item.skill);
}

interface ParsedSkillCommands {
	skills: Skill[];
	prompt: string;
}

interface SkillCompletionToken {
	prefix: string;
	selectedNames: Set<string>;
}

const SKILL_COMMAND_PREFIX = "/skill:";

function isCommandBoundary(char: string | undefined): boolean {
	return char === undefined || /[\s,]/.test(char);
}

function matchSkillAt(text: string, index: number, skills: Skill[]): Skill | null {
	for (const skill of skills) {
		if (text.startsWith(skill.name, index) && isCommandBoundary(text[index + skill.name.length])) {
			return skill;
		}
	}
	return null;
}

export function parseSkillCommands(text: string, skills: Skill[]): ParsedSkillCommands | null {
	let index = 0;
	let first = true;
	const selected: Skill[] = [];
	const sortedSkills = [...skills].sort((a, b) => b.name.length - a.name.length);

	while (index < text.length) {
		while (/\s/.test(text[index] ?? "")) index++;

		if (first) {
			if (!text.startsWith(SKILL_COMMAND_PREFIX, index)) return null;
			index += SKILL_COMMAND_PREFIX.length;
		} else if (text.startsWith(SKILL_COMMAND_PREFIX, index)) {
			index += SKILL_COMMAND_PREFIX.length;
		} else if (text[index] === ",") {
			index++;
			while (/\s/.test(text[index] ?? "")) index++;
			if (text.startsWith(SKILL_COMMAND_PREFIX, index)) {
				index += SKILL_COMMAND_PREFIX.length;
			}
		} else {
			break;
		}

		const skill = matchSkillAt(text, index, sortedSkills);
		if (!skill) return null;
		selected.push(skill);
		index += skill.name.length;
		first = false;
	}

	return selected.length > 0 ? { skills: selected, prompt: text.slice(index).trimStart() } : null;
}

function findSkillCompletionToken(textBeforeCursor: string): SkillCompletionToken | null {
	const commandStart = textBeforeCursor.search(/\S/);
	if (commandStart === -1 || !textBeforeCursor.startsWith(SKILL_COMMAND_PREFIX, commandStart)) return null;

	let index = commandStart + SKILL_COMMAND_PREFIX.length;
	const selectedNames = new Set<string>();

	while (index <= textBeforeCursor.length) {
		const tokenStart = index;
		while (index < textBeforeCursor.length && !/[\s,]/.test(textBeforeCursor[index] ?? "")) index++;

		const token = textBeforeCursor.slice(tokenStart, index);
		if (index === textBeforeCursor.length) return { prefix: token, selectedNames };

		if (token) selectedNames.add(token);

		if (textBeforeCursor[index] === ",") {
			index++;
			while (/[\t ]/.test(textBeforeCursor[index] ?? "")) index++;
			if (textBeforeCursor.startsWith(SKILL_COMMAND_PREFIX, index)) {
				index += SKILL_COMMAND_PREFIX.length;
			}
			if (index === textBeforeCursor.length) return { prefix: "", selectedNames };
			continue;
		}

		while (/\s/.test(textBeforeCursor[index] ?? "")) index++;
		if (!textBeforeCursor.startsWith(SKILL_COMMAND_PREFIX, index)) return null;
		index += SKILL_COMMAND_PREFIX.length;
		if (index === textBeforeCursor.length) return { prefix: "", selectedNames };
	}

	return null;
}

export function filterCompletionSkills(
	skills: readonly Skill[],
	prefix: string,
	selectedNames: ReadonlySet<string>,
	queuedSkills: readonly Skill[],
	policy: EffectivePolicy,
): Skill[] | null {
	const exposed = firstWinnerPerName(skills);
	// Occupancy is source-path based: queued entries plus the resolved first-winner of each
	// typed name, so same-name shadows cannot inflate or under-count the remaining slots.
	const occupied = new Set(queuedSkills.map(skillKey));
	for (const name of selectedNames) {
		const target = firstSkillByName(exposed, name);
		if (target) occupied.add(skillKey(target));
	}
	if (occupied.size >= MAX_QUEUED_SKILLS) return null;

	const suggestions = filterSkills(skillsEnabledByPolicy(exposed, policy), prefix)
		.filter((skill) => !occupied.has(skillKey(skill)));
	return suggestions.length > 0 ? suggestions : null;
}

export type SkillInputNotice = { level: "info" | "warning"; text: string };
export type SkillInputResult =
	| { action: "continue" }
	| { action: "handled"; notice: SkillInputNotice }
	| { action: "transform"; text: string; notice: SkillInputNotice };

function disabledNotice(disabled: Skill[], rejectedWhileQueueing: boolean): SkillInputNotice {
	const names = disabled.map((skill) => `"${skill.name}"`).join(", ");
	const subject = disabled.length === 1 ? `Skill ${names} is disabled` : `Skills ${names} are disabled`;
	return {
		level: "warning",
		text: rejectedWhileQueueing
			? `${subject} — nothing was queued. Re-enable in /skill Global or Project.`
			: `${subject}. Re-enable it in /skill Global or Project.`,
	};
}

export function handleSkillInput(
	event: { source: InputSource; text: string },
	skills: Skill[],
	policy: EffectivePolicy,
): SkillInputResult {
	// A policy change drops pending entries here, so nothing disabled can be injected later.
	pruneDisabledPendingSkills(policy);

	const parsed = parseSkillCommands(event.text, skills);
	if (parsed && parsed.skills.length > 1) {
		const uniqueSkills = parsed.skills.filter((skill, index, candidates) =>
			candidates.findIndex((candidate) => skillKey(candidate) === skillKey(skill)) === index
		);
		// All-or-nothing: validate every target before any queue mutation, so a rejected
		// command can never inject an enabled sibling.
		const gate = resolveInvocationPolicy(uniqueSkills, policy);
		if (!gate.allowed) {
			return { action: "handled", notice: disabledNotice(gate.disabled, true) };
		}
		// Preserve the palette's extension-originated input behavior once policy allows it.
		if (event.source === "extension") {
			return { action: "continue" };
		}

		// Slash-loaded skills stay one-shot, even if a skill declares pinned: true.
		const queueResult = queueSkills(uniqueSkills);
		if (queueResult.status === "full") {
			return {
				action: "handled",
				notice: { level: "warning", text: `You can load up to ${MAX_QUEUED_SKILLS} different skills at once.` },
			};
		}
		const notice: SkillInputNotice = {
			level: "info",
			text: `Queued ${state.queuedSkills.length}/${MAX_QUEUED_SKILLS} skills: ${formatSkillList(state.queuedSkills)}`,
		};
		return parsed.prompt ? { action: "transform", text: parsed.prompt, notice } : { action: "handled", notice };
	}

	// A native single invocation is expanded by pi itself; only a disabled winner is blocked.
	const winner = resolveNativeSkillTarget(skills, event.text);
	if (!winner || policy.isEnabled(skillKey(winner))) {
		return { action: "continue" };
	}
	return { action: "handled", notice: disabledNotice([winner], false) };
}

function createSkillAutocompleteProvider(current: AutocompleteProvider, pi: ExtensionAPI): AutocompleteProvider {
	return {
		triggerCharacters: [":", ","],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			if (startupContext !== undefined) ensureStartupPolicy(pi, startupContext);
			const line = lines[cursorLine] ?? "";
			const token = findSkillCompletionToken(line.slice(0, cursorCol));
			if (!token) {
				const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				if (!suggestions) return null;
				const commands = pi.getCommands();
				const disabledCommands = new Set(
					firstWinnerPerName(getCommandSkills(pi))
						.filter((skill) => !currentPolicy.isEnabled(skillKey(skill)))
						.map((skill) => `skill:${skill.name}`)
				);
				// Items lack source identity: keep ambiguous collisions; native input gating still applies.
				const ambiguousCommands = new Set(
					commands.filter((command) => command.source !== "skill" && disabledCommands.has(command.name)).map((command) => command.name)
				);
				const items = suggestions.items.filter(
					(item) => !disabledCommands.has(item.value) || ambiguousCommands.has(item.value)
				);
				return items.length > 0 ? { ...suggestions, items } : null;
			}

			const suggestions = filterCompletionSkills(
				getCommandSkills(pi),
				token.prefix,
				token.selectedNames,
				state.queuedSkills,
				currentPolicy,
			);
			if (suggestions === null) return null;

			return {
				prefix: token.prefix,
				items: suggestions.map((skill) => ({
					value: skill.name,
					label: skill.name,
					description: skill.description,
				})),
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

/**
 * Confirmation Dialog Component
 */
class ConfirmDialog {
	private selected = 1; // 0 = Remove, 1 = Keep (default to Keep)
	private timeoutId: ReturnType<typeof setTimeout> | null = null;
	private remainingSeconds = 30;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private requestRender: (() => void) | null = null;

	constructor(
		private skillName: string,
		private done: (confirmed: boolean) => void
	) {
		this.timeoutId = setTimeout(() => {
			this.cleanup();
			this.done(false);
		}, 30000);
	}

	/** Call after construction to start the countdown timer */
	setRequestRender(fn: () => void): void {
		this.requestRender = fn;
		// Start interval now that we can trigger re-renders
		this.intervalId = setInterval(() => {
			if (this.remainingSeconds > 0) {
				this.remainingSeconds--;
				this.requestRender?.();
			}
		}, 1000);
	}

	private cleanup(): void {
		if (this.timeoutId) clearTimeout(this.timeoutId);
		if (this.intervalId) clearInterval(this.intervalId);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.cleanup();
			this.done(false);
			return;
		}

		if (matchesKey(data, "return")) {
			this.cleanup();
			this.done(this.selected === 0);
			return;
		}

		if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.selected = this.selected === 0 ? 1 : 0;
			return;
		}

		if (data === "y" || data === "Y") {
			this.cleanup();
			this.done(true);
			return;
		}

		if (data === "n" || data === "N") {
			this.cleanup();
			this.done(false);
			return;
		}
	}

	render(width: number): string[] {
		const innerW = width - 2;
		const lines: string[] = [];

		// Theme-aware color helpers
		const t = paletteTheme;
		const border = (s: string) => fg(t.border, s);
		const title = (s: string) => fg(t.title, s);
		const selected = (s: string) => fg(t.selected, s);
		const confirm = (s: string) => fg(t.confirm, s);
		const cancel = (s: string) => fg(t.cancel, s);
		const hint = (s: string) => fg(t.hint, s);
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
		const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

		const visLen = visibleWidth;

		const center = (s: string, len: number) => {
			const truncated = truncateToWidth(s, len, "…");
			const padding = Math.max(0, len - visLen(truncated));
			const left = Math.floor(padding / 2);
			return " ".repeat(left) + truncated + " ".repeat(padding - left);
		};

		const centerRow = (content: string) => border("│") + center(content, innerW) + border("│");
		const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

		// Top border with title
		const titleText = " Remove Skill ";
		const borderLen = innerW - visLen(titleText);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(border("╭" + "─".repeat(leftBorder)) + title(titleText) + border("─".repeat(rightBorder) + "╮"));

		lines.push(emptyRow());

		// Skill name with icon
		lines.push(centerRow(`${selected("◆")} ${bold(this.skillName)}`));

		lines.push(emptyRow());

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		lines.push(emptyRow());

		// Buttons - pill style with inverse for selection
		const removeLabel = "  Remove  ";
		const keepLabel = "  Keep  ";

		const removeBtn = this.selected === 0
			? inverse(bold(cancel(removeLabel)))
			: hint(removeLabel);
		const keepBtn = this.selected === 1
			? inverse(bold(confirm(keepLabel)))
			: hint(keepLabel);

		lines.push(centerRow(`${removeBtn}   ${keepBtn}`));

		lines.push(emptyRow());

		// Timeout - rainbow progress indicator
		const prog = Math.max(0, Math.min(10, Math.round((this.remainingSeconds / 30) * 10)));
		const progressBar = rainbowProgress(prog, 10);
		lines.push(centerRow(`${progressBar}  ${hint(`${this.remainingSeconds}s`)}`));

		lines.push(emptyRow());

		// Footer hints - minimal
		lines.push(centerRow(hint(italic("tab") + " switch  " + italic("enter") + " confirm  " + italic("esc") + " cancel")));

		// Bottom border
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.cleanup();
	}
}

/**
 * Skill Palette Overlay Component
 */
export type PaletteSection = "load" | "global" | "project" | "config";

export interface PaletteOverlayOptions {
	initialSection?: PaletteSection;
	/** Load candidates: the exposed catalog after effective-policy filtering. */
	skills: Skill[];
	/** Management rows: the exposed catalog before policy filtering (Off skills stay listed). */
	catalog: Skill[];
	queuedSkills: Skill[];
	pinnedSkills: Skill[];
	global: GlobalConfig;
	project: ProjectConfig;
	projectTrusted: boolean;
	globalIssues?: string[];
	projectIssues?: string[];
	/** Read-only skills lockfile entries used only for display pack labels. */
	lock?: SkillLockEntries;
	save(pending: PendingPolicy): void;
}

type ManageRow =
	| { kind: "master" }
	| { kind: "skill"; skill: Skill; pack: string };

const SECTION_TABS: ReadonlyArray<{ section: PaletteSection; label: string }> = [
	{ section: "load", label: "Load" },
	{ section: "global", label: "Global" },
	{ section: "project", label: "Project" },
	{ section: "config", label: "Config" },
];

export class SkillPaletteComponent {
	private allSkills: Skill[];
	private filtered: Skill[];
	private selected = 0;
	private query = "";
	private previousQuery = "";

	private queuedSkillKeys: Set<string>;
	private queuedSkillCount: number;
	private pinnedSkillKeys: Set<string>;
	private pinnedSkillCount: number;

	private section: PaletteSection;
	private readonly catalog: Skill[];
	private readonly pending: { global: GlobalPending; project: ProjectPending };
	private savedGlobal: GlobalConfig;
	private savedProject: ProjectConfig;
	private readonly projectTrusted: boolean;
	private readonly globalIssues: string[];
	private readonly projectIssues: string[];
	private readonly lock: SkillLockEntries;
	private readonly save: (pending: PendingPolicy) => void;
	private readonly borderRule = new DynamicBorder((text: string) => fg(paletteTheme.border, text));
	private manageQuery = "";
	private manageSelected = 0;
	private error: string | null = null;
	private notice: string | null = null;

	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
	private static readonly INACTIVITY_MS = 60000; // Auto-dismiss after 60s of no input

	constructor(
		options: PaletteOverlayOptions,
		private done: (result: PaletteResult) => void,
		private readonly viewportHeight?: () => number | undefined
	) {
		this.allSkills = options.skills;
		this.filtered = options.skills;
		this.queuedSkillKeys = new Set(options.queuedSkills.map(skillKey));
		this.queuedSkillCount = options.queuedSkills.length;
		this.pinnedSkillKeys = new Set(options.pinnedSkills.map(skillKey));
		this.pinnedSkillCount = options.pinnedSkills.length;
		this.section = options.initialSection ?? "load";
		this.catalog = options.catalog;
		this.savedGlobal = options.global;
		this.savedProject = options.project;
		this.projectTrusted = options.projectTrusted;
		this.globalIssues = options.globalIssues ?? [];
		this.projectIssues = options.projectIssues ?? [];
		this.lock = options.lock ?? {};
		this.save = options.save;
		this.pending = {
			global: createPending("global", options.global, options.project),
			project: createPending("project", options.global, options.project),
		};
		this.resetInactivityTimeout();
	}

	getSection(): PaletteSection {
		return this.section;
	}

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = setTimeout(() => {
			// An idle timeout is an implicit discard, so pending management edits keep the overlay open.
			if (this.managementDirty()) {
				this.resetInactivityTimeout();
				return;
			}
			this.cleanup();
			this.done({ action: "cancel", skill: null });
		}, SkillPaletteComponent.INACTIVITY_MS);
	}

	handleInput(data: string): void {
		this.resetInactivityTimeout(); // Reset on any input
		this.error = null;

		if (matchesKey(data, "escape")) {
			this.cleanup();
			this.done({ action: "cancel", skill: null });
			return;
		}

		// Management binds Left/Right in addition to the original Load keys.
		if (matchesKey(data, "left")) {
			this.changeSection(-1);
			return;
		}
		if (matchesKey(data, "right")) {
			this.changeSection(1);
			return;
		}

		if (this.section === "load") {
			this.handleLoadInput(data);
			return;
		}
		this.handleManageInput(data);
	}

	private handleLoadInput(data: string): void {
		if (matchesKey(data, "return")) {
			if (this.managementDirty()) {
				this.notice = this.unsavedNotice();
				return;
			}
			const skill = this.filtered[this.selected];
			if (skill) {
				this.cleanup();
				if (this.pinnedSkillKeys.has(skillKey(skill))) {
					this.done({ action: "unpin", skill });
				} else if (this.queuedSkillKeys.has(skillKey(skill))) {
					this.done({ action: "unqueue", skill });
				} else {
					this.done({ action: skill.pinByDefault ? "pin" : "select", skill });
				}
			}
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === 0 ? this.filtered.length - 1 : this.selected - 1;
			}
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
			}
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.updateFilter();
			}
			return;
		}

		// Load keeps literal spaces in the fuzzy query.
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.updateFilter();
		}
	}

	private handleManageInput(data: string): void {
		const rows = this.manageRows();

		if (matchesKey(data, "return")) {
			this.commitManage();
			return;
		}

		if (matchesKey(data, "up")) {
			this.manageSelected = Math.max(0, this.manageSelected - 1);
			this.notice = null;
			return;
		}

		if (matchesKey(data, "down")) {
			this.manageSelected = Math.min(Math.max(0, rows.length - 1), this.manageSelected + 1);
			this.notice = null;
			return;
		}

		if (matchesKey(data, "tab")) {
			this.stagePack(rows);
			return;
		}

		if (data === " ") {
			this.stageRow(rows);
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.manageQuery.length > 0) {
				// One code point, not one UTF-16 unit: backspace must never split a surrogate pair.
				this.manageQuery = Array.from(this.manageQuery).slice(0, -1).join("");
				this.manageSelected = 0;
			}
			return;
		}

		// Space already staged the focused row, so the filter takes any other printable,
		// non-whitespace code point — including multibyte CJK and surrogate-pair emoji.
		if (Array.from(data).length === 1 && !/[\s\p{C}]/u.test(data)) {
			this.manageQuery += data;
			this.manageSelected = 0;
		}
	}

	private updateFilter(): void {
		// Extending the query can only shrink the match set, so narrow over the
		// previous results; any other edit (backspace, paste) rescans all skills.
		const candidates = this.query.startsWith(this.previousQuery) ? this.filtered : this.allSkills;
		this.filtered = filterSkills(candidates, this.query);
		this.previousQuery = this.query;
		this.selected = 0; // Always jump to top match when typing
	}

	private activeScope(): ManageScope {
		return this.section === "project" ? "project" : "global";
	}

	private manageRows(): ManageRow[] {
		const query = this.manageQuery.trim().toLowerCase();
		if (this.section === "config") return [];
		const skills = firstWinnerPerName(this.catalog)
			.map((skill) => ({ skill, pack: packLabel(skill, this.lock) }))
			.sort((left, right) => left.pack.localeCompare(right.pack) || left.skill.name.localeCompare(right.skill.name))
			.filter((row) => !query || `${row.pack}/${row.skill.name}`.toLowerCase().includes(query))
			.map((row): ManageRow => ({ kind: "skill", skill: row.skill, pack: row.pack }));
		// The Global master switch is a row only while the list is unfiltered.
		return this.section === "global" && query === "" ? [{ kind: "master" }, ...skills] : skills;
	}

	private changeSection(direction: 1 | -1): void {
		const index = SECTION_TABS.findIndex((tab) => tab.section === this.section);
		const next = SECTION_TABS[(index + direction + SECTION_TABS.length) % SECTION_TABS.length].section;
		if (next === this.section) return;
		if (!this.canEnterSection(next)) return;
		this.section = next;
		this.manageQuery = "";
		this.manageSelected = 0;
		this.notice = null;
	}

	/**
	 * Global and Project are separate files, so a scope switch with pending edits is blocked
	 * instead of silently dropping or writing a half-applied pair.
	 */
	private canEnterSection(next: PaletteSection): boolean {
		if (next === "project" && this.isDirty("global")) {
			this.notice = "Unsaved Global changes — press Enter to save them or Esc to discard before switching.";
			return false;
		}
		if ((next === "global" || next === "config") && this.isDirty("project")) {
			this.notice = "Unsaved Project changes — press Enter to save them or Esc to discard before switching.";
			return false;
		}
		return true;
	}

	/** An untrusted Project is read-only: staging keys must not create phantom pending edits. */
	private projectEditable(): boolean {
		if (this.section !== "project" || this.projectTrusted) return true;
		this.notice = "Project policy is locked: this project is not trusted.";
		return false;
	}

	private isDirty(scope: ManageScope): boolean {
		const saved = scope === "global" ? this.savedGlobal : this.savedProject;
		return isPendingDirty(saved, this.pending[scope]);
	}

	/** Load may only close when neither management scope has unsaved edits. */
	private managementDirty(): boolean {
		return this.isDirty("global") || this.isDirty("project");
	}

	private unsavedNotice(): string {
		const scopes = [
			this.isDirty("global") ? "Global" : null,
			this.isDirty("project") ? "Project" : null,
		].filter((scope): scope is string => scope !== null);
		return `Unsaved ${scopes.join(" and ")} changes — press Enter on its tab to save, or Esc to discard.`;
	}

	private stageRow(rows: ManageRow[]): void {
		if (!this.projectEditable()) return;
		const row = rows[this.manageSelected];
		if (this.section === "config") {
			this.pending.global = { ...this.pending.global, show_paths: this.pending.global.show_paths === false };
			this.notice = null;
			return;
		}
		if (!row) return;
		this.notice = null;
		if (row.kind === "master") {
			this.pending.global = togglePendingMaster(this.pending.global);
			return;
		}
		if (this.section === "project") {
			this.pending.project = togglePendingRow(this.pending.project, skillKey(row.skill));
		} else {
			this.pending.global = togglePendingRow(this.pending.global, skillKey(row.skill));
		}
	}

	private stagePack(rows: ManageRow[]): void {
		if (!this.projectEditable()) return;
		const row = rows[this.manageSelected];
		if (!row || row.kind !== "skill") return;
		// Bulk stages the pack as SHOWN: with an active filter only visible members change.
		const skills = rows.flatMap((candidate) =>
			candidate.kind === "skill" && candidate.pack === row.pack ? [candidate.skill] : []
		);
		if (this.section === "project") {
			this.pending.project = togglePendingPack(this.pending.project, skills);
		} else {
			this.pending.global = togglePendingPack(this.pending.global, skills);
		}
		this.notice = null;
	}

	private commitManage(): void {
		if (this.section === "load") return;
		const scope = this.activeScope();
		if (scope === "project" && !this.projectTrusted) {
			this.notice = "Project policy is locked: this project is not trusted, so nothing was saved.";
			return;
		}
		const pending = scope === "global" ? this.pending.global : this.pending.project;
		try {
			// Save first: runtime policy and pending skills change only on success.
			this.save(pending);
		} catch (error) {
			this.error = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
			return;
		}
		if (pending.scope === "global") {
			this.savedGlobal = {
				...this.savedGlobal,
				disabled: pending.disabled,
				off: pending.off,
				...(pending.show_paths === undefined ? {} : { show_paths: pending.show_paths }),
			};
		} else {
			this.savedProject = { ...this.savedProject, overrides: pending.overrides };
		}
		this.cleanup();
		this.done({ action: "saved", scope: pending.scope, masterOff: pending.scope === "global" && pending.off });
	}

	private pendingGlobalConfig(): GlobalConfig {
		const pending = this.pending.global;
		return {
			...this.savedGlobal,
			disabled: pending.scope === "global" ? pending.disabled : {},
			off: pending.scope === "global" ? pending.off : false,
			...(pending.show_paths === undefined ? {} : { show_paths: pending.show_paths }),
		};
	}

	private pendingProjectConfig(): ProjectConfig {
		const pending = this.pending.project;
		return { ...this.savedProject, overrides: pending.scope === "project" ? pending.overrides : {} };
	}

	render(width: number): string[] {
		const innerW = Math.max(1, width - 2);
		const lines: string[] = [];

		// Theme-aware color helpers
		const t = paletteTheme;
		const border = (s: string) => fg(t.border, s);
		const title = (s: string) => fg(t.title, s);
		const selected = (s: string) => fg(t.selected, s);
		const selectedText = (s: string) => fg(t.selectedText, s);
		const queued = (s: string) => fg(t.queued, s);
		const searchIcon = (s: string) => fg(t.searchIcon, s);
		const placeholder = (s: string) => fg(t.placeholder, s);
		const description = (s: string) => fg(t.description, s);
		const hint = (s: string) => fg(t.hint, s);
		const warning = (s: string) => fg(t.cancel, s);
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
		const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

		const visLen = visibleWidth;

		const wrapWidth = Math.max(1, innerW - 1);
		const row = (content: string) => border("│") + truncateToWidth(" " + content, innerW, "…", true) + border("│");
		const wrappedRows = (content: string) => {
			for (const wrapped of wrapTextWithAnsi(content, wrapWidth)) lines.push(row(wrapped));
		};
		const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

		// Top border with title
		const titleText = " Skills ";
		const borderLen = Math.max(0, innerW - visLen(titleText));
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(border("╭" + "─".repeat(leftBorder)) + title(titleText) + border("─".repeat(rightBorder) + "╮"));

		lines.push(emptyRow());

		// One overlay hosts all four sections; Left/Right changes the active tab.
		const tabs = SECTION_TABS.map((tab) =>
			tab.section === this.section ? inverse(bold(` ${tab.label} `)) : hint(` ${tab.label} `)
		).join(" ");
		lines.push(row(tabs));
		// Explicit color function: jiti keeps a separate module cache, so DynamicBorder's default is unreliable here.
		lines.push(border("│") + this.borderRule.render(innerW).join("") + border("│"));

		if (this.section === "load") {
			// Search input - clean underlined style
			const cursor = selected("│");
			const searchIconChar = searchIcon("◎");
			const queryDisplay = this.query
				? `${this.query}${cursor}`
				: `${cursor}${placeholder(italic("type to filter..."))}`;
			lines.push(row(`${searchIconChar}  ${queryDisplay}`));

			lines.push(emptyRow());
			lines.push(border("├" + "─".repeat(innerW) + "┤"));

			// Skills list
			const maxVisible = 8;
			const startIndex = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
			const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

			if (this.filtered.length === 0) {
				lines.push(emptyRow());
				lines.push(row(hint(italic("No matching skills"))));
				lines.push(emptyRow());
			} else {
				lines.push(emptyRow());
				for (let i = startIndex; i < endIndex; i++) {
					const skill = this.filtered[i];
					const isSelected = i === this.selected;
					const isQueued = this.queuedSkillKeys.has(skillKey(skill));
					const isPinned = this.pinnedSkillKeys.has(skillKey(skill));

					const prefix = isSelected ? selected("▸") : border("·");
					let activeBadge = "";
					if (isPinned) {
						activeBadge = ` ${queued("◆")}`;
					} else if (isQueued) {
						activeBadge = ` ${queued("●")}`;
					} else if (skill.pinByDefault) {
						activeBadge = ` ${hint("◇")}`;
					}
					const nameStr = isSelected ? bold(selectedText(skill.name)) : skill.name;
					const maxDescLen = Math.max(0, innerW - visLen(skill.name) - 12);
					const descStr = maxDescLen > 3 ? description(truncateToWidth(skill.description, maxDescLen, "…")) : "";

					const separator = descStr ? `  ${border("—")}  ` : "";
					const skillLine = `${prefix} ${nameStr}${activeBadge}${separator}${descStr}`;
					lines.push(row(skillLine));
				}
				lines.push(emptyRow());

				// Scroll position indicator - rainbow dots
				if (this.filtered.length > maxVisible) {
					const prog = Math.round(((this.selected + 1) / this.filtered.length) * 10);
					const progressBar = rainbowProgress(prog, 10);
					const countStr = `${this.selected + 1}/${this.filtered.length}`;
					lines.push(row(`${progressBar}  ${hint(countStr)}`));
					lines.push(emptyRow());
				}
			}

			lines.push(border("├" + "─".repeat(innerW) + "┤"));
			if (this.error || this.notice) wrappedRows(warning(this.error ?? this.notice ?? ""));
			lines.push(emptyRow());

			const count = `${this.queuedSkillCount}/${MAX_QUEUED_SKILLS}`;
			const pinned = this.pinnedSkillCount > 0 ? `  ${hint(`${this.pinnedSkillCount} pinned`)}` : "";
			const action = this.queuedSkillCount > 0 || this.pinnedSkillCount > 0 ? `select${hint("/")}remove` : "select";
			const hints = `${italic("↑↓")} navigate  ${italic("enter")} ${action}  ${hint(count)} queued${pinned}  ${italic("←→")} section  ${italic("esc")} cancel`;
			lines.push(row(hint(hints)));
		} else {
			const scope = this.activeScope();
			const rows = this.manageRows();
			this.manageSelected = Math.min(this.manageSelected, Math.max(0, rows.length - 1));

			const pendingGlobal = this.pendingGlobalConfig();
			const pendingProject = this.pendingProjectConfig();
			const summary = formatEffectiveSummary(pendingGlobal, pendingProject, this.projectTrusted, this.catalog);
			const globalMarker = summary.indexOf(" · global ");
			if (visLen(summary) <= innerW - 1 || globalMarker === -1) {
				wrappedRows(description(summary));
			} else {
				wrappedRows(description(summary.slice(0, globalMarker)));
				wrappedRows(description(summary.slice(globalMarker + 3)));
			}
			if (this.section !== "config") lines.push(row(`${searchIcon("◎")}  filter: ${this.manageQuery ? this.manageQuery : placeholder(italic("…"))}`));

			const issues = scope === "global" ? this.globalIssues : this.projectIssues;
			if (issues.length > 0) wrappedRows(warning(issues[0]));

			lines.push(emptyRow());
			lines.push(border("├" + "─".repeat(innerW) + "┤"));
			const feedback = this.error ?? this.notice;
			const scopeHint = scope === "global" ? "space toggle" : "space on/off/inherit";
			const navigationHelp = `${italic("↑↓")} move  ${italic("←→")} section  ${italic(scopeHint)}`;
			const actionHelp = this.section === "config"
				? `${italic("enter")} save  ${italic("esc")} discard`
				: `${italic("tab")} pack  ${italic("enter")} save  ${italic("esc")} discard`;
			const combinedHelp = `${navigationHelp}  ${actionHelp}`;
			const feedbackRows = feedback ? wrapTextWithAnsi(warning(feedback), wrapWidth).length : 1;
			const helpRows = visLen(combinedHelp) <= wrapWidth
				? wrapTextWithAnsi(hint(combinedHelp), wrapWidth).length
				: wrapTextWithAnsi(hint(navigationHelp), wrapWidth).length + wrapTextWithAnsi(hint(actionHelp), wrapWidth).length;
			const footerRows = 2 + feedbackRows + helpRows; // Divider, bottom border, and full feedback/help.
			if (this.section === "config") {
				lines.push(emptyRow());
				const pathsOn = this.pending.global.show_paths !== false;
				const box = pathsOn ? queued("●") : hint("○");
				lines.push(row(`${selected("▸")} ${box} ${bold("Show skill file paths")} · ${pathsOn ? queued("On") : hint("Off")}`));
				lines.push(emptyRow());
			} else if (scope === "project" && !this.projectTrusted) {
				lines.push(row(warning("Project policy is locked: this project is not trusted.")));
				lines.push(row(hint("No project policy file was read, and nothing can be saved here.")));
				lines.push(emptyRow());
			} else {
				const maxVisible = 8;
				let startIndex = Math.max(0, Math.min(this.manageSelected - Math.floor(maxVisible / 2), rows.length - maxVisible));
				let endIndex = Math.min(startIndex + maxVisible, rows.length);
				const renderWindow = (start: number, end: number): string[] => {
					const windowLines: string[] = [];
					// Reset the pack so the first visible skill retains its context.
					let previousPack: string | null = null;
					const pending = scope === "global" ? this.pending.global : this.pending.project;
					for (let i = start; i < end; i++) {
						const manageRow = rows[i];
						const active = i === this.manageSelected;
						if (manageRow.kind === "master") {
							previousPack = null;
							const on = !this.pending.global.off;
							const box = on ? queued("●") : hint("○");
							const label = on ? "Master switch: restrictions on" : "Master switch: OFF, restrictions bypassed";
							windowLines.push(row(`${active ? selected("▸") : border("·")} ${box} ${on ? label : bold(warning(label))}`));
							continue;
						}
						if (manageRow.pack !== previousPack) {
							if (previousPack !== null) windowLines.push(row(""));
							const label = `── ${manageRow.pack}`;
							const ruleLength = Math.max(0, innerW - visLen(label) - 2);
							windowLines.push(row(`${title(label)} ${border("─".repeat(ruleLength))}`));
							previousPack = manageRow.pack;
						}
						const key = skillKey(manageRow.skill);
						let box: string;
						if (pending.scope === "global") {
							box = pending.disabled[key] === true ? hint("○") : queued("●");
						} else {
							const override = pending.overrides[key];
							box = override === "on" ? queued("●") : override === "off" ? hint("○") : hint("[~]");
						}
						const effective = formatEffectiveState(manageRow.skill, pendingGlobal, pendingProject, this.projectTrusted);
						const name = active ? bold(selectedText(manageRow.skill.name)) : manageRow.skill.name;
						const left = `${active ? selected("▸") : border("·")} ${box} ${name}${hint(formatNativeTag(manageRow.skill))} · ${hint(effective)}`;
						const fullPath = this.pending.global.show_paths === false ? "" : formatSkillPathLabel(manageRow.skill);
						const pathBudget = innerW - visLen(left) - 4;
						if (fullPath && pathBudget > 8 && visLen(fullPath) <= pathBudget) {
							windowLines.push(row(`${left}  ${description(fullPath)}`));
						} else {
							windowLines.push(row(left));
							if (fullPath) {
								for (const part of wrapTextWithAnsi(description(fullPath), Math.max(1, innerW - 5))) {
									windowLines.push(row(`    ${part}`));
								}
							}
						}
					}
					return windowLines;
				};

				if (rows.length === 0) {
					lines.push(emptyRow());
					lines.push(row(hint(italic("No matching skills"))));
				} else {
					let windowLines = renderWindow(startIndex, endIndex);
					const viewportHeight = this.viewportHeight?.();
					const listBudget = viewportHeight === undefined ? Infinity : Math.max(0, viewportHeight - lines.length - footerRows);
					while (windowLines.length > listBudget && endIndex - startIndex > 1) {
						if (this.manageSelected - startIndex < endIndex - 1 - this.manageSelected) endIndex--;
						else startIndex++;
						windowLines = renderWindow(startIndex, endIndex);
					}
					lines.push(...windowLines);
				}
			}

			lines.push(border("├" + "─".repeat(innerW) + "┤"));
			if (feedback) wrappedRows(warning(feedback));
			else lines.push(row(""));
			if (visLen(combinedHelp) <= innerW - 1) wrappedRows(hint(combinedHelp));
			else {
				wrappedRows(hint(navigationHelp));
				wrappedRows(hint(actionHelp));
			}
		}

		// Bottom border
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	private cleanup(): void {
		if (this.inactivityTimeout) {
			clearTimeout(this.inactivityTimeout);
			this.inactivityTimeout = null;
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.cleanup();
	}
}

function extractTextPart(value: unknown): string {
	if (typeof value !== "object" || value === null || !("type" in value)) return "";

	const part = value as { type?: unknown; text?: unknown };
	if (part.type !== "text") return "";
	return typeof part.text === "string" ? part.text : "";
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content.map(extractTextPart).join("");
}

async function openPalette(ctx: ExtensionCommandContext, initialSection: PaletteSection): Promise<void> {
	const catalog = firstWinnerPerName(getLoadedSkills(ctx));
	if (catalog.length === 0 && initialSection === "load") {
		ctx.ui.setStatus("skill", "No skills found");
		setTimeout(() => ctx.ui.setStatus("skill", undefined), 3000);
		return;
	}
	// Load keeps policy filtering; management still lists every exposed skill.
	const skills = skillsEnabledByPolicy(catalog, currentPolicy);
	const agentDir = getAgentDir();
	const trusted = ctx.isProjectTrusted();
	const lock = loadSkillLock();
	const global = loadGlobalConfig(agentDir);
	const project = loadProjectConfig(ctx.cwd, trusted);

	const result = await ctx.ui.custom<PaletteResult>(
		(tui, _theme, _keybindings, done) => new SkillPaletteComponent(
			{
				initialSection,
				catalog,
				skills,
				queuedSkills: state.queuedSkills,
				pinnedSkills: state.pinnedSkills,
				global: global.state,
				project: project.state,
				projectTrusted: trusted,
				globalIssues: global.issues,
				projectIssues: project.issues,
				lock,
				save: (pending) => applyPendingPolicy({
					agentDir,
					cwd: ctx.cwd,
					trusted: ctx.isProjectTrusted(),
					pending,
				}),
			},
			done,
			() => tui.terminal?.rows
		),
		{ overlay: true, overlayOptions: { anchor: "center", width: 110 } }
	);

	switch (result.action) {
		case "cancel":
			return;
		case "saved":
			// Visibility is already live; only a Global master-off needs a reload.
			updateSkillIndicators(ctx);
			if (result.masterOff) await ctx.reload();
			return;
		case "select": {
			const queueResult = queueSkills([result.skill]);
			if (queueResult.status === "full") {
				ctx.ui.notify(`You can queue up to ${MAX_QUEUED_SKILLS} skills. Unqueue one first.`, "warning");
				return;
			}
			updateSkillIndicators(ctx);
			ctx.ui.notify(`Skill queued (${state.queuedSkills.length}/${MAX_QUEUED_SKILLS}): ${result.skill.name}`, "info");
			return;
		}
		case "pin":
			pinSkill(result.skill);
			updateSkillIndicators(ctx);
			ctx.ui.notify(`Skill pinned: ${result.skill.name}`, "info");
			return;
		case "unqueue":
		case "unpin": {
			const skill = result.skill;
			const confirmed = await ctx.ui.custom<boolean>(
				(tui, _theme, _keybindings, done) => {
					const dialog = new ConfirmDialog(skill.name, done);
					dialog.setRequestRender(() => tui.requestRender());
					return dialog;
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: 44 } }
			);

			if (!confirmed) return;
			if (result.action === "unqueue") {
				removeQueuedSkill(skill);
				ctx.ui.notify(`Skill unqueued: ${skill.name}`, "info");
			} else {
				removePinnedSkill(skill);
				ctx.ui.notify(`Skill unpinned: ${skill.name}`, "info");
			}
			updateSkillIndicators(ctx);
			return;
		}
	}
}

export default function skillPaletteExtension(pi: ExtensionAPI): void {
	// Register custom renderer for skill-context messages
	pi.registerMessageRenderer("skill-context", (message, options, theme) => {
		// Extract skill name and content (handle both string and array content)
		const rawContent = extractTextContent(message.content);
		const skillMatches = Array.from(rawContent.matchAll(/<skill name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/skill>/g));
		const skillNames = skillMatches.map((match) => match[1]);
		const skillTitle = skillNames.length > 1
			? `${skillNames.length}/${MAX_QUEUED_SKILLS} ${skillNames.join(", ")}`
			: skillNames[0] ?? "Unknown Skill";
		const skillContent = skillMatches.length > 1
			? skillMatches.map((match) => `# ${match[1]}\n${match[2].trim()}`).join("\n\n")
			: skillMatches[0]?.[2]?.trim() || rawContent;

		// Content preview (collapsible like read tool)
		const PREVIEW_LINES = 8;
		const parts = [
			theme.fg("accent", "◆ ") +
				theme.fg("customMessageLabel", theme.bold(skillNames.length > 1 ? "Skills: " : "Skill: ")) +
				theme.fg("accent", skillTitle),
		];
		// Dim each line separately so ANSI resets stay per-line, matching the old per-line Text output
		const lines = skillContent.split("\n");
		const shownLines = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
		parts.push(shownLines.map((line) => theme.fg("dim", line)).join("\n"));
		if (!options.expanded && lines.length > PREVIEW_LINES) {
			parts.push(theme.fg("muted", `... ${lines.length - PREVIEW_LINES} more lines (click to expand)`));
		}
		return new Text(parts.join("\n"), options.outputPad, 0);
	});

	// /skill opens Load; /skillmgr opens the same component on Global plus the compatibility verbs.
	pi.registerCommand("skill", {
		description: "Open skill palette to queue or pin a skill",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ensureStartupPolicy(pi, ctx);
			if (ctx.mode !== "tui") {
				notifyText(ctx, formatHeadlessSummary(ctx), "info");
				return;
			}
			await openPalette(ctx, "load");
		},
	});

	pi.registerCommand("skillmgr", {
		description: "Manage Global skill visibility, or disable/enable it",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			ensureStartupPolicy(pi, ctx);
			const verb = args.trim().toLowerCase();
			if (verb === "disable" || verb === "enable") {
				await setMasterBypass(ctx, verb === "disable");
				return;
			}
			if (verb !== "") {
				notifyText(ctx, "usage: /skillmgr [disable|enable]", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				notifyText(ctx, formatHeadlessSummary(ctx), "info");
				return;
			}
			await openPalette(ctx, "global");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		loadStartupPolicy(pi, ctx);
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, pi));
	});

	pi.on("input", (event, ctx) => {
		// Ordinary messages skip the catalog build; every /skill: input is gated from any source.
		if (!event.text.startsWith(SKILL_COMMAND_PREFIX)) {
			return { action: "continue" as const };
		}
		ensureStartupPolicy(pi, ctx);
		const queuedBefore = state.queuedSkills;
		const pinnedBefore = state.pinnedSkills;
		const result = handleSkillInput(event, getCommandSkills(pi), currentPolicy);
		// Pruning can happen on a continue result, so repaint indicators before returning.
		const pruned = queuedBefore !== state.queuedSkills || pinnedBefore !== state.pinnedSkills;
		if (ctx.hasUI && (pruned || result.action !== "continue")) {
			updateSkillIndicators(ctx);
		}
		if (result.action === "continue") {
			return { action: "continue" as const };
		}
		notifyText(ctx, result.notice.text, result.notice.level);
		if (result.action === "transform") {
			return { action: "transform" as const, text: result.text };
		}
		return { action: "handled" as const };
	});

	// Single policy-owned runtime handler: structured prompt filtering, queued bodies, pins.
	pi.on("before_agent_start", async (event, ctx) => {
		ensureStartupPolicy(pi, ctx);
		const runHandler = createBeforeAgentStartHandler({
			getPolicy: () => currentPolicy,
			getQueued: () => state.queuedSkills,
			getPinned: () => state.pinnedSkills,
			setQueued: (skills) => {
				state.queuedSkills = skills;
			},
			setPinned: (skills) => {
				state.pinnedSkills = skills;
			},
			notifyWarningOnce: (key, message) => {
				if (warnedOnceKeys.has(key)) return;
				warnedOnceKeys.add(key);
				notifyText(ctx, message, "warning");
			},
		});
		const queuedBefore = state.queuedSkills;
		const pinnedBefore = state.pinnedSkills;
		const result = await runHandler(event, ctx);
		if (ctx.hasUI && (queuedBefore !== state.queuedSkills || pinnedBefore !== state.pinnedSkills)) {
			updateSkillIndicators(ctx);
		}
		return result;
	});
}
