import assert from "node:assert/strict";
import { test } from "node:test";

import { formatSkillsForPrompt, type Skill as HostSkill } from "@earendil-works/pi-coding-agent";

import { blockLengths, filterSystemPrompt, findSkillsBlock } from "../src/prompt-gate.js";

const sk = (name: string, filePath: string, sourceInfoPath = filePath): HostSkill => ({
	name,
	description: `desc:${name}`,
	filePath,
	baseDir: "/x",
	sourceInfo: { path: sourceInfoPath, source: "user", scope: "user", origin: "top-level" },
	disableModelInvocation: false,
});

const READ_LINE = "Use the read tool to load a skill's file when the task matches its description.";
const BASH_LINE = "Use bash to load a skill's file when the task matches its description.";
const INDIRECT_LINE = "Load a skill's file when the task matches its description.";

// Pi >= 0.87 wraps the TRIMMED block: sections[name] = `<${name}>\n${content}\n</${name}>`.
const framed = (skills: HostSkill[], tool: "read" | "bash" | "indirect" = "read"): string =>
	"HEAD\n\n<skills>\n" + formatSkillsForPrompt(skills, tool).trim() + "\n</skills>\n\nTAIL";

test("removes only disabled skills from the skills block, keeps rest byte-identical", () => {
	const all = [sk("a", "/a/SKILL.md"), sk("b", "/b/SKILL.md"), sk("c", "/c/SKILL.md")];
	const prompt = "HEADER." + formatSkillsForPrompt(all) + "\n\nTAIL.";
	const out = filterSystemPrompt(prompt, all, new Set(["/b/SKILL.md"]));
	assert.equal(out.includes("desc:b"), false);
	assert.equal(out.includes("desc:a"), true);
	assert.equal(out.includes("desc:c"), true);
	assert.equal(out.startsWith("HEADER.\n\nThe following"), true);
	assert.equal(out.endsWith("</available_skills>\n\nTAIL."), true);
});

test("all disabled → entire raw block disappears (matches pi's no-skills behavior)", () => {
	const all = [sk("a", "/a/SKILL.md")];
	const prompt = "HEADER." + formatSkillsForPrompt(all) + "\n\nTAIL.";
	const out = filterSystemPrompt(prompt, all, new Set(["/a/SKILL.md"]));
	assert.equal(out.includes("available_skills"), false);
	assert.equal(out, "HEADER.\n\nTAIL.");
});

test("no skills block in prompt → returned untouched", () => {
	const prompt = "HEADER. custom prompt without skills";
	const out = filterSystemPrompt(prompt, [sk("a", "/a/SKILL.md")], new Set(["/a/SKILL.md"]));
	assert.equal(out, prompt);
});

test("empty disabled set → block unchanged", () => {
	const all = [sk("a", "/a/SKILL.md")];
	const prompt = "H" + formatSkillsForPrompt(all);
	assert.equal(filterSystemPrompt(prompt, all, new Set()), prompt);
});

test("blockLengths reports before/after and shrinks with disabled set", () => {
	const all = [sk("a", "/a/SKILL.md"), sk("b", "/b/SKILL.md")];
	const { before, after } = blockLengths(all, new Set(["/b/SKILL.md"]));
	// Meter basis: the read-worded TRIMMED block (the form pi >= 0.87 renders).
	assert.equal(before, formatSkillsForPrompt(all).trim().length);
	assert.equal(before > after, true);
	assert.equal(blockLengths(all, new Set()).after, before);
	assert.equal(blockLengths(all, new Set(["/a/SKILL.md", "/b/SKILL.md"])).after, 0);
});

// Adversarial: project context (appended BEFORE the skills block) contains a copy of
// the header text. The splice must anchor at the REAL appended block, never the quote.
const FAKE_HEADER =
	"\n\nThe following skills provide specialized instructions for specific tasks. quoth the docs";

test("quoted header + fake closer in head → still filters the REAL block", () => {
	const all = [sk("a", "/a/SKILL.md"), sk("b", "/b/SKILL.md")];
	const head = "CTX" + FAKE_HEADER + "\n<available_skills>\nfake\n</available_skills>\n";
	const prompt = head + formatSkillsForPrompt(all) + "\nTAIL";
	const out = filterSystemPrompt(prompt, all, new Set(["/b/SKILL.md"]));
	assert.equal(out.includes("desc:b"), false); // disable NOT bypassed
	assert.equal(out.includes("desc:a"), true);
	assert.equal(out.startsWith(head), true); // fake left alone
	assert.equal(out.endsWith("</available_skills>\nTAIL"), true);
});

