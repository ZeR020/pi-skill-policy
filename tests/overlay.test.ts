import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after, beforeEach, mock, test, type TestContext } from "node:test";

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Skill as HostSkill,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";

import type {
	PaletteOverlayOptions,
	PaletteResult,
	PaletteSection,
	Skill,
} from "../index.js";
import type { PendingPolicy } from "../src/manage-state.js";
import { resolvePolicy } from "../src/policy.js";
import { globalConfigPath, projectConfigPath } from "../src/storage.js";
import type { PaletteSkill } from "../src/skill-content.js";
import { fakeHome, writeFakeHomeTheme } from "./helpers/fake-home.js";
import { makeTempDir, skillEntry, sourceInfoFor } from "./helpers/fixtures.js";

const KEY = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	backspace: "\x7f",
} as const;

// Real TUI keybindings singleton: initialize it like InteractiveMode does and restore it after.
const originalKeybindings = getKeybindings();
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
after(() => setKeybindings(originalKeybindings));
// The palette theme is a module-scope read, so the isolated home needs a fixture theme before
// index.ts is evaluated; the marker color proves which home that read actually used.
const THEME_BORDER = writeFakeHomeTheme({ border: "35" });
const { default: skillPaletteExtension, SkillPaletteComponent, applyPendingPolicy, setCurrentPolicy, state } =
	await import("../index.js");
type PaletteComponent = InstanceType<typeof SkillPaletteComponent>;

const alpha = skillEntry("alpha");
const beta = skillEntry("beta");
const catalog: Skill[] = [alpha, beta];

const allowAll = resolvePolicy({}, null, false);

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

beforeEach(() => {
	state.queuedSkills = [];
	state.pinnedSkills = [];
	setCurrentPolicy(allowAll);
});

interface OverlayHarness {
	component: PaletteComponent;
	saves: PendingPolicy[];
	render(width?: number): string[];
	text(width?: number): string;
	result(): PaletteResult | undefined;
}

function overlay(t: TestContext, options: Partial<PaletteOverlayOptions> = {}): OverlayHarness {
	const saves: PendingPolicy[] = [];
	let result: PaletteResult | undefined;
	const component = new SkillPaletteComponent(
		{
			catalog,
			skills: catalog,
			queuedSkills: [],
			pinnedSkills: [],
			global: { version: 1, disabled: {} },
			project: { version: 1, overrides: {} },
			projectTrusted: true,
			save: (pending: PendingPolicy) => {
				saves.push(pending);
			},
			...options,
		},
		(value: PaletteResult | undefined) => {
			result = value;
		},
	);
	t.after(() => component.dispose());

	return {
		component,
		saves,
		render: (width = 70) => component.render(width),
		text: (width = 70) => strip(component.render(width).join("\n")),
		result: () => result,
	};
}
/** A palette skill at an explicit source path (pack grouping derives from it). */
function skillAt(name: string, sourcePath: string, overrides: Partial<PaletteSkill> = {}): PaletteSkill {
	return skillEntry(name, "", { filePath: sourcePath, sourceInfo: sourceInfoFor(sourcePath), ...overrides });
}

/** Skills sharing one installed git package, so they render under a single pack header. */
function packedSkill(name: string, pack: string): PaletteSkill {
	return skillAt(name, `${fakeHome}/.pi/agent/git/github.com/acme/${pack}/skills/${name}/SKILL.md`);
}

/** Structural view of any overlay the command opens: the palette itself or its confirm dialog. */
interface OverlayComponent {
	handleInput(data: string): void;
	render(width: number): string[];
}

interface CommandHarness {
	ctx: ExtensionCommandContext;
	component(): PaletteComponent;
	/** Every overlay the command opened, in order: the palette, then any confirmation dialog. */
	overlayComponents: OverlayComponent[];
	opens: unknown[];
	notifications: string[];
	reloads(): number;
	statuses: Array<string | undefined>;
}

function commandHandler(): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	skillPaletteExtension({
		registerMessageRenderer: () => {},
		registerCommand: (name: string, options: { handler: typeof handler }) => {
			// /skill and /skillmgr share this factory; these tests exercise the Load command.
			if (name === "skill") handler = options.handler;
		},
		on: () => {},
		getCommands: () => [],
	} as unknown as ExtensionAPI);
	assert.ok(handler, "the /skill command must stay registered");
	return handler;
}

function commandHarness(
	t: TestContext,
	overrides: { trusted?: boolean | (() => boolean); cwd?: string; skills?: HostSkill[] } = {},
): CommandHarness {
	const opens: unknown[] = [];
	const overlayComponents: OverlayComponent[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	let captured: PaletteComponent | undefined;
	let reloadCount = 0;
	t.after(() => captured?.dispose());
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: overrides.cwd ?? makeTempDir(t),
		isProjectTrusted: () => (typeof overrides.trusted === "function" ? overrides.trusted() : overrides.trusted ?? true),
		getSystemPromptOptions: () => ({ cwd: "/tmp/project", skills: overrides.skills ?? catalog }),
		reload: async () => {
			reloadCount += 1;
		},
		ui: {
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => PaletteComponent, options: unknown) => {
				opens.push(options);
				return new Promise((resolve) => {
					const component = factory({}, {}, {}, resolve as (value: unknown) => void);
					overlayComponents.push(component);
					if (component instanceof SkillPaletteComponent) captured = component;
				});
			},
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => {
				statuses.push(value);
			},
			setWidget: () => {},
		},
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		component: () => {
			assert.ok(captured, "the palette overlay must open");
			return captured;
		},
		overlayComponents,
		opens,
		notifications,
		reloads: () => reloadCount,
		statuses,
	};
}

