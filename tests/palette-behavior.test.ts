import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import type { Skill } from "../index.js";
import { buildPinnedSkillPrompt, buildSkillContext, getSkillContent } from "../src/skill-content.js";
import "./helpers/fake-home.js";
import { resolvePolicy } from "../src/policy.js";
import { makeTempSkillDir, skillEntry, sourceInfoFor, writeSkillFile } from "./helpers/fixtures.js";

// index.ts reads the palette theme at module scope, so it loads after the isolated home exists.
const { filterSkills, fuzzyScore, getSelectableSkills, parseSkillCommands, queueSkills, state } = await import("../index.js");

const alpha = skillEntry("alpha");
const beta = skillEntry("beta");
const alphaBeta = skillEntry("alpha-beta");
const parserSkills: Skill[] = [alpha, beta, alphaBeta];

beforeEach(() => {
	state.queuedSkills = [];
	state.pinnedSkills = [];
});

test("fuzzyScore ranks substrings above spaced subsequences", () => {
	assert.equal(fuzzyScore("foo", "foo"), 150);
	assert.equal(fuzzyScore("foo", "foobar"), 125);
	assert.equal(fuzzyScore("ac", "abc"), 20);
	assert.equal(fuzzyScore("abd", "abcd"), 35);
	assert.equal(fuzzyScore("ba", "abc"), 0);
	assert.equal(fuzzyScore("zz", "abc"), 0);
});

test("fuzzyScore expects pre-lowercased input", () => {
	assert.equal(fuzzyScore("FOO", "foo"), 0);
});

test("filterSkills sorts by score, then description weight, then non-matches out", () => {
	const skills = [
		skillEntry("alpha", "", { sortIndex: 0 }),
		skillEntry("alpha12345", "", { sortIndex: 1 }),
		skillEntry("alphabet", "", { sortIndex: 2 }),
		skillEntry("xalp", "alpha helper", { sortIndex: 3 }),
		skillEntry("zzz", "alpha", { sortIndex: 4 }),
	];

	assert.deepEqual(
		filterSkills(skills, "alpha").map((skill) => skill.name),
		["alpha", "alphabet", "alpha12345", "zzz", "xalp"],
	);
});

test("filterSkills breaks score ties by sortIndex", () => {
	const skills = [
		skillEntry("abc", "", { sortIndex: 5 }),
		skillEntry("bca", "", { sortIndex: 2 }),
	];

	assert.deepEqual(filterSkills(skills, "b").map((skill) => skill.name), ["bca", "abc"]);
});

test("filterSkills returns the same array for a blank query and normalizes the query", () => {
	const skills = [skillEntry("alpha")];

	assert.equal(filterSkills(skills, ""), skills);
	assert.equal(filterSkills(skills, "   "), skills);
	assert.deepEqual(filterSkills(skills, "  ALPHA  "), [skills[0]]);
});

test("parseSkillCommands accepts comma and repeated-prefix skill lists", () => {
	assert.deepEqual(parseSkillCommands("/skill:alpha,beta do it", parserSkills), {
		skills: [alpha, beta],
		prompt: "do it",
	});
	assert.deepEqual(parseSkillCommands("/skill:alpha,/skill:beta do it", parserSkills), {
		skills: [alpha, beta],
		prompt: "do it",
	});
});

test("parseSkillCommands keeps the prompt verbatim and omits it when absent", () => {
	assert.deepEqual(parseSkillCommands("/skill:alpha keep  inner  spacing", parserSkills), {
		skills: [alpha],
		prompt: "keep  inner  spacing",
	});
	assert.deepEqual(parseSkillCommands("/skill:alpha", parserSkills), { skills: [alpha], prompt: "" });
	assert.deepEqual(parseSkillCommands("/skill:alpha   ", parserSkills), { skills: [alpha], prompt: "" });
});

test("parseSkillCommands matches the longest skill name at a name boundary", () => {
	assert.deepEqual(parseSkillCommands("/skill:alpha-beta task", parserSkills)?.skills, [alphaBeta]);
	assert.deepEqual(parseSkillCommands("/skill:alpha task", parserSkills)?.skills, [alpha]);
});

test("parseSkillCommands rejects unknown names, partial names, and non-command text", () => {
	assert.equal(parseSkillCommands("/skill:unknown task", parserSkills), null);
	assert.equal(parseSkillCommands("/skill:alpha-extra task", parserSkills), null);
	assert.equal(parseSkillCommands("hello /skill:alpha", parserSkills), null);
	assert.equal(parseSkillCommands("plain text", parserSkills), null);
});

test("parseSkillCommands keeps duplicate names; deduplication happens at queue time", () => {
	assert.deepEqual(parseSkillCommands("/skill:alpha,alpha task", parserSkills), {
		skills: [alpha, alpha],
		prompt: "task",
	});
});