test("quoted header without closer → no amputation of head content", () => {
	const all = [sk("a", "/a/SKILL.md")];
	const head = "\n</project_context-tail>" + FAKE_HEADER + "\n";
	const prompt = head + formatSkillsForPrompt(all) + "\nTAIL";
	const out = filterSystemPrompt(prompt, all, new Set(["/a/SKILL.md"]));
	// real block removed (all disabled) but EVERYTHING in head survives
	assert.equal(out, head + "\nTAIL");
	assert.equal(out.includes("</project_context-tail>"), true);
});

test("quoted <available_skills> header alone does not fool the frame anchor", () => {
	const all = [sk("a", "/a/SKILL.md"), sk("b", "/b/SKILL.md")];
	const head = "CTX\nThe docs say: <available_skills> is where skills live.\n";
	const prompt = head + framed(all);
	const out = filterSystemPrompt(prompt, all, new Set(["/b/SKILL.md"]));
	assert.equal(out, head + framed([sk("a", "/a/SKILL.md")]));
	assert.equal(out.includes("desc:b"), false); // disable NOT bypassed
	assert.equal(out.includes("desc:a"), true);
});

test("findSkillsBlock reports the appended block, -1 when absent", () => {
	const all = [sk("a", "/a/SKILL.md")];
	const prompt = "H" + formatSkillsForPrompt(all) + "T";
	assert.equal(findSkillsBlock(prompt, all), 1);
	assert.equal(findSkillsBlock("no block", all), -1);
	assert.equal(findSkillsBlock(prompt, []), -1);
	// pi >= 0.87 framing with no skills content (section omitted) → alarm path.
	assert.equal(findSkillsBlock("HEAD\n\n<skills>\n\n</skills>", all), -1);
});

test("trimmed block inside <skills> framing filters correctly", () => {
	const all = [sk("a", "/a/SKILL.md"), sk("b", "/b/SKILL.md")];
	const out = filterSystemPrompt(framed(all), all, new Set(["/b/SKILL.md"]));
	assert.equal(out, framed([sk("a", "/a/SKILL.md")])); // kept block stays trimmed
	assert.equal(out.includes("desc:b"), false);
	assert.equal(out.includes("desc:a"), true);
	const idx = findSkillsBlock(framed(all), all);
	assert.notEqual(idx, -1);
	assert.equal(framed(all).slice(idx).startsWith("The following skills"), true);
});

test("indirect wording filters while preserving its framing", () => {
	const all = [sk("a", "/a/SKILL.md"), sk("b", "/b/SKILL.md")];
	const out = filterSystemPrompt(framed(all, "indirect"), all, new Set(["/b/SKILL.md"]));
	assert.equal(out, framed([sk("a", "/a/SKILL.md")], "indirect"));
	assert.equal(out.includes(INDIRECT_LINE), true);
	assert.equal(out.includes("desc:b"), false);
});

test("bash wording filters and preserves the bash line", () => {
	const all = [sk("a", "/a/SKILL.md"), sk("b", "/b/SKILL.md")];
	const out = filterSystemPrompt(framed(all, "bash"), all, new Set(["/b/SKILL.md"]));
	assert.equal(out, framed([sk("a", "/a/SKILL.md")], "bash"));
	assert.equal(out.includes(BASH_LINE), true);
	assert.equal(out.includes(READ_LINE), false);
	assert.equal(out.includes("desc:b"), false);
	assert.notEqual(findSkillsBlock(framed(all, "bash"), all), -1);
});

test("quoted indirect headers and earlier copied blocks do not steal the splice", () => {
	const all = [sk("a", "/a/SKILL.md"), sk("b", "/b/SKILL.md")];
	const head =
		"CTX\nThe docs quote a fake frame:\n<skills>\nfake\n</skills>\n" +
		"Quoted block: [" +
		formatSkillsForPrompt(all, "indirect").trim() +
		"]\n";
	const out = filterSystemPrompt(head + framed(all, "indirect"), all, new Set(["/b/SKILL.md"]));
	assert.equal(out, head + framed([sk("a", "/a/SKILL.md")], "indirect"));
});

