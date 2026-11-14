import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
	getKeybindings,
	KeybindingsManager,
	stripTerminalSequences,
	ProcessTerminal,
	setKeybindings,
	TUI_KEYBINDINGS,
	TuiMainScreen,
} from "@earendil-works/pi-tui";

import { skillEntry, sourceInfoFor } from "./helpers/fixtures.js";

const previousHome = process.env.HOME;
const fakeHome = fs.mkdtempSync(join(os.tmpdir(), "pi-skill-policy-viewport-home-"));
process.env.HOME = fakeHome;
const { SkillPaletteComponent } = await import("../index.js");

const originalKeybindings = getKeybindings();
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

interface ProbeResult {
	viewport: string[];
	beforeViewport?: string[];
	selectedPath: string;
	errorPath: string;
	section: string;
	identityBefore: string;
	identity: string;
	renderRows: number;
	stdout: { isTTY: boolean; rows: number; columns: number };
	terminal: { rows: number; columns: number };
}
class ViewportProbe extends TuiMainScreen {
	viewport(): string[] {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		return this.compositeOverlays([], width, height).slice(-height);
	}
}

function strip(text: string): string {
	return stripTerminalSequences(text);
}

function contentLines(lines: string[]): string[] {
	return lines.map((line) => strip(line).replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd());
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function runChild(scenario: "selection" | "error" | "config-off" | "config-error"): ProbeResult {
	const filename = fileURLToPath(import.meta.url);
	const cwd = dirname(dirname(filename));
	const command = `stty rows 24 cols 70; exec ${quote(process.execPath)} --import tsx ${quote(filename)}`;
	const child = spawnSync("/usr/bin/script", ["-qefc", command, "/dev/null"], {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, SKILL_POLICY_VIEWPORT_CHILD: scenario },
	});
	assert.equal(child.error, undefined);
	assert.notEqual(child.signal, "SIGTERM", "the PTY child must exit before its timeout");
	assert.equal(child.status, 0, `PTY child failed:\n${child.stdout}\n${child.stderr}`);
	const output = child.stdout.split(/\r?\n/).find((line) => line.includes("VIEWPORT_RESULT "));
	assert.ok(output, `missing PTY result:\n${child.stdout}`);
	return JSON.parse(output.slice(output.indexOf("VIEWPORT_RESULT ") + "VIEWPORT_RESULT ".length).trim()) as ProbeResult;
}

