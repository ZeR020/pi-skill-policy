/**
 * Offline UI verification for the palette overlay.
 *
 * Exercises the real `SkillPaletteComponent.handleInput`/`render` with pi's real TUI
 * keybinding singleton and real storage in a temporary directory. No model inference, no
 * network, and no personal config: every path lives under a fresh mkdtemp root.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";

import type { PaletteResult, PaletteSection, Skill } from "../index.js";
import { globalConfigPath, loadGlobalConfig, loadProjectConfig, projectConfigPath } from "../src/storage.js";
import type { PendingPolicy } from "../src/manage-state.js";

const root = fs.mkdtempSync(join(os.tmpdir(), "pi-skill-policy-overlay-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const cwd = join(root, "project");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

// index.ts reads its palette theme at module scope, so the isolated home and its fixture theme
// must exist before the dynamic import; the marker color proves which theme the overlay used.
const THEME_BORDER = "35";
const originalHome = process.env.HOME;
process.env.HOME = home;
fs.mkdirSync(join(home, ".pi", "agent", "extensions", "pi-skill-palette"), { recursive: true });
fs.writeFileSync(
	join(home, ".pi", "agent", "extensions", "pi-skill-palette", "theme.json"),
	`${JSON.stringify({ border: THEME_BORDER })}\n`,
	"utf8",
);
const { SkillPaletteComponent, applyPendingPolicy } = await import("../index.js");
type PaletteComponent = InstanceType<typeof SkillPaletteComponent>;
const KEY = { right: "\x1b[C", down: "\x1b[B", enter: "\r", escape: "\x1b", tab: "\t" } as const;

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function skill(name: string, description = "", overrides: Partial<Skill> = {}): Skill {
	const filePath = join(root, "skills", name, "SKILL.md");
	return {
		name,
		description,
		filePath,
		baseDir: dirname(filePath),
		sourceInfo: { path: filePath, source: "local", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
		pinByDefault: false,
		searchName: name.toLowerCase(),
		searchDescription: description.toLowerCase(),
		sortIndex: 0,
		...overrides,
	};
}

const alpha = skill("alpha", "alpha description");
const beta = skill("beta", "beta description");
const hidden = skill("hidden", "manual only", {
	disableModelInvocation: true,
	sourceInfo: {
		path: join(root, "skills", "hidden", "SKILL.md"),
		source: "local",
		scope: "user",
		origin: "top-level",
	},
});
const unicode = skill("日本語スキル", "説明テキスト", {
	sourceInfo: {
		path: join(os.homedir(), ".agents", "skills", "日本語スキル", "SKILL.md"),
		source: "local",
		scope: "user",
		origin: "top-level",
	},
});
const longSourcePath = join(home, ".agents", "skills", "long-package-for-layout", "readable-path", "SKILL.md");
const pathSkill = skill("readable-path", "", {
	filePath: longSourcePath,
	baseDir: dirname(longSourcePath),
	sourceInfo: { path: longSourcePath, source: "local", scope: "user", origin: "top-level" },
});
const catalog: Skill[] = [alpha, beta, hidden];

interface Session {
	component: PaletteComponent;
	result(): PaletteResult | undefined;
}

function open(
	section: PaletteSection,
	skills: Skill[],
	projectTrusted = true,
	save: (pending: PendingPolicy) => void = (pending) => applyPendingPolicy({ agentDir, cwd, trusted: projectTrusted, pending }),
): Session {
	let result: PaletteResult | undefined;
	const global = loadGlobalConfig(agentDir);
	const project = loadProjectConfig(cwd, projectTrusted);
	const component = new SkillPaletteComponent(
		{
			initialSection: section,
			skills,
			catalog: skills,
			queuedSkills: [],
			pinnedSkills: [],
			global: global.state,
			project: project.state,
			projectTrusted,
			globalIssues: global.issues,
			projectIssues: project.issues,
			save,
		},
		(value: PaletteResult | undefined) => {
			result = value;
		},
	);
	return { component, result: () => result };
}

function savedResult(session: Session): { action: "saved"; scope: string; masterOff: boolean } {
	const result = session.result();
	if (!result || result.action !== "saved") assert.fail(`expected a saved result, got ${JSON.stringify(result)}`);
	return result;
}

const previousKeybindings = getKeybindings();
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

try {
	// 1. One overlay, three sections, bounded widths incl. wide (Unicode) content.
	for (const section of ["load", "global", "project"] as const) {
		const session = open(section, [alpha, beta, hidden, unicode]);
		for (const width of [110, 80, 70, 40, 20]) {
			for (const line of session.component.render(width)) {
				assert.ok(visibleWidth(line) <= width, `${section} at ${width} overflows: ${JSON.stringify(strip(line))}`);
			}
		}
		const tabs = strip(session.component.render(70).join("\n"));
		for (const tab of ["Load", "Global", "Project"]) assert.ok(tabs.includes(tab), `${section} shows the ${tab} tab`);
		assert.equal(session.component.getSection(), section);
		session.component.dispose();
	}
	console.log("PASS one centered overlay renders Load/Global/Project within 110/80/70/40/20 columns (Unicode safe)");

	// 1b. The rendered theme is the isolated home's fixture, not the developer's own theme file.
	const themedSession = open("load", [alpha]);
	try {
		const themed = themedSession.component.render(70).join("\n");
		assert.ok(themed.includes(`\x1b[${THEME_BORDER}m`), "the overlay border uses the temp-home theme fixture");
	} finally {
		themedSession.component.dispose();
	}
	console.log("PASS the overlay theme comes from the isolated home fixture");

	// 2. Load keeps literal spaces in filtering and Esc cancellation through real key input.
	const spaced = skill("alpha", "al pha helper");
	const unspaced = skill("beta", "alpha helper");
	const load = open("load", [spaced, unspaced]);
	for (const char of "al pha") load.component.handleInput(char);
	const loadText = strip(load.component.render(70).join("\n"));
	assert.ok(loadText.includes("alpha"), "the spaced query matches alpha");
	assert.ok(!loadText.includes("beta"), "Load Space stays in the query instead of staging a row");
	load.component.handleInput(KEY.escape);
	assert.deepEqual(load.result(), { action: "cancel", skill: null });
	load.component.dispose();
	console.log("PASS Load accepts literal Space in its fuzzy query and Esc cancels");

	// 3. Left/Right changes sections; Space stages; Enter saves Global without reload.
	const globalSession = open("load", catalog);
	globalSession.component.handleInput(KEY.right);
	assert.equal(globalSession.component.getSection(), "global");
	globalSession.component.handleInput(KEY.down); // master row -> alpha
	globalSession.component.handleInput(" ");
	assert.equal(globalSession.result(), undefined, "staging keeps the overlay open");
	globalSession.component.handleInput(KEY.enter);
	const globalSaved = savedResult(globalSession);
	assert.equal(globalSaved.scope, "global");
	assert.equal(globalSaved.masterOff, false);
	globalSession.component.dispose();

	const globalFile = JSON.parse(fs.readFileSync(globalConfigPath(agentDir), "utf8")) as {
		disabled: Record<string, true>;
		off?: boolean;
	};
	assert.equal(globalFile.disabled[alpha.sourceInfo.path], true);
	assert.equal(globalFile.off, undefined);
	console.log("PASS Right switches to Global, Space stages Off, Enter saves through real storage");

	// 4. A Global master-off save reports exactly one reload and keeps every skill choice.
	const masterSession = open("global", catalog);
	masterSession.component.handleInput(" "); // master row
	masterSession.component.handleInput(KEY.enter);
	assert.equal(savedResult(masterSession).masterOff, true);
	masterSession.component.dispose();
	const masterFile = JSON.parse(fs.readFileSync(globalConfigPath(agentDir), "utf8")) as {
		disabled: Record<string, true>;
		off?: boolean;
	};
	assert.equal(masterFile.off, true);
	assert.equal(masterFile.disabled[alpha.sourceInfo.path], true, "master-off preserves staged skill choices");
	console.log("PASS Global master-off closes as a reload request and preserves skill choices");

	// 5. Project staging cycles and writes only the Project file.
	const projectSession = open("project", catalog);
	projectSession.component.handleInput(" "); // alpha: Inherit -> On
	projectSession.component.handleInput(KEY.enter);
	assert.equal(savedResult(projectSession).scope, "project");
	projectSession.component.dispose();
	const projectFile = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as {
		overrides: Record<string, "on" | "off">;
	};
	assert.deepEqual(projectFile.overrides, { [alpha.sourceInfo.path]: "on" });
	console.log("PASS Project staging saves overrides to the project config only");

	// 6. Untrusted Project renders the lock and performs no write.
	const before = fs.readFileSync(projectConfigPath(cwd), "utf8");
	const untrusted = open("project", catalog, false);
	const untrustedText = strip(untrusted.component.render(70).join("\n"));
	assert.match(untrustedText, /not trusted/);
	assert.match(untrustedText, /project untrusted/);
	untrusted.component.handleInput(" ");
	untrusted.component.handleInput(KEY.tab);
	untrusted.component.handleInput(KEY.enter);
	assert.equal(untrusted.result(), undefined);
	untrusted.component.dispose();
	assert.equal(fs.readFileSync(projectConfigPath(cwd), "utf8"), before);
	console.log("PASS an untrusted Project is locked and never written");

	// 7. Native tag, path labels, and the effective summary are rendered.
	const report = open("global", [alpha, hidden, pathSkill]);
	const reportText = strip(report.component.render(110).join("\n"));
	assert.match(reportText, /\(native\)/);
	assert.match(reportText, /3\/3 on · prompt \d+\/\d+/);
	assert.match(reportText, /── alpha/);
	assert.match(reportText, /○ alpha · on/, "master-off shows the row scope Off but effective On");
	assert.match(reportText, /\/skills\/alpha\//);
	const narrowLines = report.component.render(70).map(strip);
	const primary = narrowLines.findIndex((line) => line.includes("● readable-path · on"));
	assert.ok(primary >= 0 && narrowLines[primary + 1]?.includes("~/.agents/skills/long-package-for-layout/readable-path/SKILL.md"));
	assert.ok(narrowLines.at(-1)?.startsWith("╰"), "the height change keeps the bottom border");
	report.component.dispose();

	const failedPath = globalConfigPath(agentDir);
	const failed = open("global", [alpha], true, () => {
		throw new Error(`${failedPath} is invalid; refusing to replace it`);
	});
	failed.component.handleInput(KEY.down);
	failed.component.handleInput(" ");
	failed.component.handleInput(KEY.enter);
	const failedLines = failed.component.render(70).map(strip);
	const failedRows = failedLines
		.filter((line) => line.startsWith("│") && line.endsWith("│"))
		.map((line) => line.slice(1, -1).trim());
	assert.ok(failedRows.join("").replace(/\s/g, "").includes(failedPath), "the full failed policy path survives wrapping");
	const failedText = failedLines.join("\n");
	assert.ok(failedText.includes("refusing to replace it"));
	assert.ok(failedText.includes("esc discard"));
	assert.ok(failedLines.at(-1)?.startsWith("╰"), "wrapped errors do not crop the footer or bottom border");
	failed.component.dispose();
	console.log(`PASS native/path/summary at 110, path continuation at 70, and save error/help in ${failedLines.length} rows`);

	console.log("verify-overlay: OK");
} finally {
	setKeybindings(previousKeybindings);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	fs.rmSync(root, { recursive: true, force: true });
}