function setAgentDir(t: TestContext): string {
	const agentDir = makeTempDir(t);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	return agentDir;
}

test("all four sections share one centered overlay", async (t) => {
	setAgentDir(t);
	const handler = commandHandler();
	const harness = commandHarness(t);

	const run = handler("", harness.ctx);
	const component = harness.component();
	const sections: PaletteSection[] = [component.getSection()];

	const tabs = strip(component.render(70).join("\n"));
	assert.match(tabs, /Load/);
	assert.match(tabs, /Global/);
	assert.match(tabs, /Project/);
	assert.match(tabs, /Config/);

	component.handleInput(KEY.right);
	sections.push(component.getSection());
	component.handleInput(KEY.right);
	sections.push(component.getSection());
	component.handleInput(KEY.right);
	sections.push(component.getSection());
	component.handleInput(KEY.right);
	sections.push(component.getSection());

	assert.deepEqual(sections, ["load", "global", "project", "config", "load"]);
	assert.deepEqual(harness.opens, [{ overlay: true, overlayOptions: { anchor: "center", width: 110 } }]);
	assert.equal(harness.opens.length, 1, "switching sections never opens another overlay");

	component.handleInput(KEY.escape);
	await run;
});

test("Load keeps literal Space in the fuzzy query and stages nothing", (t) => {
	const spaced = skillEntry("alpha", "al pha helper");
	const unspaced = skillEntry("beta", "alpha helper");
	const harness = overlay(t, { catalog: [spaced, unspaced], skills: [spaced, unspaced] });

	for (const char of "al pha") harness.component.handleInput(char);

	const text = harness.text();
	assert.match(text, /alpha/);
	assert.doesNotMatch(text, /beta/, "the Space belongs to the fuzzy query; beta only matches without it");
	assert.deepEqual(harness.saves, []);
});

test("Load keeps baseline Enter selection and removal behavior", (t) => {
	const selected = overlay(t);
	selected.component.handleInput(KEY.enter);
	assert.deepEqual(selected.result(), { action: "select", skill: alpha });

	const queued = overlay(t, { queuedSkills: [alpha] });
	queued.component.handleInput(KEY.enter);
	assert.deepEqual(queued.result(), { action: "unqueue", skill: alpha });

	const pinned = overlay(t, { pinnedSkills: [alpha] });
	pinned.component.handleInput(KEY.enter);
	assert.deepEqual(pinned.result(), { action: "unpin", skill: alpha });

	const pinnedByDefault = overlay(t, { skills: [skillEntry("alpha", "", { pinByDefault: true })] });
	pinnedByDefault.component.handleInput(KEY.enter);
	const pinResult = pinnedByDefault.result();
	if (!pinResult || pinResult.action !== "pin") assert.fail(`expected a pin result, got ${JSON.stringify(pinResult)}`);
	assert.equal(pinResult.skill.name, "alpha");
});

test("the overlay theme is read from the isolated home, not the developer's own theme file", (t) => {
	const harness = overlay(t);
	assert.ok(THEME_BORDER, "the fixture theme defines a border color");
	assert.ok(
		harness.render().join("\n").includes(`\x1b[${THEME_BORDER}m`),
		"the fixture border color must reach the rendered overlay border",
	);
});

test("the command's unqueue and unpin confirmations cover Tab, Y, N, and cancel", async (t) => {
	setAgentDir(t);
	const handler = commandHandler();

	async function confirm(keys: string[]): Promise<{ notifications: string[]; opens: number }> {
		const harness = commandHarness(t);
		const run = handler("", harness.ctx);
		const palette = harness.component();
		palette.handleInput(KEY.enter); // the pending alpha row asks for removal
		await new Promise((resolve) => setImmediate(resolve));

		const dialog = harness.overlayComponents[1];
		assert.ok(dialog, "the removal request opens the confirmation overlay");
		const text = strip(dialog.render(44).join("\n"));
		assert.match(text, /Remove Skill/);
		assert.match(text, /alpha/);

		for (const key of keys) dialog.handleInput(key);
		await run;
		return { notifications: harness.notifications, opens: harness.opens.length };
	}

	state.queuedSkills = [alpha];
	assert.deepEqual(await confirm([KEY.tab, KEY.enter]), { notifications: ["Skill unqueued: alpha"], opens: 2 });
	assert.deepEqual(state.queuedSkills, [], "Tab moves the default Keep onto Remove, Enter confirms");

	state.queuedSkills = [alpha];
	assert.deepEqual(await confirm(["y"]), { notifications: ["Skill unqueued: alpha"], opens: 2 });
	assert.deepEqual(state.queuedSkills, []);

	state.queuedSkills = [alpha];
	assert.deepEqual(await confirm(["n"]), { notifications: [], opens: 2 });
	assert.deepEqual(state.queuedSkills, [alpha], "N keeps the queued skill untouched");

	state.queuedSkills = [alpha];
	assert.deepEqual(await confirm([KEY.escape]), { notifications: [], opens: 2 });
	assert.deepEqual(state.queuedSkills, [alpha], "cancel keeps the queued skill untouched");

	state.pinnedSkills = [alpha];
	assert.deepEqual(await confirm(["y"]), { notifications: ["Skill unpinned: alpha"], opens: 2 });
	assert.deepEqual(state.pinnedSkills, []);

	state.pinnedSkills = [alpha];
	assert.deepEqual(await confirm([KEY.escape]), { notifications: [], opens: 2 });
	assert.deepEqual(state.pinnedSkills, [alpha], "cancel keeps the pinned skill untouched");
});

