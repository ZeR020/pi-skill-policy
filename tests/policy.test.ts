import assert from "node:assert/strict";
import { test } from "node:test";

import { firstSkillByName, skillKey } from "../src/identity.js";
import { resolvePolicy, type EffectivePolicy } from "../src/policy.js";
import { skillEntry } from "./helpers/fixtures.js";

const alphaPath = "/home/me/.agents/skills/alpha/SKILL.md";
const betaPath = "/home/me/.pi/agent/skills/beta/SKILL.md";
const livePaths = [alphaPath, betaPath];

type PolicyArgs = Parameters<typeof resolvePolicy>;

interface PolicyRow {
	name: string;
	args: PolicyArgs;
	bypassed: boolean;
	offPaths: string[];
}

const policyRows: PolicyRow[] = [
	{
		name: "default On with no Global entry and no Project",
		args: [{}, null, false],
		bypassed: false,
		offPaths: [],
	},
	{
		name: "default On with explicit empty Global and empty Project",
		args: [{ disabled: {} }, { overrides: {} }, true],
		bypassed: false,
		offPaths: [],
	},
	{
		name: "trusted Project On for a path Global leaves On",
		args: [{}, { overrides: { [alphaPath]: "on" } }, true],
		bypassed: false,
		offPaths: [],
	},
	{
		name: "trusted Project Off overriding Global default On",
		args: [{}, { overrides: { [betaPath]: "off" } }, true],
		bypassed: false,
		offPaths: [betaPath],
	},
	{
		name: "trusted Project On overriding Global Off",
		args: [{ disabled: { [alphaPath]: true } }, { overrides: { [alphaPath]: "on" } }, true],
		bypassed: false,
		offPaths: [],
	},
	{
		name: "trusted Project Off overriding Global On",
		args: [{ disabled: {} }, { overrides: { [betaPath]: "off" } }, true],
		bypassed: false,
		offPaths: [betaPath],
	},
	{
		name: "trusted Project Inherit (absent) keeps Global Off",
		args: [{ disabled: { [alphaPath]: true } }, { overrides: { [betaPath]: "off" } }, true],
		bypassed: false,
		offPaths: [alphaPath, betaPath],
	},
	{
		name: "trusted Project Off agrees with Global Off",
		args: [{ disabled: { [alphaPath]: true } }, { overrides: { [alphaPath]: "off" } }, true],
		bypassed: false,
		offPaths: [alphaPath],
	},
	{
		name: "trusted Project Off with no Global config",
		args: [{}, { overrides: { [alphaPath]: "off", [betaPath]: "off" } }, true],
		bypassed: false,
		offPaths: [alphaPath, betaPath],
	},
	{
		name: "trusted, project null, Global Off",
		args: [{ disabled: { [betaPath]: true } }, null, true],
		bypassed: false,
		offPaths: [betaPath],
	},
	{
		name: "untrusted Project On is ignored",
		args: [{ disabled: { [alphaPath]: true } }, { overrides: { [alphaPath]: "on" } }, false],
		bypassed: false,
		offPaths: [alphaPath],
	},
	{
		name: "untrusted Project Off is ignored",
		args: [{ disabled: {} }, { overrides: { [betaPath]: "off" } }, false],
		bypassed: false,
		offPaths: [],
	},
	{
		name: "untrusted Project overrides both ways are ignored",
		args: [{ disabled: { [betaPath]: true } }, { overrides: { [alphaPath]: "on", [betaPath]: "off" } }, false],
		bypassed: false,
		offPaths: [betaPath],
	},
	{
		name: "Global master off bypasses every restriction",
		args: [{ disabled: { [alphaPath]: true }, off: true }, { overrides: { [betaPath]: "off" } }, true],
		bypassed: true,
		offPaths: [],
	},
	{
		name: "Global master off true with no per-skill entries",
		args: [{ off: true }, null, false],
		bypassed: true,
		offPaths: [],
	},
	{
		name: "Global master off false keeps per-skill entries",
		args: [{ disabled: { [alphaPath]: true }, off: false }, null, false],
		bypassed: false,
		offPaths: [alphaPath],
	},
];

for (const row of policyRows) {
	test(`resolvePolicy: ${row.name}`, () => {
		const policy: EffectivePolicy = resolvePolicy(...row.args);

		assert.equal(policy.bypassed, row.bypassed);
		assert.deepEqual([...policy.offPaths].sort(), [...row.offPaths].sort());
		for (const filePath of [...livePaths, ...row.offPaths]) {
			assert.equal(policy.isEnabled(filePath), !row.offPaths.includes(filePath), filePath);
		}
	});
}

