import * as fs from "node:fs";

import { stripFrontmatter, type SourceInfo } from "@earendil-works/pi-coding-agent";

export interface PaletteSkill {
	name: string;
	description: string;
	/** Body-read and rendered `<location>` path; may differ from `sourceInfo.path`. */
	filePath: string;
	baseDir: string;
	/** Discovery identity for policy, queue, and pins. */
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
	pinByDefault: boolean;
	searchName: string;
	searchDescription: string;
	sortIndex: number;
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Get skill content without frontmatter
 */
export function getSkillContent(skill: PaletteSkill): string {
	return stripFrontmatter(fs.readFileSync(skill.filePath, "utf-8"));
}

export function buildSkillContext(skills: PaletteSkill[]): string {
	const blocks = skills.map((skill) => {
		const skillContent = getSkillContent(skill);
		return `<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${skillContent}\n</skill>`;
	});

	if (blocks.length === 1) return blocks[0];
	return `<skills count="${blocks.length}">\n${blocks.join("\n\n")}\n</skills>`;
}

export function buildPinnedSkillPrompt(skills: PaletteSkill[]): string {
	return `Pinned skill instructions:\n${buildSkillContext(skills)}`;
}