test("management rejects Space in the filter and stages the focused row instead", (t) => {
	const harness = overlay(t, { initialSection: "global" });

	for (const char of "alph") harness.component.handleInput(char);
	harness.component.handleInput(" ");
	harness.component.handleInput(KEY.enter);

	assert.deepEqual(harness.result(), { action: "saved", scope: "global", masterOff: false });
	assert.deepEqual(harness.saves, [
		{ scope: "global", disabled: { [alpha.sourceInfo.path]: true }, off: false },
	]);
});

test("management filters accept one printable code point and keep Space staging", (t) => {
	const japanese = skillEntry("日本語スキル", "説明テキスト");
	const rocket = skillEntry("🚀 launch", "emoji description");
	const unicodeCatalog = [japanese, rocket, alpha];

	const global = overlay(t, { initialSection: "global", catalog: unicodeCatalog, skills: unicodeCatalog });
	global.component.handleInput("\x07"); // a control character is never filter input
	for (const char of "日本") global.component.handleInput(char);
	const globalText = global.text();
	assert.match(globalText, /日本語スキル/, "a multibyte CJK query narrows the Global rows");
	assert.doesNotMatch(globalText, /alpha/, "the master row and unrelated skills leave the filtered list");

	global.component.handleInput(" "); // Space stages the focused row instead of joining the query
	global.component.handleInput(KEY.enter);
	assert.deepEqual(global.saves, [
		{ scope: "global", disabled: { [japanese.sourceInfo.path]: true }, off: false },
	]);

	const project = overlay(t, { initialSection: "project", catalog: unicodeCatalog, skills: unicodeCatalog });
	for (const char of "日本") project.component.handleInput(char);
	assert.match(project.text(), /日本語スキル/, "the Project filter takes the same CJK query");
	project.component.handleInput(" ");
	project.component.handleInput(KEY.enter);
	assert.deepEqual(project.saves, [{ scope: "project", overrides: { [japanese.sourceInfo.path]: "on" } }]);

	const emoji = overlay(t, { initialSection: "global", catalog: unicodeCatalog, skills: unicodeCatalog });
	emoji.component.handleInput("🚀"); // one surrogate-pair code point
	assert.match(emoji.text(), /🚀 launch/, "a surrogate-pair emoji is accepted as one filter character");
	assert.doesNotMatch(emoji.text(), /日本語スキル/);

	// Backspace removes one Unicode code point, never half of a surrogate pair, in both scopes.
	for (const section of ["global", "project"] as const) {
		const harness = overlay(t, { initialSection: section, catalog: unicodeCatalog, skills: unicodeCatalog });
		harness.component.handleInput("🚀");
		harness.component.handleInput("a");
		assert.match(harness.text(), /filter: 🚀a/, `${section}: the emoji-plus-ASCII query is shown`);
		assert.doesNotMatch(harness.text(), /🚀 launch/, `${section}: that query matches nothing`);

		harness.component.handleInput(KEY.backspace);
		assert.match(harness.text(), /filter: 🚀\s+│/, `${section}: the ASCII character goes first`);
		assert.match(harness.text(), /🚀 launch/, `${section}: the emoji query still matches its skill`);

		harness.component.handleInput(KEY.backspace);
		const cleared = harness.text();
		assert.ok(cleared.includes("filter: …"), `${section}: the whole emoji is gone, not half a pair`);
		assert.match(cleared, /日本語スキル/, `${section}: clearing the filter restores every row`);
		assert.ok(cleared.isWellFormed(), `${section}: no unpaired surrogate survives backspace`);
	}

	// BMP backspace keeps working one code unit at a time.
	const cjk = overlay(t, { initialSection: "global", catalog: unicodeCatalog, skills: unicodeCatalog });
	for (const char of "日本") cjk.component.handleInput(char);
	cjk.component.handleInput(KEY.backspace);
	assert.match(cjk.text(), /filter: 日\s+│/, "CJK backspace removes one character");
	assert.match(cjk.text(), /日本語スキル/);
	assert.ok(cjk.text().isWellFormed());
});

test("Enter saves and closes only after a successful save", (t) => {
	const harness = overlay(t, { initialSection: "global" });

	harness.component.handleInput(KEY.down); // master row -> alpha
	harness.component.handleInput(" ");
	assert.equal(harness.result(), undefined, "staging never closes the overlay");

	harness.component.handleInput(KEY.enter);

	assert.deepEqual(harness.result(), { action: "saved", scope: "global", masterOff: false });
	assert.deepEqual(harness.saves, [
		{ scope: "global", disabled: { [alpha.sourceInfo.path]: true }, off: false },
	]);
});

test("a failed save keeps the full path and reason readable with its pending choices", (t) => {
	const errorPath = "/tmp/long-project-policy/.pi/config/pi-skill-palette.json";
	let attempts = 0;
	const harness = overlay(t, {
		initialSection: "global",
		save: () => {
			attempts += 1;
			throw new Error(`${errorPath} is invalid; refusing to replace it`);
		},
	});

	harness.component.handleInput(KEY.down);
	harness.component.handleInput(" ");
	harness.component.handleInput(KEY.enter);

	assert.equal(harness.result(), undefined);
	assert.equal(attempts, 1);
	const text = harness.text();
	assert.match(text, /Save failed:/);
	assert.ok(text.includes(errorPath), `the default render keeps the full failed policy path: ${text}`);
	assert.ok(text.includes("refusing to replace it"), `the default render keeps the failure reason: ${text}`);
	assert.match(text, /○ alpha/, "the staged Off row is still shown for retry");
});

