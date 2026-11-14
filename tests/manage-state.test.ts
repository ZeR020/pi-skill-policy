import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";

import { formatSkillsForPrompt, type Skill as HostSkill } from "@earendil-works/pi-coding-agent";

import {
	createPending,
	formatEffectiveState,
	formatEffectiveSummary,
	formatNativeTag,
	formatSkillPathLabel,
	isPendingDirty,
	packLabel,
	togglePendingMaster,
	togglePendingPack,
	togglePendingRow,
} from "../src/manage-state.js";
import type { PaletteSkill } from "../src/skill-content.js";
import type { GlobalConfig, ProjectConfig } from "../src/storage.js";
import { skillEntry, sourceInfoFor } from "./helpers/fixtures.js";

function globalConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
	return { version: 1, disabled: {}, ...overrides };
}

function projectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
	return { version: 1, overrides: {}, ...overrides };
}

/** Independent host measurement: what pi would render for this catalog. */
function promptLength(skills: PaletteSkill[]): number {
	return formatSkillsForPrompt(skills as HostSkill[], "read").trim().length;
}

test("createPending copies the saved Global scope without aliasing it", () => {
	const disabled = { "/a/SKILL.md": true as const };
	const global = globalConfig({ disabled, off: true });

	const pending = createPending("global", global, projectConfig());

	assert.deepEqual(pending, { scope: "global", disabled: { "/a/SKILL.md": true }, off: true });
	assert.notEqual((pending as { disabled: unknown }).disabled, global.disabled);

	const toggled = togglePendingRow(pending, "/b/SKILL.md");
	assert.deepEqual(toggled, {
		scope: "global",
		disabled: { "/a/SKILL.md": true, "/b/SKILL.md": true },
		off: true,
	});
	assert.deepEqual(global.disabled, { "/a/SKILL.md": true });
});

test("createPending for a project copies only the Project overrides", () => {
	const project = projectConfig({ overrides: { "/a/SKILL.md": "off", "/b/SKILL.md": "on" } });

	assert.deepEqual(createPending("project", globalConfig({ off: true }), project), {
		scope: "project",
		overrides: { "/a/SKILL.md": "off", "/b/SKILL.md": "on" },
	});
});

test("Global rows stage Off then On, with absence meaning default On", () => {
	const pending = createPending("global", globalConfig(), projectConfig());

	const off = togglePendingRow(pending, "/a/SKILL.md");
	assert.deepEqual(off, { scope: "global", disabled: { "/a/SKILL.md": true }, off: false });

	const on = togglePendingRow(off, "/a/SKILL.md");
	assert.deepEqual(on, { scope: "global", disabled: {}, off: false });
	assert.deepEqual(pending.disabled, {}, "the original pending state stays untouched");
});

test("Global rows keep unrelated staged choices", () => {
	const pending = createPending("global", globalConfig({ disabled: { "/a/SKILL.md": true } }), projectConfig());

	assert.deepEqual(togglePendingRow(pending, "/b/SKILL.md").disabled, {
		"/a/SKILL.md": true,
		"/b/SKILL.md": true,
	});
});

test("Project rows cycle Inherit -> On -> Off -> Inherit and remove the Inherit entry", () => {
	let pending = createPending("project", globalConfig(), projectConfig());

	const on = togglePendingRow(pending, "/a/SKILL.md");
	assert.deepEqual(on.overrides, { "/a/SKILL.md": "on" });

	const off = togglePendingRow(on, "/a/SKILL.md");
	assert.deepEqual(off.overrides, { "/a/SKILL.md": "off" });

	const inherit = togglePendingRow(off, "/a/SKILL.md");
	assert.deepEqual(inherit.overrides, {}, "Inherit is the absent entry, not a stored value");

	const again = togglePendingRow(inherit, "/a/SKILL.md");
	assert.deepEqual(again.overrides, { "/a/SKILL.md": "on" });

	pending = togglePendingRow(pending, "/b/SKILL.md");
	assert.deepEqual(pending.overrides, { "/b/SKILL.md": "on" });
});

test("a Global pack toggle turns the whole pack off, then back on, without touching other rows", () => {
	const alpha = skillEntry("alpha");
	const beta = skillEntry("beta");
	const pending = createPending("global", globalConfig({ disabled: { "/other/SKILL.md": true } }), projectConfig());

	const off = togglePendingPack(pending, [alpha, beta]);
	assert.deepEqual(off.disabled, {
		"/other/SKILL.md": true,
		"/skills/alpha/SKILL.md": true,
		"/skills/beta/SKILL.md": true,
	});

	const on = togglePendingPack(off, [alpha, beta]);
	assert.deepEqual(on.disabled, { "/other/SKILL.md": true });
});