// A pre-forced prompt can contain an earlier raw dump of the same block. That copy is
// an exact match too, so only the LAST exact block may be spliced.
test("earlier raw copy of the whole block does not steal the splice", () => {
	const all = [sk("a", "/a/SKILL.md"), sk("b", "/b/SKILL.md")];
	const head = "CTX\nPrevious prompt:\n" + formatSkillsForPrompt(all) + "\n---\n";
	const out = filterSystemPrompt(head + framed(all), all, new Set(["/b/SKILL.md"]));
	// The quoted dump keeps its own desc:b; the REAL block must be the one spliced.
	assert.equal(out, head + framed([sk("a", "/a/SKILL.md")]));
});

test("all-disabled indirect native frame is omitted with its adjacent separator", () => {
	const all = [sk("a", "/a/SKILL.md")];
	const out = filterSystemPrompt(framed(all, "indirect"), all, new Set(["/a/SKILL.md"]));
	assert.equal(out, "HEAD\n\nTAIL");
});

test("findSkillsBlock locates a framed indirect block", () => {
	const all = [sk("a", "/a/SKILL.md")];
	const prompt = framed(all, "indirect");
	const idx = findSkillsBlock(prompt, all);
	assert.notEqual(idx, -1);
	assert.equal(prompt.slice(idx).startsWith("The following skills"), true);
});

test("raw indirect block filters and findSkillsBlock returns its full start", () => {
	const all = [sk("a", "/a/SKILL.md"), sk("b", "/b/SKILL.md")];
	const block = formatSkillsForPrompt(all, "indirect");
	const prompt = "HEAD" + block + "\nTAIL";
	const out = filterSystemPrompt(prompt, all, new Set(["/b/SKILL.md"]));
	assert.equal(out, "HEAD" + formatSkillsForPrompt([sk("a", "/a/SKILL.md")], "indirect") + "\nTAIL");
	assert.equal(findSkillsBlock(prompt, all), prompt.indexOf(block));
});

// Older pi formatters ignore the tool argument; the gate rebuilds wording by replacing
// the read prefix, so those constants must stay identical to the host's own wording.
test("legacy synthesized wording matches the host formatter", () => {
	const all = [sk("a", "/a/SKILL.md")];
	const read = formatSkillsForPrompt(all);
	assert.equal(read.replace(READ_LINE, BASH_LINE), formatSkillsForPrompt(all, "bash"));
	assert.equal(read.replace(READ_LINE, INDIRECT_LINE), formatSkillsForPrompt(all, "indirect"));
});

// Package contract: skill identity is the verbatim sourceInfo.path, never filePath.
test("Off identity is sourceInfo.path, not filePath", () => {
	const linked = sk("a", "/canonical/SKILL.md", "/linked/SKILL.md");
	const plain = sk("b", "/b/SKILL.md");
	const all = [linked, plain];
	const prompt = "HEAD" + formatSkillsForPrompt(all) + "\nTAIL";
	const out = filterSystemPrompt(prompt, all, new Set(["/linked/SKILL.md"]));
	assert.equal(out, "HEAD" + formatSkillsForPrompt([plain]) + "\nTAIL");
	assert.equal(out.includes("desc:a"), false);
	// The rendered filePath is not an identity: keying Off by it must not hide the skill.
	assert.equal(filterSystemPrompt(prompt, all, new Set(["/canonical/SKILL.md"])), prompt);
	const { before, after } = blockLengths(all, new Set(["/linked/SKILL.md"]));
	assert.equal(before, formatSkillsForPrompt(all).trim().length);
	assert.equal(after, formatSkillsForPrompt([plain]).trim().length);
	assert.equal(after < before, true);
	assert.equal(blockLengths(all, new Set(["/canonical/SKILL.md"])).after, before);
});

// Pi renders no block at all for a native-hidden catalog; the gate must stay a no-op.
test("native-hidden original catalog has no block, no change, and zero meter", () => {
	const hidden: HostSkill = { ...sk("h", "/h/SKILL.md"), disableModelInvocation: true };
	const all = [hidden];
	const prompt = "HEAD\n\nTAIL";
	assert.equal(formatSkillsForPrompt(all), ""); // host premise: nothing visible to render
	assert.equal(findSkillsBlock("HEAD\n\n<skills>\n\n</skills>\n\nTAIL", all), -1);
	assert.equal(filterSystemPrompt(prompt, all, new Set(["/h/SKILL.md"])), prompt);
	assert.deepEqual(blockLengths(all, new Set(["/h/SKILL.md"])), { before: 0, after: 0 });
});