test("a project save writes only Project overrides", (t) => {
	const harness = overlay(t, { initialSection: "project" });

	harness.component.handleInput(" ");
	harness.component.handleInput(KEY.enter);

	assert.deepEqual(harness.result(), { action: "saved", scope: "project", masterOff: false });
	assert.deepEqual(harness.saves, [{ scope: "project", overrides: { [alpha.sourceInfo.path]: "on" } }]);
});

test("Esc discards staged management edits", (t) => {
	const harness = overlay(t, { initialSection: "global" });

	harness.component.handleInput(KEY.down);
	harness.component.handleInput(" ");
	harness.component.handleInput(KEY.escape);

	assert.deepEqual(harness.result(), { action: "cancel", skill: null });
	assert.deepEqual(harness.saves, []);
});

test("switching between Global and Project is blocked while edits are pending", (t) => {
	const global = overlay(t, { initialSection: "global" });
	global.component.handleInput(KEY.down);
	global.component.handleInput(" ");
	global.component.handleInput(KEY.right);

	assert.equal(global.component.getSection(), "global");
	assert.match(global.text(), /Unsaved Global changes/);

	global.component.handleInput(KEY.enter);
	global.component.handleInput(KEY.right);
	assert.equal(global.component.getSection(), "project");

	const project = overlay(t, { initialSection: "project" });
	project.component.handleInput(" ");
	project.component.handleInput(KEY.left);

	assert.equal(project.component.getSection(), "project");
	assert.match(project.text(), /Unsaved Project changes/);
});

test("an untrusted Project is locked without staging or saving anything", (t) => {
	const harness = overlay(t, {
		initialSection: "project",
		projectTrusted: false,
		// A file that must never contribute overrides while untrusted.
		project: { version: 1, overrides: { [alpha.sourceInfo.path]: "off" } },
	});

	const text = harness.text();
	assert.match(text, /not trusted/);
	assert.match(text, /2\/2 on/, "untrusted overrides are ignored by the effective summary");

	harness.component.handleInput(" ");
	harness.component.handleInput(KEY.tab);
	harness.component.handleInput(KEY.enter);

	assert.deepEqual(harness.saves, []);
	assert.equal(harness.result(), undefined);
	assert.match(harness.text(), /Project policy is locked/);
});