test("queueSkills accepts one, two, then three skills and reports full on the fourth", () => {
	const a = skillEntry("a");
	const b = skillEntry("b");
	const c = skillEntry("c");
	const d = skillEntry("d");

	assert.deepEqual(queueSkills([a]), { status: "queued" });
	assert.deepEqual(queueSkills([b]), { status: "queued" });
	assert.deepEqual(queueSkills([c]), { status: "queued" });
	assert.deepEqual(state.queuedSkills, [a, b, c]);

	assert.deepEqual(queueSkills([d]), { status: "full" });
	assert.deepEqual(state.queuedSkills, [a, b, c]);
});

test("queueSkills queues a batch of three at once", () => {
	const a = skillEntry("a");
	const b = skillEntry("b");
	const c = skillEntry("c");

	assert.deepEqual(queueSkills([a, b, c]), { status: "queued" });
	assert.deepEqual(state.queuedSkills, [a, b, c]);
});

test("queueSkills drops a partial batch when it would overflow the queue", () => {
	const a = skillEntry("a");
	const b = skillEntry("b");
	const c = skillEntry("c");
	const d = skillEntry("d");

	assert.deepEqual(queueSkills([a, b]), { status: "queued" });
	assert.deepEqual(queueSkills([c, d]), { status: "full" });
	assert.deepEqual(state.queuedSkills, [a, b]);
});

test("queueSkills skips paths that are already queued or repeated in the batch", () => {
	const a = skillEntry("a");
	const b = skillEntry("b");
	const c = skillEntry("c");

	assert.deepEqual(queueSkills([a, a]), { status: "queued" });
	assert.deepEqual(state.queuedSkills, [a]);

	assert.deepEqual(queueSkills([b]), { status: "queued" });
	assert.deepEqual(queueSkills([b, c]), { status: "queued" });
	assert.deepEqual(state.queuedSkills, [a, b, c]);
});

test("queueSkills reports queued for an already queued skill path without adding it", () => {
	const a = skillEntry("a");

	assert.deepEqual(queueSkills([a]), { status: "queued" });
	assert.deepEqual(queueSkills([a]), { status: "queued" });
	assert.deepEqual(state.queuedSkills, [a]);
});

test("queueSkills identifies a skill by sourceInfo.path, not by name or body filePath", () => {
	const canonical = skillEntry("a", "", {
		filePath: "/bodies/a/SKILL.md",
		sourceInfo: sourceInfoFor("/packages/a/SKILL.md"),
	});
	const sameSource = skillEntry("a", "", {
		filePath: "/other-body/a.md",
		sourceInfo: sourceInfoFor("/packages/a/SKILL.md"),
	});
	const otherSource = skillEntry("a", "", {
		filePath: "/bodies/a/SKILL.md",
		sourceInfo: sourceInfoFor("/other-packages/a/SKILL.md"),
	});

	assert.deepEqual(queueSkills([canonical, sameSource]), { status: "queued" });
	assert.deepEqual(state.queuedSkills, [canonical]);

	assert.deepEqual(queueSkills([sameSource, otherSource]), { status: "queued" });
	assert.deepEqual(state.queuedSkills, [canonical, otherSource]);
});

test("state keeps queued and pinned entries in separate arrays for one-shot injection", () => {
	assert.deepEqual(Object.keys(state).sort(), ["pinnedSkills", "queuedSkills"]);
	assert.deepEqual(state.queuedSkills, []);
	assert.deepEqual(state.pinnedSkills, []);

	const a = skillEntry("a");
	queueSkills([a]);

	assert.equal(state.queuedSkills[0], a);
	assert.deepEqual(state.pinnedSkills, []);
});

test("getSkillContent strips leading frontmatter and keeps the body verbatim", (t) => {
	const dir = makeTempSkillDir(t);
	const withFrontmatter = writeSkillFile(
		dir,
		"SKILL.md",
		"---\nname: alpha\ndescription: test\n---\n\n# Alpha\n\nLine one.\nLine two.\n",
	);
	const plain = writeSkillFile(dir, "plain.md", "Plain body\n");
	const unterminated = writeSkillFile(dir, "unterminated.md", "---\nname: broken\n");
	const indented = writeSkillFile(dir, "indented.md", " ---\nname: x\n---\nBody\n");

	assert.equal(
		getSkillContent(skillEntry("alpha", "", { filePath: withFrontmatter, baseDir: dir })),
		"# Alpha\n\nLine one.\nLine two.",
	);
	assert.equal(getSkillContent(skillEntry("plain", "", { filePath: plain, baseDir: dir })), "Plain body\n");
	assert.equal(
		getSkillContent(skillEntry("unterminated", "", { filePath: unterminated, baseDir: dir })),
		"---\nname: broken\n",
	);
	assert.equal(
		getSkillContent(skillEntry("indented", "", { filePath: indented, baseDir: dir })),
		" ---\nname: x\n---\nBody\n",
	);
});