test("a mixed Global pack turns fully on, matching skillmgr's bulk toggle", () => {
	const alpha = skillEntry("alpha");
	const beta = skillEntry("beta");
	const pending = createPending("global", globalConfig({ disabled: { "/skills/alpha/SKILL.md": true } }), projectConfig());

	// Only an entirely On pack turns Off; anything else restores the whole pack.
	assert.deepEqual(togglePendingPack(pending, [alpha, beta]).disabled, {});
});

test("a Project pack cycles On -> Off -> Inherit, staging Inherit as removals", () => {
	const pack = [skillEntry("alpha"), skillEntry("beta"), skillEntry("gamma")];
	const pending = createPending("project", globalConfig(), projectConfig());

	const on = togglePendingPack(pending, pack);
	assert.deepEqual(on.overrides, {
		"/skills/alpha/SKILL.md": "on",
		"/skills/beta/SKILL.md": "on",
		"/skills/gamma/SKILL.md": "on",
	});

	const off = togglePendingPack(on, pack);
	assert.deepEqual(off.overrides, {
		"/skills/alpha/SKILL.md": "off",
		"/skills/beta/SKILL.md": "off",
		"/skills/gamma/SKILL.md": "off",
	});

	const inherit = togglePendingPack(off, pack);
	assert.deepEqual(inherit.overrides, {}, "Project bulk staging can return a pack to Inherit");
});

test("a mixed Project pack stages On for every member", () => {
	const alpha = skillEntry("alpha");
	const beta = skillEntry("beta");
	const gamma = skillEntry("gamma");
	const pending = createPending("project", globalConfig(), projectConfig({
		overrides: { "/skills/alpha/SKILL.md": "on", "/skills/beta/SKILL.md": "off" },
	}));

	assert.deepEqual(togglePendingPack(pending, [alpha, beta, gamma]).overrides, {
		"/skills/alpha/SKILL.md": "on",
		"/skills/beta/SKILL.md": "on",
		"/skills/gamma/SKILL.md": "on",
	});
});

test("a pack toggle with no visible rows changes nothing", () => {
	const pending = createPending("global", globalConfig({ disabled: { "/a/SKILL.md": true } }), projectConfig());

	assert.deepEqual(togglePendingPack(pending, []), pending);
	assert.deepEqual(togglePendingPack(createPending("project", globalConfig(), projectConfig()), []), {
		scope: "project",
		overrides: {},
	});
});

test("the Global master switch never drops staged per-skill choices", () => {
	const pending = createPending("global", globalConfig({ disabled: { "/a/SKILL.md": true } }), projectConfig());

	const off = togglePendingMaster(pending);
	assert.deepEqual(off, { scope: "global", disabled: { "/a/SKILL.md": true }, off: true });

	const on = togglePendingMaster(off);
	assert.deepEqual(on, { scope: "global", disabled: { "/a/SKILL.md": true }, off: false });

	assert.deepEqual(togglePendingMaster(createPending("project", globalConfig(), projectConfig())), {
		scope: "project",
		overrides: {},
	});
});

test("isPendingDirty tracks Global rows and the master switch", () => {
	const saved = globalConfig({ disabled: { "/a/SKILL.md": true } });
	const clean = createPending("global", saved, projectConfig());

	assert.equal(isPendingDirty(saved, clean), false);
	assert.equal(isPendingDirty(saved, togglePendingRow(clean, "/b/SKILL.md")), true);
	assert.equal(isPendingDirty(saved, togglePendingRow(clean, "/a/SKILL.md")), true);
	assert.equal(isPendingDirty(saved, togglePendingMaster(clean)), true);
	assert.equal(isPendingDirty(saved, togglePendingMaster(togglePendingMaster(clean))), false);
	assert.equal(isPendingDirty(globalConfig({ off: true }), clean), true);
});

test("isPendingDirty tracks Project overrides staying Inherit", () => {
	const saved = projectConfig({ overrides: { "/a/SKILL.md": "on" } });
	const clean = createPending("project", globalConfig(), saved);

	assert.equal(isPendingDirty(saved, clean), false);
	const bOn = togglePendingRow(clean, "/b/SKILL.md");
	assert.equal(isPendingDirty(saved, bOn), true);
	const bOff = togglePendingRow(bOn, "/b/SKILL.md");
	assert.equal(isPendingDirty(saved, bOff), true);
	assert.equal(isPendingDirty(saved, togglePendingRow(bOff, "/b/SKILL.md")), false);
	assert.equal(isPendingDirty(saved, togglePendingRow(clean, "/a/SKILL.md")), true);
	assert.equal(
		isPendingDirty(saved, togglePendingRow(togglePendingRow(togglePendingRow(clean, "/a/SKILL.md"), "/a/SKILL.md"), "/a/SKILL.md")),
		false,
		"returning a row to the saved value is not dirty",
	);
});