test("management renders the effective summary, native tags, and package groups", (t) => {
	const visible = packedSkill("alpha", "acme-tools");
	const hidden = packedSkill("hidden", "acme-tools");
	hidden.disableModelInvocation = true;
	const harness = overlay(t, { initialSection: "global", catalog: [visible, hidden], skills: [visible, hidden] });

	const text = harness.text();
	const lines = harness.render(140);
	const packageTitle = lines.findIndex((line) => line.includes("── acme-tools"));
	assert.ok(packageTitle >= 0, lines.join("\n"));
	assert.ok(lines[packageTitle]?.includes("\x1b[33m"), "package title uses the yellow title color");
	const borderColor = lines[packageTitle]?.match(/^\x1b\[[0-9;]*m/)?.[0] ?? "";
	assert.ok(
		lines[packageTitle]?.includes(`${borderColor}─`) && strip(lines[packageTitle] ?? "").includes("── acme-tools ─"),
		"package title has one space followed by the border-colored rule",
	);
	assert.equal(strip(lines[packageTitle] ?? "").replace(/[│]/g, "").length, 138, "the rule fills the available inner width");
	assert.ok(lines[packageTitle + 1]?.includes("\x1b[32m●"), "On skill uses the green filled circle");
	assert.match(strip(lines[packageTitle + 1] ?? ""), /● alpha · on/, "the visible skill immediately follows the package divider");
	assert.match(text, /2\/2 on · prompt /);
	assert.match(text, /\(native\)/);
	assert.match(text, /── acme-tools/);
	assert.doesNotMatch(text, /── (?:user|project)/);
});

test("management keeps the full Global and Project summary at 70 columns", (t) => {
	const skills = Array.from({ length: 95 }, (_, index) => skillEntry(`skill-${index}`, index === 94 ? "x".repeat(10_000) : ""));
	const disabled = Object.fromEntries(skills.slice(0, 37).map((skill) => [skill.sourceInfo.path, true] as const));
	const harness = overlay(t, { initialSection: "global", catalog: skills, skills, global: { version: 1, disabled } });

	const lines = harness.render(70).map(strip);
	assert.ok(
		lines.some((line) => line.includes("global 37 off · project 0 on / 0 off")),
		lines.join("\n"),
	);
});

test("management moves an overflowing path to an intact indented continuation", (t) => {
	const skill = skillAt(
		"readable-path",
		`${fakeHome}/.agents/skills/long-package-for-layout/readable-path/SKILL.md`,
	);
	const harness = overlay(t, { initialSection: "global", catalog: [skill], skills: [skill] });
	const lines = harness.render(70).map(strip);
	const primary = lines.findIndex((line) => line.includes("● readable-path · on"));
	assert.ok(primary >= 0, lines.join("\n"));

	assert.ok(
		lines[primary + 1]?.startsWith("│     ~/.agents/skills/long-package-for-layout/readable-path/SKILL.md"),
		lines.join("\n"),
	);
});

test("Project management keeps every control readable at 70 columns", (t) => {
	const harness = overlay(t, { initialSection: "project" });
	const text = harness.text(70);
	for (const hint of ["↑↓ move", "←→ section", "space on/off/inherit", "tab pack", "enter save", "esc discard"]) {
		assert.ok(text.includes(hint), `missing ${JSON.stringify(hint)} in the default-width footer: ${text}`);
	}
});

test("a scrolled window still shows the pack header when all visible rows share a hidden pack", (t) => {
	const skills = Array.from({ length: 10 }, (_, index) => packedSkill(`s${index}`, "long-pack"));
	const harness = overlay(t, { initialSection: "global", catalog: skills, skills });

	for (let index = 0; index < 9; index++) harness.component.handleInput(KEY.down);

	const text = harness.text();
	assert.equal((text.match(/── long-pack/g) ?? []).length, 1, "the visible pack keeps one header");
});

test("Tab bulk staging only touches the focused pack", (t) => {
	const first = packedSkill("a1", "alpha-pack");
	const second = packedSkill("a2", "alpha-pack");
	const other = packedSkill("b1", "beta-pack");
	const harness = overlay(t, { initialSection: "global", catalog: [first, second, other], skills: [first, second, other] });

	harness.component.handleInput(KEY.down); // master -> a1
	harness.component.handleInput(KEY.tab);
	harness.component.handleInput(KEY.enter);

	assert.deepEqual(harness.saves, [
		{ scope: "global", disabled: { [first.sourceInfo.path]: true, [second.sourceInfo.path]: true }, off: false },
	]);
});

test("lockfile owners label top-level user packages and unrelated folders stay separate", (t) => {
	const locked = skillAt("tool", `${fakeHome}/.agents/skills/installed-tool/SKILL.md`);
	const loose = skillAt("loose", `${fakeHome}/.agents/skills/loose-folder/SKILL.md`);
	const harness = overlay(t, {
		initialSection: "global",
		catalog: [locked, loose],
		skills: [locked, loose],
		lock: { "installed-tool": { source: "acme/toolkit" } },
	});

	const text = harness.text();
	const lines = harness.render(140);
	const firstPackage = lines.findIndex((line) => line.includes("── acme"));
	const secondPackage = lines.findIndex((line) => line.includes("── loose-folder"));
	assert.ok(firstPackage > 0 && secondPackage > firstPackage, lines.join("\n"));
	assert.match(strip(lines[firstPackage - 1] ?? ""), /● Master switch: restrictions on/, "no leading blank before the first package");
	assert.notEqual(strip(lines[secondPackage - 2] ?? "").replace(/[│]/g, "").trim(), "", "only one blank row separates the packages");
	assert.equal(strip(lines[secondPackage - 1] ?? "").replace(/[│]/g, "").trim(), "", "one blank row immediately precedes the second package");
	assert.match(strip(lines[secondPackage + 1] ?? ""), /● loose · on/, "the first skill immediately follows the second package title");
	assert.match(text, /── acme/);
	assert.match(text, /── loose-folder/);

	harness.component.handleInput(KEY.down); // master -> acme
	harness.component.handleInput(KEY.tab);
	harness.component.handleInput(KEY.enter);
	assert.deepEqual(harness.saves, [
		{ scope: "global", disabled: { [locked.sourceInfo.path]: true }, off: false },
	]);
});

test("scoped node_modules packages sharing a basename stay separate packs", (t) => {
	const first = skillAt("one", `${fakeHome}/.pi/agent/npm/node_modules/@one/pkg/skills/one/SKILL.md`);
	const second = skillAt("two", `${fakeHome}/.pi/agent/npm/node_modules/@two/pkg/skills/two/SKILL.md`);
	const harness = overlay(t, { initialSection: "global", catalog: [first, second], skills: [first, second] });

	const text = harness.text();
	assert.match(text, /── one/);
	assert.match(text, /── two/);

	harness.component.handleInput(KEY.down); // master -> one
	harness.component.handleInput(KEY.tab);
	harness.component.handleInput(KEY.enter);
	assert.deepEqual(harness.saves, [
		{ scope: "global", disabled: { [first.sourceInfo.path]: true }, off: false },
	]);
});

test("rows keep the scope indicator and add the combined effective state", (t) => {
	const harness = overlay(t, {
		initialSection: "global",
		global: { version: 1, disabled: { [alpha.sourceInfo.path]: true } },
		project: { version: 1, overrides: { [alpha.sourceInfo.path]: "on", [beta.sourceInfo.path]: "off" } },
	});
	const text = harness.text(120);
	assert.match(text, /○ alpha · on/, "Global Off + Project On is effectively On");
	harness.component.handleInput(KEY.right);
	assert.match(harness.text(120), /○ beta · off/, "Project Off can disable a Global On skill");

	const bypass = overlay(t, {
		initialSection: "global",
		global: { version: 1, disabled: { [alpha.sourceInfo.path]: true }, off: true },
	});
	assert.match(bypass.text(120), /○ alpha · on/, "master-off bypasses the disabled row");
	assert.match(bypass.text(120), /○ Master switch: OFF, restrictions bypassed/);
});

test("Load refuses to close while management edits are unsaved", (t) => {
	const global = overlay(t, { initialSection: "global" });
	global.component.handleInput(KEY.down);
	global.component.handleInput(" ");
	global.component.handleInput(KEY.left); // Global -> Load
	assert.equal(global.component.getSection(), "load");

	global.component.handleInput(KEY.enter);
	assert.equal(global.result(), undefined, "Load never silently discards pending management edits");
	assert.match(global.text(), /Unsaved Global changes/);

	global.component.handleInput(KEY.left); // Config belongs to the same still-dirty Global draft.
	assert.equal(global.component.getSection(), "config");
	assert.deepEqual(global.saves, []);
	global.component.handleInput(KEY.right); // Return to Load without saving or discarding.
	assert.equal(global.component.getSection(), "load");
	assert.deepEqual(global.saves, []);

	global.component.handleInput(KEY.escape);
	assert.deepEqual(global.result(), { action: "cancel", skill: null });
	assert.deepEqual(global.saves, []);
	const project = overlay(t, { initialSection: "project" });
	project.component.handleInput(" ");
	project.component.handleInput(KEY.right); // Project -> Config is a cross-file switch, so it is blocked.
	assert.equal(project.component.getSection(), "project");
	assert.match(project.text(), /Unsaved Project changes/);
	assert.deepEqual(project.saves, []);
	project.component.handleInput(KEY.escape);
	assert.deepEqual(project.result(), { action: "cancel", skill: null });
	assert.deepEqual(project.saves, []);
});

test("the idle timeout never discards unsaved management edits", (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());
	const harness = overlay(t, { initialSection: "global" });
	harness.component.handleInput(KEY.down);
	harness.component.handleInput(" ");
	harness.component.handleInput(KEY.left);

	mock.timers.tick(60_000);
	assert.equal(harness.result(), undefined);
	mock.timers.tick(60_000);
	assert.equal(harness.result(), undefined);
});