test("getSkillContent strips valid UTF-8 BOM and CRLF frontmatter", (t) => {
	const dir = makeTempSkillDir(t);
	const raw = "\ufeff---\r\nname: alpha\r\ndescription: test\r\n---\r\n\r\n# Alpha body\r\n\r\nLine.\r\n";
	const filePath = writeSkillFile(dir, "bom-crlf.md", raw);

	assert.deepEqual(parseFrontmatter(raw), {
		frontmatter: { name: "alpha", description: "test" },
		body: "# Alpha body\n\nLine.",
	});
	assert.equal(getSkillContent(skillEntry("alpha", "", { filePath, baseDir: dir })), "# Alpha body\n\nLine.");
});

test("default pin discovery accepts BOM and CRLF without changing ordinary or invalid files", (t) => {
	const dir = makeTempSkillDir(t);
	const bomRaw = "\ufeff---\r\nname: bom\r\npinned: true\r\n---\r\nBody\r\n";
	assert.equal(parseFrontmatter(bomRaw).frontmatter.pinned, true);

	const files = [
		["bom", writeSkillFile(dir, "bom.md", bomRaw), true],
		["ordinary", writeSkillFile(dir, "ordinary.md", "---\npinned: true\n---\nBody\n"), true],
		["plain", writeSkillFile(dir, "plain.md", "Plain body\n"), false],
		["unterminated", writeSkillFile(dir, "unterminated-pin.md", "---\r\npinned: true\r\n"), false],
	] as const;
	const skills = files.map(([name, filePath]) => skillEntry(name, "", { filePath, baseDir: dir }));
	const selectable = getSelectableSkills(
		{ getSystemPromptOptions: () => ({ cwd: dir, skills }) },
		resolvePolicy({}, null, false),
	);

	assert.deepEqual(selectable.map((skill) => [skill.name, skill.pinByDefault]), [
		["bom", true],
		["ordinary", true],
		["plain", false],
		["unterminated", false],
	]);
});

test("buildSkillContext emits one skill element with baseDir and unescaped location", (t) => {
	const dir = makeTempSkillDir(t);
	const filePath = writeSkillFile(dir, "SKILL.md", "---\nname: alpha\n---\nBody line\n");
	const skill = skillEntry("alpha", "", { filePath, baseDir: dir });

	assert.equal(
		buildSkillContext([skill]),
		`<skill name="alpha" location="${filePath}">\nReferences are relative to ${dir}.\n\nBody line\n</skill>`,
	);
});

test("buildSkillContext escapes XML attributes but not baseDir", (t) => {
	const dir = makeTempSkillDir(t);
	const filePath = writeSkillFile(dir, 'lo&c"at<ion>.md', "---\nname: x\n---\nBody\n");
	const skill = skillEntry('a&b"c<d>e', "", { filePath, baseDir: "/base&x" });

	assert.equal(
		buildSkillContext([skill]),
		`<skill name="a&amp;b&quot;c&lt;d&gt;e" location="${dir}/lo&amp;c&quot;at&lt;ion&gt;.md">\nReferences are relative to /base&x.\n\nBody\n</skill>`,
	);
});

test("buildSkillContext wraps multiple skills in a counted container", (t) => {
	const dir = makeTempSkillDir(t);
	const firstPath = writeSkillFile(dir, "first.md", "---\nname: first\n---\nFirst body\n");
	const secondPath = writeSkillFile(dir, "second.md", "---\nname: second\n---\nSecond body\n");
	const first = skillEntry("first", "", { filePath: firstPath, baseDir: dir });
	const second = skillEntry("second", "", { filePath: secondPath, baseDir: dir });

	assert.equal(
		buildSkillContext([first, second]),
		`<skills count="2">\n` +
			`<skill name="first" location="${firstPath}">\nReferences are relative to ${dir}.\n\nFirst body\n</skill>\n\n` +
			`<skill name="second" location="${secondPath}">\nReferences are relative to ${dir}.\n\nSecond body\n</skill>\n` +
			`</skills>`,
	);
});

test("buildPinnedSkillPrompt prefixes the skill context with the pinned label", (t) => {
	const dir = makeTempSkillDir(t);
	const filePath = writeSkillFile(dir, "SKILL.md", "Pinned body\n");
	const skill = skillEntry("alpha", "", { filePath, baseDir: dir });

	assert.equal(buildPinnedSkillPrompt([skill]), `Pinned skill instructions:\n${buildSkillContext([skill])}`);
});