test("formatNativeTag marks native-hidden skills only", () => {
	assert.equal(formatNativeTag(skillEntry("alpha")), "");
	assert.equal(formatNativeTag(skillEntry("alpha", "", { disableModelInvocation: true })), " (native)");
});

test("formatSkillPathLabel shortens the home directory but keeps the source path", () => {
	const homeSkill = skillEntry("tdd", "", { sourceInfo: sourceInfoFor(`${homedir()}/.agents/skills/tdd/SKILL.md`) });
	assert.equal(formatSkillPathLabel(homeSkill), "~/.agents/skills/tdd/SKILL.md");

	const projectSkill = skillEntry("tdd", "", { sourceInfo: sourceInfoFor("/proj/.pi/skills/tdd/SKILL.md") });
	assert.equal(formatSkillPathLabel(projectSkill), "/proj/.pi/skills/tdd/SKILL.md");
});

function skillAt(sourcePath: string, overrides: Partial<PaletteSkill> = {}): PaletteSkill {
	return skillEntry("skill", "", { sourceInfo: sourceInfoFor(sourcePath), ...overrides });
}

test("packLabel ports the skillmgr discovery label mapping", () => {
	const home = "/home/tester";
	const lock = { "agent-skills": { source: "addyosmani/agent-skills" } };

	assert.equal(
		packLabel(skillAt(`${home}/.pi/agent/git/github.com/obra/superpowers/skills/tdd/SKILL.md`), lock, home),
		"superpowers",
	);
	assert.equal(
		packLabel(skillAt(`${home}/.agents/skills/agent-skills/tdd/SKILL.md`), lock, home),
		"addyosmani",
		"a lockfile owner labels its installed folder",
	);
	assert.equal(
		packLabel(skillAt(`${home}/.agents/skills/find-skills/grill/SKILL.md`), lock, home),
		"find-skills",
		"an unknown lockfile folder falls back to the folder name",
	);
	assert.equal(
		packLabel(skillAt(`${home}/.pi/agent/skills/pi-tool/tdd/SKILL.md`), lock, home),
		"pi-tool",
		"Pi's own skill folder is also a top-level package",
	);
	assert.equal(
		packLabel(skillAt(`${home}/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows/skills/x/SKILL.md`), lock, home),
		"quintinshaw",
		"scoped node_modules keeps the scope, not the package",
	);
	assert.equal(
		packLabel(skillAt("/proj/node_modules/@one/pkg/skills/x/SKILL.md"), lock, home),
		"one",
	);
	assert.equal(
		packLabel(skillAt("/proj/node_modules/@two/pkg/skills/x/SKILL.md"), lock, home),
		"two",
		"the same package basename under another scope is a different pack",
	);
	assert.equal(
		packLabel(skillAt("/proj/node_modules/unscoped-pkg/skills/x/SKILL.md"), lock, home),
		"unscoped-pkg",
		"unscoped node_modules uses the package name, not the skill folder",
	);
	assert.equal(
		packLabel(skillAt(`${home}/.pi/agent/projects-memory/codemem/skills/y/SKILL.md`), lock, home),
		"auto-learned",
	);
	assert.equal(packLabel(skillAt(`/opt/random/SKILL.md`), lock, home), "random");
	assert.equal(packLabel(skillAt(`/SKILL.md`), lock, home), "unknown");
});

test("unscoped npm package skills share their package pack", () => {
	const home = "/home/tester";
	for (const name of ["pi-lens-ast-grep", "pi-lens-lsp-navigation"]) {
		assert.equal(packLabel(skillAt(`${home}/.pi/agent/npm/node_modules/pi-lens/skills/${name}/SKILL.md`), {}, home), "pi-lens");
	}
});

test("Hermes global and project memory skills share the auto-learned pack", () => {
	const home = "/home/tester";
	assert.equal(
		packLabel(skillAt(`${home}/.pi/agent/pi-hermes-memory/skills/audit-custom-game-ev/SKILL.md`), {}, home),
		"auto-learned",
	);
	assert.equal(
		packLabel(skillAt(`${home}/.pi/agent/pi-hermes-memory/skills/audit-pi-extension-maintenance/SKILL.md`), {}, home),
		"auto-learned",
	);
	assert.equal(
		packLabel(skillAt(`${home}/.pi/agent/projects-memory/pi-workspace/skills/pi-skill-policy-ui-verification/SKILL.md`), {}, home),
		"auto-learned",
	);
});