test("the idle timeout still cancels a clean Load", (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());
	const harness = overlay(t);

	mock.timers.tick(60_000);
	assert.deepEqual(harness.result(), { action: "cancel", skill: null });
});

test("every section renders within the terminal width for narrow and Unicode content", (t) => {
	const unicode = skillEntry("日本語スキル", "説明テキスト", {
		sourceInfo: {
			path: `${os.homedir()}/.agents/skills/日本語スキル/SKILL.md`,
			source: "local",
			scope: "user",
			origin: "top-level",
		},
	});

	for (const section of ["load", "global", "project", "config"] as const) {
		const harness = overlay(t, { initialSection: section, catalog: [unicode], skills: [unicode] });
		for (const width of [110, 80, 70, 40, 20]) {
			for (const line of harness.render(width)) {
				assert.ok(
					visibleWidth(line) <= width,
					`${section} at width ${width} overflows: ${JSON.stringify(strip(line))}`,
				);
			}
		}
	}
});

test("a successful visibility save applies the policy and prunes Off pending skills", (t) => {
	const agentDir = makeTempDir(t);
	const cwd = makeTempDir(t);
	state.queuedSkills = [beta];
	state.pinnedSkills = [beta];

	applyPendingPolicy({
		agentDir,
		cwd,
		trusted: true,
		pending: { scope: "global", disabled: { [beta.sourceInfo.path]: true }, off: false },
	});

	assert.deepEqual(state.queuedSkills, []);
	assert.deepEqual(state.pinnedSkills, []);
	const saved = JSON.parse(fs.readFileSync(globalConfigPath(agentDir), "utf8")) as {
		version: number;
		disabled: Record<string, true>;
	};
	assert.equal(saved.version, 1);
	assert.deepEqual(saved.disabled, { [beta.sourceInfo.path]: true });
});

test("a failed save leaves runtime policy and pending queues untouched", (t) => {
	const agentDir = makeTempDir(t);
	const path = globalConfigPath(agentDir);
	fs.mkdirSync(join(agentDir, "config"), { recursive: true });
	fs.writeFileSync(path, "{ invalid", "utf8");
	state.queuedSkills = [beta];
	setCurrentPolicy(resolvePolicy({ disabled: { [beta.sourceInfo.path]: true } }, null, false));

	assert.throws(
		() => applyPendingPolicy({
			agentDir,
			cwd: makeTempDir(t),
			trusted: false,
			pending: { scope: "global", disabled: {}, off: false },
		}),
		/refusing to replace/,
	);

	assert.equal(fs.readFileSync(path, "utf8"), "{ invalid", "the invalid file is never replaced");
	assert.deepEqual(state.queuedSkills, [beta]);
});

test("an ordinary save applies without reload and refreshes indicators", async (t) => {
	const agentDir = setAgentDir(t);
	state.queuedSkills = [alpha];
	const handler = commandHandler();
	const harness = commandHarness(t);

	const run = handler("", harness.ctx);
	const component = harness.component();
	component.handleInput(KEY.right); // Global
	component.handleInput(KEY.down); // alpha
	component.handleInput(" ");
	component.handleInput(KEY.enter);
	await run;

	assert.equal(harness.reloads(), 0);
	assert.deepEqual(state.queuedSkills, [], "the newly Off skill is pruned from the queue");
	assert.ok(harness.statuses.length > 0, "indicators are refreshed after a save");
	const saved = JSON.parse(fs.readFileSync(globalConfigPath(agentDir), "utf8")) as {
		disabled: Record<string, true>;
	};
	assert.deepEqual(saved.disabled, { [alpha.sourceInfo.path]: true });
	assert.equal("show_paths" in saved, false, "a policy-only save must not manufacture show_paths");
});