test("skillKey returns the discovered sourceInfo path verbatim, not the body filePath", () => {
	const rawPath = "/home/me/.agents/skills/Alpha/../alpha/SKILL.md";
	const lowerPath = "/home/me/.agents/skills/alpha/SKILL.md";
	const divergent = { sourceInfo: { path: rawPath }, filePath: "/bodies/alpha/SKILL.md" };

	assert.equal(skillKey({ sourceInfo: { path: rawPath } }), rawPath);
	assert.notEqual(skillKey({ sourceInfo: { path: lowerPath } }), skillKey({ sourceInfo: { path: lowerPath.toUpperCase() } }));
	// The body-read/rendered path is never the policy identity.
	assert.equal(skillKey(divergent), rawPath);
});

test("resolvePolicy matches paths verbatim, not normalized or case-folded", () => {
	const policy = resolvePolicy(
		{ disabled: { "/home/me/.agents/skills/Alpha/SKILL.md": true, "/home/me/.agents/skills/alpha/../alpha/SKILL.md": true } },
		{ overrides: { "/home/me/.agents/skills/Alpha/SKILL.md": "on" } },
		true,
	);

	assert.equal(policy.isEnabled(alphaPath), true);
	assert.equal(policy.isEnabled("/home/me/.agents/skills/Alpha/SKILL.md"), true);
	assert.equal(policy.isEnabled("/home/me/.agents/skills/alpha/../alpha/SKILL.md"), false);
});

test("resolvePolicy does not case-fold a configured path", () => {
	const alphaUpperPath = "/home/me/.agents/skills/Alpha/SKILL.md";
	const policy = resolvePolicy({ disabled: { [alphaUpperPath]: true } }, null, false);

	assert.equal(policy.isEnabled(alphaUpperPath), false);
	assert.equal(policy.isEnabled(alphaPath), true);
	assert.deepEqual([...policy.offPaths], [alphaUpperPath]);
});

test("stale absolute paths stay inert and keep their configured identity", () => {
	const stalePath = "/home/me/.agents/skills/alpha/SKILL.md";
	const currentPath = "/home/me/.agents/skills/alpha-v2/SKILL.md";

	const globalPolicy = resolvePolicy({ disabled: { [stalePath]: true } }, null, false);
	assert.equal(globalPolicy.isEnabled(currentPath), true);
	assert.equal(globalPolicy.isEnabled(stalePath), false);
	assert.deepEqual([...globalPolicy.offPaths], [stalePath]);

	const projectPolicy = resolvePolicy({}, { overrides: { [stalePath]: "off" } }, true);
	assert.equal(projectPolicy.isEnabled(currentPath), true);
	assert.equal(projectPolicy.isEnabled(stalePath), false);
	assert.deepEqual([...projectPolicy.offPaths], [stalePath]);
});

test("firstSkillByName returns the first same-name entry in discovery order", () => {
	const winner = skillEntry("alpha", "", { filePath: "/one/alpha/SKILL.md", sortIndex: 1 });
	const shadow = skillEntry("alpha", "", { filePath: "/two/alpha/SKILL.md", sortIndex: 0 });
	const beta = skillEntry("beta", "", { filePath: "/three/beta/SKILL.md", sortIndex: 2 });
	const skills = [beta, winner, shadow];

	assert.equal(firstSkillByName(skills, "alpha"), winner);
	assert.equal(firstSkillByName(skills, "beta"), beta);
	assert.equal(firstSkillByName(skills, "Alpha"), undefined);
	assert.equal(firstSkillByName(skills, "missing"), undefined);
	assert.equal(firstSkillByName([], "alpha"), undefined);

	const found = firstSkillByName(skills, "alpha");
	assert.ok(found);
	assert.equal(skillKey(found), "/one/alpha/SKILL.md");
});

test("resolvePolicy leaves its inputs untouched", () => {
	const global: Parameters<typeof resolvePolicy>[0] = { disabled: { [alphaPath]: true }, off: false };
	const project: Parameters<typeof resolvePolicy>[1] = { overrides: { [alphaPath]: "on", [betaPath]: "off" } };
	const globalBefore = structuredClone(global);
	const projectBefore = structuredClone(project);

	resolvePolicy(global, project, true);

	assert.deepEqual(global, globalBefore);
	assert.deepEqual(project, projectBefore);
});