test("unrelated top-level user folders never collapse into one pack", () => {
	const home = "/home/tester";
	assert.equal(packLabel(skillAt(`${home}/.agents/skills/folder-a/x/SKILL.md`), {}, home), "folder-a");
	assert.equal(packLabel(skillAt(`${home}/.agents/skills/folder-b/y/SKILL.md`), {}, home), "folder-b");
});

test("formatEffectiveState resolves the combined pending policy, not just this scope", () => {
	const alpha = skillEntry("alpha");
	const beta = skillEntry("beta");
	const global = globalConfig({ disabled: { [alpha.sourceInfo.path]: true } });

	assert.equal(formatEffectiveState(alpha, global, projectConfig(), true), "off");
	assert.equal(
		formatEffectiveState(alpha, global, projectConfig({ overrides: { [alpha.sourceInfo.path]: "on" } }), true),
		"on",
		"Project On overrides a Global Off",
	);
	assert.equal(
		formatEffectiveState(beta, global, projectConfig({ overrides: { [beta.sourceInfo.path]: "off" } }), true),
		"off",
		"Project Off applies to a Global On skill",
	);
	assert.equal(
		formatEffectiveState(alpha, global, projectConfig({ overrides: { [alpha.sourceInfo.path]: "on" } }), false),
		"off",
		"untrusted Project overrides are ignored",
	);
	assert.equal(
		formatEffectiveState(alpha, globalConfig({ off: true, disabled: { [alpha.sourceInfo.path]: true } }), projectConfig(), true),
		"on",
		"a Global master-off bypasses every restriction",
	);
});

test("formatEffectiveSummary reports effective counts and prompt sizes", () => {
	const alpha = skillEntry("alpha", "alpha description");
	const beta = skillEntry("beta", "beta description");
	const skills = [alpha, beta];
	const global = globalConfig({ disabled: { [beta.sourceInfo.path]: true } });

	const summary = formatEffectiveSummary(global, projectConfig(), true, skills);

	assert.match(summary, /^1\/2 on · prompt /);
	assert.ok(
		summary.includes(`prompt ${promptLength([alpha])}/${promptLength(skills)} ·`),
		`expected live prompt sizes in: ${summary}`,
	);
	assert.ok(summary.includes("global 1 off"), summary);
	assert.ok(summary.includes("project 0 on / 0 off"), summary);
});

test("formatEffectiveSummary applies trusted Project overrides over Global rows", () => {
	const alpha = skillEntry("alpha", "alpha description");
	const beta = skillEntry("beta", "beta description");
	const skills = [alpha, beta];
	const global = globalConfig({ disabled: { [beta.sourceInfo.path]: true } });

	const reenabled = formatEffectiveSummary(
		global,
		projectConfig({ overrides: { [beta.sourceInfo.path]: "on" } }),
		true,
		skills,
	);
	assert.match(reenabled, /^2\/2 on/);
	assert.ok(reenabled.includes("project 1 on / 0 off"), reenabled);

	const projectOff = formatEffectiveSummary(
		globalConfig(),
		projectConfig({ overrides: { [alpha.sourceInfo.path]: "off" } }),
		true,
		skills,
	);
	assert.match(projectOff, /^1\/2 on/);

	// Untrusted projects never contribute overrides, even when a file exists (here: re-enabling beta).
	const untrusted = formatEffectiveSummary(
		global,
		projectConfig({ overrides: { [beta.sourceInfo.path]: "on" } }),
		false,
		skills,
	);
	assert.match(untrusted, /^1\/2 on/);
	assert.ok(untrusted.includes("project untrusted"), untrusted);
});

test("formatEffectiveSummary reports master-off without forgetting staged rows", () => {
	const alpha = skillEntry("alpha", "alpha description");
	const beta = skillEntry("beta", "beta description");
	const skills = [alpha, beta];
	const global = globalConfig({ disabled: { [beta.sourceInfo.path]: true }, off: true });

	const summary = formatEffectiveSummary(global, projectConfig(), true, skills);

	assert.match(summary, /^2\/2 on/);
	assert.ok(summary.includes("global master off"), summary);
	assert.ok(!summary.includes("global 1 off"), summary);
});

test("formatEffectiveSummary counts by source identity, not the body path", () => {
	const divergent = skillEntry("alpha", "alpha description", {
		filePath: "/bodies/alpha/SKILL.md",
		sourceInfo: sourceInfoFor("/packages/alpha/SKILL.md"),
	});

	const summary = formatEffectiveSummary(
		globalConfig({ disabled: { "/packages/alpha/SKILL.md": true } }),
		projectConfig(),
		false,
		[divergent],
	);

	assert.match(summary, /^0\/1 on/);
	assert.ok(summary.includes("0/"), summary);
});