test("a Global master-off save closes the overlay and reloads exactly once", async (t) => {
	const agentDir = setAgentDir(t);
	const handler = commandHandler();
	const harness = commandHarness(t);

	const run = handler("", harness.ctx);
	const component = harness.component();
	component.handleInput(KEY.right); // Global
	component.handleInput(" "); // master row
	component.handleInput(KEY.enter);
	await run;

	assert.equal(harness.reloads(), 1);
	const saved = JSON.parse(fs.readFileSync(globalConfigPath(agentDir), "utf8")) as { off?: boolean };
	assert.equal(saved.off, true);
});

test("an untrusted project is never written by the command", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const path = projectConfigPath(cwd);
	fs.mkdirSync(join(cwd, ".pi", "config"), { recursive: true });
	fs.writeFileSync(path, `${JSON.stringify({ version: 1, overrides: { [alpha.sourceInfo.path]: "off" } })}\n`, "utf8");
	const before = fs.readFileSync(path, "utf8");

	const handler = commandHandler();
	const harness = commandHarness(t, { trusted: false, cwd });
	const run = handler("", harness.ctx);
	const component = harness.component();
	component.handleInput(KEY.right);
	component.handleInput(KEY.right);
	assert.equal(component.getSection(), "project");
	assert.match(strip(component.render(70).join("\n")), /not trusted/);

	component.handleInput(" ");
	component.handleInput(KEY.enter);
	component.handleInput(KEY.escape);
	await run;

	assert.equal(fs.readFileSync(path, "utf8"), before);
	assert.equal(harness.reloads(), 0);
	assert.ok(fs.existsSync(globalConfigPath(agentDir)) === false, "opening the overlay never writes a Global file");
});

test("trust revoked after opening the Project fails the save with the project path", async (t) => {
	setAgentDir(t);
	const cwd = makeTempDir(t);
	const path = projectConfigPath(cwd);
	fs.mkdirSync(join(cwd, ".pi", "config"), { recursive: true });
	fs.writeFileSync(path, `${JSON.stringify({ version: 1, overrides: { [beta.sourceInfo.path]: "off" } })}\n`, "utf8");
	const before = fs.readFileSync(path, "utf8");
	let trusted = true;

	const handler = commandHandler();
	const harness = commandHarness(t, { trusted: () => trusted, cwd });
	const run = handler("", harness.ctx);
	const component = harness.component();
	component.handleInput(KEY.right);
	component.handleInput(KEY.right);
	assert.equal(component.getSection(), "project");
	component.handleInput(" "); // alpha: Inherit -> On
	trusted = false;
	component.handleInput(KEY.enter);

	const text = strip(component.render(240).join("\n"));
	assert.match(text, /Save failed:/);
	assert.ok(text.includes(path), `the save error must name the refused file: ${text}`);
	assert.match(text, /● alpha/, "the pending row stays visible for a retry");
	assert.equal(fs.readFileSync(path, "utf8"), before, "the existing project file is byte-identical");
	assert.equal(harness.reloads(), 0);

	component.handleInput(KEY.escape);
	await run;
});

test("Config defaults to On and saves Off globally even when Project is untrusted", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const handler = commandHandler();
	const harness = commandHarness(t, { trusted: false, cwd });
	state.queuedSkills = [beta];
	state.pinnedSkills = [beta];

	fs.mkdirSync(join(agentDir, "config"), { recursive: true });
	fs.writeFileSync(globalConfigPath(agentDir), `${JSON.stringify({ version: 1, disabled: { [alpha.sourceInfo.path]: true } }, null, 2)}\n`, "utf8");
	setCurrentPolicy(resolvePolicy({ disabled: { [alpha.sourceInfo.path]: true } }, null, false));
	const projectPath = projectConfigPath(cwd);
	fs.mkdirSync(join(cwd, ".pi", "config"), { recursive: true });
	fs.writeFileSync(projectPath, `${JSON.stringify({ version: 1, overrides: { [beta.sourceInfo.path]: "off" } }, null, 2)}\n`, "utf8");
	const projectBefore = fs.readFileSync(projectPath);
	state.queuedSkills = [beta];
	const run = handler("", harness.ctx);
	const component = harness.component();
	component.handleInput(KEY.left); // Load wraps to Config.
	assert.equal(component.getSection(), "config");
	const initial = strip(component.render(70).join("\n"));
	assert.match(initial, /▸ ● Show skill file paths · On/, initial);
	assert.equal(Object.hasOwn(JSON.parse(fs.existsSync(globalConfigPath(agentDir)) ? fs.readFileSync(globalConfigPath(agentDir), "utf8") : "{}"), "show_paths"), false);
	const promptBefore = JSON.stringify(harness.ctx.getSystemPromptOptions());
	const identityBefore = [alpha, beta].map((skill) => ({ filePath: skill.filePath, sourceInfo: skill.sourceInfo }));

	component.handleInput(" ");
	const preview = strip(component.render(70).join("\n"));
	assert.match(preview, /▸ ○ Show skill file paths · Off/, preview);
	assert.equal(JSON.stringify(harness.ctx.getSystemPromptOptions()), promptBefore);
	component.handleInput(KEY.enter);
	await run;

	const saved = JSON.parse(fs.readFileSync(globalConfigPath(agentDir), "utf8")) as Record<string, unknown>;
	assert.equal(saved.show_paths, false);
	assert.deepEqual(saved.disabled, { [alpha.sourceInfo.path]: true });
	assert.ok(fs.readFileSync(projectPath).equals(projectBefore), "Config preserves the untrusted Project file byte-for-byte");
	assert.equal(JSON.stringify(harness.ctx.getSystemPromptOptions()), promptBefore);
	assert.deepEqual([alpha, beta].map((skill) => ({ filePath: skill.filePath, sourceInfo: skill.sourceInfo })), identityBefore);
	assert.deepEqual(state.queuedSkills, [beta], "cosmetic saves do not consume the pending queue");
	assert.deepEqual(state.pinnedSkills, [beta], "cosmetic saves do not alter pending pins");
	assert.equal(harness.reloads(), 0);
	const reopened = commandHarness(t, { trusted: false, cwd });
	const reopenedRun = handler("", reopened.ctx);
	const restored = reopened.component();
	restored.handleInput(KEY.left);
	assert.equal(restored.getSection(), "config");
	assert.match(strip(restored.render(70).join("\n")), /Show skill file paths · Off/);
	restored.handleInput(" ");
	restored.handleInput(KEY.enter);
	await reopenedRun;
	assert.equal((JSON.parse(fs.readFileSync(globalConfigPath(agentDir), "utf8")) as Record<string, unknown>).show_paths, true);
	assert.ok(fs.readFileSync(projectPath).equals(projectBefore), "the Off → On round trip still preserves Project");
	assert.equal(JSON.stringify(reopened.ctx.getSystemPromptOptions()), promptBefore);
	assert.deepEqual([alpha, beta].map((skill) => ({ filePath: skill.filePath, sourceInfo: skill.sourceInfo })), identityBefore);
});