const childScenario = process.env.SKILL_POLICY_VIEWPORT_CHILD;
if (["selection", "error", "config-off", "config-error"].includes(childScenario ?? "")) {
	try {
		const cwd = fs.mkdtempSync(join(os.tmpdir(), "pi-skill-policy-viewport-project-"));
		try {
			const skills = Array.from({ length: 8 }, (_, index) => {
				const config = childScenario === "config-off" || childScenario === "config-error";
				const name = `skill-${index}${config ? "-世界🚀" : ""}`;
				const sourcePath = join(
					fakeHome,
					".pi",
					"agent",
					"git",
					"github.com",
					"acme",
					`package-${index}`,
					"skills",
					name,
					"SKILL.md",
				);
				return skillEntry(name, "", {
					filePath: sourcePath,
					baseDir: dirname(sourcePath),
					sourceInfo: sourceInfoFor(sourcePath),
				});
			});
			const errorPath = "/tmp/long-policy-path-for-viewport/.pi/config/pi-skill-palette.json";
			const terminal = new ProcessTerminal();
			const component = new SkillPaletteComponent(
				{
					catalog: skills,
					initialSection: "global",
					skills,
					queuedSkills: [],
					pinnedSkills: [],
					global: { version: 1, disabled: {} },
					project: { version: 1, overrides: {} },
					projectTrusted: true,
					save: () => {
						if (childScenario === "error" || childScenario === "config-error") throw new Error(`${errorPath} is invalid; refusing to replace it`);
					},
				},
				() => {},
				() => terminal.rows,
			);
			const identityBefore = JSON.stringify(skills.map((skill) => [skill.filePath, skill.sourceInfo.path]));
			const tui = new ViewportProbe(terminal);
			tui.showOverlay(component, { anchor: "center", width: 110 });
			try {
				for (let index = 0; index < 6; index++) component.handleInput("\x1b[B");
				if (childScenario === "error") {
					component.handleInput(" ");
					component.handleInput("\r");
				}
				const beforeViewport = childScenario === "config-off" ? tui.viewport() : undefined;
				if (childScenario === "config-off" || childScenario === "config-error") {
					component.handleInput("\x1b[C");
					component.handleInput("\x1b[C");
					component.handleInput(" ");
					if (childScenario === "config-error") component.handleInput("\r");
					else {
						component.handleInput("\x1b[C");
						component.handleInput("\x1b[C");
						for (let index = 0; index < 6; index++) component.handleInput("\x1b[B");
					}
				}
				const viewport = tui.viewport();
				const result: ProbeResult = {
					viewport,
					beforeViewport,
					selectedPath: `~${skills[5]!.sourceInfo.path.slice(fakeHome.length)}`,
					errorPath,
					section: component.getSection(),
					identityBefore,
					identity: JSON.stringify(skills.map((skill) => [skill.filePath, skill.sourceInfo.path])),
					renderRows: component.render(terminal.columns).length,
					stdout: {
						isTTY: process.stdout.isTTY === true,
						rows: process.stdout.rows ?? 0,
						columns: process.stdout.columns ?? 0,
					},
					terminal: { rows: terminal.rows, columns: terminal.columns },
				};
				tui.hideOverlay();
				console.log(`VIEWPORT_RESULT ${JSON.stringify(result)}`);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	} finally {
		setKeybindings(originalKeybindings);
		fs.rmSync(fakeHome, { recursive: true, force: true });
	}
} else {
	after(() => {
		setKeybindings(originalKeybindings);
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		fs.rmSync(fakeHome, { recursive: true, force: true });
	});

	test("70x24 host composition keeps the selected skill block and its full path reachable", () => {
		const result = runChild("selection");
		assert.deepEqual(result.stdout, { isTTY: true, rows: 24, columns: 70 });
		assert.deepEqual(result.terminal, { rows: 24, columns: 70 });
		assert.equal(result.viewport.length, 24);
		const lines = contentLines(result.viewport);
		const selected = lines.findIndex((line) => line.includes("▸ ● skill-5 · on"));
		assert.ok(selected >= 0, `selected skill-5 is clipped from the real viewport:\n${lines.join("\n")}`);
		assert.match(lines[selected - 1] ?? "", /── package-5/);
		const block = lines.slice(selected).join("").replace(/\s/g, "");
		assert.ok(block.includes(result.selectedPath), `the selected block lost its path:\n${block}`);
	});

	test("70x24 host composition keeps the full save failure and every keyboard control reachable", () => {
		const result = runChild("error");
		assert.deepEqual(result.stdout, { isTTY: true, rows: 24, columns: 70 });
		assert.deepEqual(result.terminal, { rows: 24, columns: 70 });
		assert.equal(result.viewport.length, 24);
		const lines = contentLines(result.viewport);
		assert.ok(lines.some((line) => line.includes("▸ ○ skill-5 · off")), lines.join("\n"));
		const compact = lines.join("").replace(/\s/g, "");
		assert.ok(compact.includes(result.errorPath), `the full policy path is clipped:\n${lines.join("\n")}`);
		const reflowed = lines.join(" ").replace(/\s+/g, " ");
		assert.ok(reflowed.includes("refusing to replace it"), reflowed);
		for (const control of ["↑↓ move", "←→ section", "space toggle", "tab pack", "enter save", "esc discard"]) {
			assert.ok(reflowed.includes(control), `missing ${control}:\n${reflowed}`);
		}
	});
	test("70x24 host composition makes a Config Off preview hide Unicode catalog paths", () => {
		const result = runChild("config-off");
		assert.deepEqual(result.stdout, { isTTY: true, rows: 24, columns: 70 });
		assert.deepEqual(result.terminal, { rows: 24, columns: 70 });
		assert.equal(result.section, "global");
		assert.ok(result.beforeViewport, "the default-On control frame must be captured");
		assert.equal(result.viewport.length, 24);
		assert.equal(result.identity, result.identityBefore, "cosmetic preview never rewrites host identity");
		const before = contentLines(result.beforeViewport).join("").replace(/\s/g, "");
		assert.ok(before.includes(result.selectedPath), `default-On did not include ${result.selectedPath}:\n${before}`);
		const lines = contentLines(result.viewport);
		assert.ok(lines.some((line) => line.includes("▸ ● skill-5-世界🚀 · on")), lines.join("\n"));
		assert.ok(lines.some((line) => line.includes("── package-5")), lines.join("\n"));
		const after = lines.join("").replace(/\s/g, "");
		assert.equal(after.includes(result.selectedPath), false, lines.join("\n"));
		assert.equal(after.includes("SKILL.md"), false, lines.join("\n"));
		const help = lines.join(" ").replace(/\s+/g, " ");
		for (const control of ["↑↓ move", "←→ section", "space toggle", "tab pack", "enter save", "esc discard"]) {
			assert.ok(help.includes(control), `missing ${control}:\n${help}`);
		}
	});

	test("70x24 host composition keeps Config controls and its full save error reachable", () => {
		const result = runChild("config-error");
		assert.deepEqual(result.stdout, { isTTY: true, rows: 24, columns: 70 });
		assert.deepEqual(result.terminal, { rows: 24, columns: 70 });
		assert.equal(result.section, "config");
		assert.equal(result.viewport.length, 24);
		assert.equal(result.identity, result.identityBefore);
		const lines = contentLines(result.viewport);
		assert.ok(lines.some((line) => line.includes("▸ ○ Show skill file paths · Off")), lines.join("\n"));
		const compact = lines.join("").replace(/\s/g, "");
		assert.ok(compact.includes(result.errorPath), `the full config path is clipped:\n${lines.join("\n")}`);
		const reflowed = lines.join(" ").replace(/\s+/g, " ");
		assert.ok(reflowed.includes("refusing to replace it"), reflowed);
		for (const control of ["↑↓ move", "←→ section", "space toggle", "enter save", "esc discard"]) {
			assert.ok(reflowed.includes(control), `missing ${control}:\n${reflowed}`);
		}
	});
}
