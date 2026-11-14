import { formatSkillsForPrompt, type Skill as HostSkill } from "@earendil-works/pi-coding-agent";

type FileReadTool = "read" | "bash" | "indirect";

// The header line is the only difference between the three wordings.
const READ_LINE = "Use the read tool to load";
const BASH_LINE = "Use bash to load";
const INDIRECT_LINE = "Load";

/**
 * How pi appends the skills text this gate splices:
 *
 * - pi <= 0.84 appends the RAW, untrimmed `formatSkillsForPrompt(skills)` with read wording.
 * - pi >= 0.87 renders `<skills>\n{formatSkillsForPrompt(skills, tool).trim()}\n</skills>`,
 *   where tool is the first declared read/bash, or indirect when selected readers are
 *   hidden. Formatters that ignore the tool argument get bash/indirect wording by prefix
 *   substitution.
 *
 * SECURITY: anchor on the full block, never on header text alone — a quoted copy of the
 * header inside project context must not match first, or the disable is bypassed and the
 * splice amputates everything up to the real closer.
 */
function formatBlock(skills: HostSkill[], tool: FileReadTool): string {
	const rendered = formatSkillsForPrompt(skills, tool);
	if (tool !== "read" && rendered === formatSkillsForPrompt(skills, "read")) {
		return rendered.replace(READ_LINE, tool === "bash" ? BASH_LINE : INDIRECT_LINE);
	}
	return rendered;
}

interface BlockVariant {
	text: string;
	tool: FileReadTool;
	trimmed: boolean;
}

interface BlockMatch extends BlockVariant {
	index: number;
}

function blockVariants(skills: HostSkill[]): BlockVariant[] {
	const variants: BlockVariant[] = [];
	const seen = new Set<string>();
	for (const tool of ["read", "bash", "indirect"] as const) {
		const text = formatBlock(skills, tool);
		if (text === "") return []; // pi appends nothing with zero visible skills
		for (const [variantText, trimmed] of [
			[text, false],
			[text.trim(), true],
		] as const) {
			if (seen.has(variantText)) continue;
			seen.add(variantText);
			variants.push({ text: variantText, tool, trimmed });
		}
	}
	return variants;
}

/**
 * The LAST exact full block, compared by end offset so a later framed block wins over an
 * earlier raw dump. On an equal end the wider match wins: the trimmed string is a suffix
 * of the raw one, and splicing the suffix would leave the raw block's "\n\n" behind.
 */
function lastBlock(prompt: string, skills: HostSkill[]): BlockMatch | undefined {
	let best: BlockMatch | undefined;
	for (const variant of blockVariants(skills)) {
		const index = prompt.lastIndexOf(variant.text);
		if (index < 0) continue;
		if (best === undefined) {
			best = { ...variant, index };
			continue;
		}
		const end = index + variant.text.length;
		const bestEnd = best.index + best.text.length;
		if (end > bestEnd || (end === bestEnd && index < best.index)) best = { ...variant, index };
	}
	return best;
}

export function findSkillsBlock(prompt: string, skills: HostSkill[]): number {
	return lastBlock(prompt, skills)?.index ?? -1;
}

export function filterSystemPrompt(
	prompt: string,
	allSkills: HostSkill[],
	disabledFilePaths: ReadonlySet<string>,
): string {
	if (disabledFilePaths.size === 0) return prompt;
	const match = lastBlock(prompt, allSkills);
	if (match === undefined) return prompt; // not found → caller's one-shot alarm fires
	// Package identity is the verbatim sourceInfo.path; filePath is only the rendered <location>.
	const kept = allSkills.filter((skill) => !disabledFilePaths.has(skill.sourceInfo.path));
	// Same tool and framing, so the surviving block stays rendered exactly as pi rendered it.
	const replacement = formatBlock(kept, match.tool);
	if (replacement === "" && match.trimmed) {
		const opening = "<skills>\n";
		const closing = "\n</skills>";
		const before = prompt.slice(0, match.index);
		const after = prompt.slice(match.index + match.text.length);
		if (before.endsWith(opening) && after.startsWith(closing)) {
			// Pi omits an empty skills section and the adjacent native separator.
			const sectionStart = match.index - opening.length;
			const prefix = prompt.slice(0, sectionStart);
			const suffix = after.slice(closing.length);
			if (suffix.startsWith("\n\n")) return prefix + suffix.slice(2);
			if (prefix.endsWith("\n\n")) return prefix.slice(0, -2) + suffix;
			return prefix + suffix;
		}
	}
	return (
		prompt.slice(0, match.index) +
		(match.trimmed ? replacement.trim() : replacement) +
		prompt.slice(match.index + match.text.length)
	);
}

/** Live sizes of the skills block for the picker's tax meter, on the trimmed read form pi >= 0.87 renders. */
export function blockLengths(
	allSkills: HostSkill[],
	disabledFilePaths: ReadonlySet<string>,
): { before: number; after: number } {
	const before = formatSkillsForPrompt(allSkills).trim().length;
	if (disabledFilePaths.size === 0) return { before, after: before };
	const after = formatSkillsForPrompt(
		allSkills.filter((skill) => !disabledFilePaths.has(skill.sourceInfo.path)),
	).trim().length;
	return { before, after };
}
