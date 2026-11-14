import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";

import type { SourceInfo } from "@earendil-works/pi-coding-agent";

import type { PaletteSkill } from "../../src/skill-content.js";

export function sourceInfoFor(sourcePath: string): SourceInfo {
	return { path: sourcePath, source: "test", scope: "user", origin: "top-level" };
}

export function skillEntry(name: string, description = "", overrides: Partial<PaletteSkill> = {}): PaletteSkill {
	const filePath = overrides.filePath ?? `/skills/${name}/SKILL.md`;
	return {
		name,
		description,
		filePath,
		baseDir: `/skills/${name}`,
		sourceInfo: sourceInfoFor(filePath),
		disableModelInvocation: false,
		pinByDefault: false,
		searchName: name.toLowerCase(),
		searchDescription: description.toLowerCase(),
		sortIndex: 0,
		...overrides,
	};
}

export function makeTempDir(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-policy-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

export function makeTempSkillDir(t: TestContext): string {
	return makeTempDir(t);
}

export function writeSkillFile(dir: string, fileName: string, content: string): string {
	const filePath = path.join(dir, fileName);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}