test("an unsaved Config preference stays Global-dirty and Esc discards it", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const path = globalConfigPath(agentDir);
	fs.mkdirSync(join(agentDir, "config"), { recursive: true });
	fs.writeFileSync(path, `${JSON.stringify({
		version: 1,
		disabled: { [alpha.sourceInfo.path]: true },
		show_paths: true,
		migration: { from: "pi-skill-manager", version: 1 },
		theme: "cyan",
	}, null, 2)}\n`, "utf8");
	const before = fs.readFileSync(path);
	const handler = commandHandler();
	const harness = commandHarness(t, { cwd });

	const run = handler("", harness.ctx);
	const component = harness.component();
	component.handleInput(KEY.left);
	assert.equal(component.getSection(), "config");
	component.handleInput(" ");
	component.handleInput(KEY.left);
	assert.equal(component.getSection(), "config", "a dirty Global cosmetic cannot switch to Project");
	assert.match(strip(component.render(70).join("\n")), /Unsaved Global changes/);
	component.handleInput(KEY.escape);
	await run;

	assert.ok(fs.readFileSync(path).equals(before), "Esc preserves the Global file byte-for-byte");
	assert.equal(fs.existsSync(projectConfigPath(cwd)), false);
	assert.equal(harness.reloads(), 0);
});

test("hiding catalog paths keeps Global and Project names, states, diagnostics, and host identity", (t) => {
	const sourcePath = `${fakeHome}/.agents/skills/unicode-世界-🚀/path/SKILL.md`;
	const skill = skillAt("世界-α🚀", sourcePath, { description: "Unicode path label" });
	const diagnostic = "/tmp/invalid-config/pi-skill-palette.json: invalid shape";
	for (const initialSection of ["global", "project"] as const) {
		const visible = overlay(t, { initialSection, catalog: [skill], skills: [skill] });
		assert.ok(visible.text(140).includes("~/.agents/skills/unicode-世界-🚀/path/SKILL.md"), visible.text(140));

		const hidden = overlay(t, {
			initialSection,
			catalog: [skill],
			skills: [skill],
			global: { version: 1, disabled: { [sourcePath]: true }, show_paths: false },
			globalIssues: [diagnostic],
			projectIssues: [diagnostic],
		});
		const text = hidden.text(140);
		assert.doesNotMatch(text, /SKILL\.md|unicode-世界-🚀\/path|agents\/skills/, text);
		assert.ok(text.includes("世界-α🚀"), text);
		assert.ok(text.includes("off"), text);
		assert.ok(text.includes(diagnostic), "config diagnostics are not catalog labels");
		assert.equal(skill.filePath, sourcePath);
		assert.equal(skill.sourceInfo.path, sourcePath);
	}
});

test("a non-boolean show_paths gives Config the existing full-path refusal without replacing it", async (t) => {
	const agentDir = setAgentDir(t);
	const path = globalConfigPath(agentDir);
	fs.mkdirSync(join(agentDir, "config"), { recursive: true });
	fs.writeFileSync(path, '{"version":1,"show_paths":"off"}', "utf8");
	const before = fs.readFileSync(path);
	const harness = commandHarness(t);

	const run = commandHandler()("", harness.ctx);
	const component = harness.component();
	component.handleInput(KEY.left);
	assert.equal(component.getSection(), "config");
	component.handleInput(" ");
	component.handleInput(KEY.enter);
	const text = component.render(70).map(strip).join("\n");
	const compact = text.replace(/[│\s]/g, "");
	assert.ok(compact.includes(path), text);
	assert.ok(compact.includes("refusingtoreplaceit"), text);
	assert.ok(compact.includes((path + " has an invalid shape; ignoring it").replace(/\s/g, "")), text);
	assert.equal(harness.component().getSection(), "config", "a failed save does not close Config");
	assert.ok(fs.readFileSync(path).equals(before));
	component.handleInput(KEY.escape);
	await run;
});
