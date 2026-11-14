import assert from "node:assert/strict";
import fs from "node:fs";
import { beforeEach, mock, test } from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import "./helpers/fake-home.js";
import { legacySkillManagerPath } from "../src/legacy-migration.js";
import { resolvePolicy } from "../src/policy.js";
import { globalConfigPath, projectConfigPath } from "../src/storage.js";
import { makeTempDir } from "./helpers/fixtures.js";
import {
	alpha,
	beta,
	loadPolicy,
	makeHostHarness,
	readConfigFile,
	setAgentDir,
	writeConfigFile,
	type PolicyHost,
} from "./helpers/policy-host.js";

// index.ts reads the palette theme at module scope, so it loads after the isolated home exists.
const { SkillPaletteComponent, setCurrentPolicy, state } = await import("../index.js");
type PaletteComponent = InstanceType<typeof SkillPaletteComponent>;

const marker = { from: "pi-skill-manager", version: 1 };

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

beforeEach(() => {
	state.queuedSkills = [];
	state.pinnedSkills = [];
	setCurrentPolicy(resolvePolicy({}, null, false));
});

async function startSession(policy: PolicyHost, ctx: ExtensionCommandContext): Promise<void> {
	const handler = policy.handlers.get("session_start")?.[0];
	assert.ok(handler, "the policy must own a session_start handler");
	await handler({ type: "session_start", reason: "startup" } as never, ctx);
}

async function runSkillmgr(policy: PolicyHost, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const handler = policy.commands.get("skillmgr");
	assert.ok(handler, "/skillmgr must stay registered");
	await handler(args, ctx);
}

async function blockedByPolicy(policy: PolicyHost, ctx: ExtensionCommandContext): Promise<boolean> {
	const input = policy.handlers.get("input")?.[0];
	assert.ok(input);
	const result = (await input({ source: "interactive", text: "/skill:alpha" } as never, ctx)) as { action: string };
	return result.action === "handled";
}

test("an imported off:true fixture stays recoverable through /skillmgr enable", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(legacySkillManagerPath(agentDir), {
		disabled: { [alpha.filePath]: true },
		off: true,
	});

	const policy = loadPolicy();
	const boot = makeHostHarness({ cwd, trusted: true });
	await startSession(policy, boot.ctx);
	assert.equal(readConfigFile(globalConfigPath(agentDir)).off, true);
	assert.equal(await blockedByPolicy(policy, boot.ctx), false, "a master bypass disables manager restrictions");

	const harness = makeHostHarness({ cwd, trusted: true });
	await runSkillmgr(policy, "enable", harness.ctx);

	assert.equal(harness.reloads(), 1, "a successful master save reloads exactly once");
	const saved = readConfigFile(globalConfigPath(agentDir));
	assert.deepEqual(saved, { version: 1, disabled: { [alpha.filePath]: true }, migration: marker });
	assert.equal(harness.notifications.at(-1)?.type, "info");
	assert.equal(await blockedByPolicy(policy, harness.ctx), true, "enable keeps the imported per-skill choice");
});

test("/skillmgr disable preserves every Global choice and all Project choices", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const retired = "/retired/only-legacy/SKILL.md";
	writeConfigFile(globalConfigPath(agentDir), {
		version: 1,
		disabled: { [alpha.filePath]: true, [retired]: true },
		migration: marker,
	});
	const projectPath = projectConfigPath(cwd);
	writeConfigFile(projectPath, { version: 1, overrides: { [beta.filePath]: "off" } });
	const projectBefore = fs.readFileSync(projectPath);

	const policy = loadPolicy();
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);
	const harness = makeHostHarness({ cwd, trusted: true });
	await runSkillmgr(policy, "disable", harness.ctx);

	assert.equal(harness.reloads(), 1);
	assert.deepEqual(readConfigFile(globalConfigPath(agentDir)), {
		version: 1,
		disabled: { [alpha.filePath]: true, [retired]: true },
		migration: marker,
		off: true,
	});
	assert.ok(fs.readFileSync(projectPath).equals(projectBefore), "Project choices are untouched");
});

test("a failed master save neither reloads nor changes the runtime, state, or file", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const target = globalConfigPath(agentDir);
	writeConfigFile(target, { version: 1, disabled: { [alpha.filePath]: true } });

	const policy = loadPolicy();
	const boot = makeHostHarness({ cwd, trusted: true });
	await startSession(policy, boot.ctx);
	assert.equal(await blockedByPolicy(policy, boot.ctx), true);

	writeConfigFile(target, "{ not json");
	const before = fs.readFileSync(target);
	state.queuedSkills = [beta];

	const harness = makeHostHarness({ cwd, trusted: true });
	await runSkillmgr(policy, "disable", harness.ctx);

	assert.equal(harness.reloads(), 0);
	assert.ok(fs.readFileSync(target).equals(before), "the invalid file is never rewritten");
	assert.deepEqual(state.queuedSkills.map((skill) => skill.name), ["beta"], "pending state is untouched");
	assert.equal(await blockedByPolicy(policy, harness.ctx), true, "the previous runtime policy still applies");
	const failure = harness.notifications.find((entry) => entry.type === "error");
	assert.ok(failure, `a failed save must report an error: ${JSON.stringify(harness.notifications)}`);
	assert.ok(failure.message.includes(target), `the error names the config path: ${failure.message}`);
});

test("a failed master save is visible on stderr in a print session", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const target = globalConfigPath(agentDir);
	writeConfigFile(target, "{ not json");
	const policy = loadPolicy();
	const stderr = mock.method(console, "error", () => {});
	t.after(() => stderr.mock.restore());

	const harness = makeHostHarness({ cwd, trusted: true, mode: "print" });
	await runSkillmgr(policy, "disable", harness.ctx);

	assert.equal(harness.reloads(), 0);
	assert.equal(harness.notifications.length, 0, "print mode has no UI channel");
	assert.ok(
		stderr.mock.calls.some((call) => String(call.arguments[0]).includes(target)),
		`the save error names the config path on stderr: ${JSON.stringify(stderr.mock.calls)}`,
	);
});

test("other /skillmgr arguments print usage without saving or reloading", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const policy = loadPolicy();
	const stderr = mock.method(console, "error", () => {});
	t.after(() => stderr.mock.restore());

	const tui = makeHostHarness({ cwd, trusted: true });
	await runSkillmgr(policy, "frobnicate", tui.ctx);
	assert.equal(tui.notifications[0]?.message, "usage: /skillmgr [disable|enable]");
	assert.equal(tui.reloads(), 0);
	assert.equal(tui.overlays.length, 0);

	for (const mode of ["print", "json"] as const) {
		const harness = makeHostHarness({ cwd, trusted: true, mode });
		const before = stderr.mock.calls.length;
		await runSkillmgr(policy, "frobnicate", harness.ctx);

		const printed = stderr.mock.calls.slice(before).map((call) => String(call.arguments[0]));
		assert.ok(printed.includes("usage: /skillmgr [disable|enable]"), `${mode} usage must reach stderr`);
		assert.equal(harness.notifications.length, 0, `${mode} must not rely on the empty no-UI notify`);
		assert.equal(harness.reloads(), 0);
		assert.equal(harness.overlays.length, 0);
	}

	assert.equal(fs.existsSync(globalConfigPath(agentDir)), false);
	assert.equal(fs.existsSync(projectConfigPath(cwd)), false);
});

test("no-argument /skillmgr opens the shared component on the Global section", async (t) => {
	const cwd = makeTempDir(t);
	const policy = loadPolicy();

	const skillmgr = makeHostHarness({ cwd, trusted: true });
	const skillmgrRun = runSkillmgr(policy, "", skillmgr.ctx);
	const globalOverlay = skillmgr.overlays[0];
	assert.ok(globalOverlay);
	const globalComponent = globalOverlay.component as PaletteComponent;
	assert.ok(globalComponent instanceof SkillPaletteComponent);
	assert.equal(globalComponent.getSection(), "global");
	assert.deepEqual(globalOverlay.options, { overlay: true, overlayOptions: { anchor: "center", width: 110 } });
	globalOverlay.done({ action: "cancel", skill: null });
	await skillmgrRun;
	globalComponent.dispose();

	const skill = makeHostHarness({ cwd, trusted: true });
	const skillRun = policy.commands.get("skill")!("", skill.ctx);
	const loadOverlay = skill.overlays[0];
	assert.ok(loadOverlay);
	const loadComponent = loadOverlay.component as PaletteComponent;
	assert.ok(loadComponent instanceof SkillPaletteComponent);
	assert.equal(loadComponent.getSection(), "load");
	loadOverlay.done({ action: "cancel", skill: null });
	await skillRun;
	loadComponent.dispose();

	assert.equal(skillmgr.reloads() + skill.reloads(), 0);
});

test("no-argument /skillmgr still opens Global management with zero skills", async (t) => {
	const cwd = makeTempDir(t);
	const policy = loadPolicy([]);
	const harness = makeHostHarness({ cwd, trusted: true, skills: [] });

	const run = runSkillmgr(policy, "", harness.ctx);
	const overlay = harness.overlays[0];
	assert.ok(overlay, "Global management must open even when the catalog is empty");
	const component = overlay.component as PaletteComponent;
	assert.equal(component.getSection(), "global");
	assert.match(strip(component.render(70).join("\n")), /Master switch/);
	overlay.done({ action: "cancel", skill: null });
	await run;
	component.dispose();
});

test("headless /skill and /skillmgr write the effective summary to stderr in print/JSON", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(globalConfigPath(agentDir), { version: 1, disabled: { [alpha.filePath]: true } });
	writeConfigFile(projectConfigPath(cwd), { version: 1, overrides: { [beta.filePath]: "off" } });

	const policy = loadPolicy();
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);
	const stderr = mock.method(console, "error", () => {});
	t.after(() => stderr.mock.restore());

	for (const mode of ["print", "json"] as const) {
		const skill = makeHostHarness({ cwd, trusted: true, mode });
		const skillBefore = stderr.mock.calls.length;
		await policy.commands.get("skill")!("", skill.ctx);
		const skillLines = stderr.mock.calls.slice(skillBefore).map((call) => String(call.arguments[0]));

		const skillmgr = makeHostHarness({ cwd, trusted: true, mode });
		const skillmgrBefore = stderr.mock.calls.length;
		await runSkillmgr(policy, "", skillmgr.ctx);
		const skillmgrLines = stderr.mock.calls.slice(skillmgrBefore).map((call) => String(call.arguments[0]));

		assert.equal(skill.overlays.length, 0, "headless /skill never opens the overlay");
		assert.equal(skillmgr.overlays.length, 0, "headless /skillmgr never opens the overlay");
		assert.equal(skill.notifications.length, 0, `${mode} must not rely on the empty no-UI notify`);
		assert.equal(skillmgr.notifications.length, 0, `${mode} must not rely on the empty no-UI notify`);
		assert.equal(skillLines.length, 1, `${mode} /skill must write one summary line to stderr`);
		assert.deepEqual(skillmgrLines, skillLines, `${mode} both commands print the same summary`);
		assert.match(skillLines[0], /^0\/2 on · prompt 0\/\d+ · global 1 off · project 0 on \/ 1 off$/);
	}
});

test("RPC /skill and /skillmgr surface the effective summary through ui.notify", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(globalConfigPath(agentDir), { version: 1, disabled: { [alpha.filePath]: true } });
	writeConfigFile(projectConfigPath(cwd), { version: 1, overrides: { [beta.filePath]: "off" } });

	const policy = loadPolicy();
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);
	const stderr = mock.method(console, "error", () => {});
	t.after(() => stderr.mock.restore());

	const skill = makeHostHarness({ cwd, trusted: true, mode: "rpc", hasUI: true });
	await policy.commands.get("skill")!("", skill.ctx);
	const skillmgr = makeHostHarness({ cwd, trusted: true, mode: "rpc", hasUI: true });
	await runSkillmgr(policy, "", skillmgr.ctx);

	const summary = skill.notifications[0]?.message ?? "";
	assert.equal(skillmgr.notifications[0]?.message, summary);
	assert.match(summary, /^0\/2 on · prompt 0\/\d+ · global 1 off · project 0 on \/ 1 off$/);
	assert.equal(stderr.mock.calls.length, 0, "RPC keeps ui.notify instead of stderr");
});

test("the legacy config stays intact and a removed policy file re-imports deterministically", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const legacyPath = legacySkillManagerPath(agentDir);
	writeConfigFile(legacyPath, {
		disabled: { [alpha.filePath]: true, "suite/beta": true },
		off: true,
	});
	const legacyBefore = fs.readFileSync(legacyPath);

	const policy = loadPolicy();
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);
	const target = globalConfigPath(agentDir);
	const firstImport = readConfigFile(target);
	assert.deepEqual(firstImport, {
		version: 1,
		disabled: { [alpha.filePath]: true, [beta.filePath]: true },
		off: true,
		migration: marker,
	});

	// Configuration preservation only; this is not a legacy-owner restoration test and loads no second owner.
	fs.rmSync(target);
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);
	assert.deepEqual(readConfigFile(target), firstImport);
	assert.ok(fs.readFileSync(legacyPath).equals(legacyBefore));
});

test("/skillmgr disable finalizes a deferred import before saving", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(legacySkillManagerPath(agentDir), { disabled: { "suite/beta": true } });
	const policy = loadPolicy([alpha]);
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);
	assert.equal(fs.existsSync(globalConfigPath(agentDir)), false, "session_start defers the relative key");
	policy.setSkills([alpha, beta]);

	const harness = makeHostHarness({ cwd, trusted: true });
	await runSkillmgr(policy, "disable", harness.ctx);

	assert.deepEqual(readConfigFile(globalConfigPath(agentDir)), {
		version: 1,
		disabled: { [beta.filePath]: true },
		migration: marker,
		off: true,
	});
	assert.equal(harness.reloads(), 1);
});

test("host peer floors exclude unsupported pre-1.5 prompt APIs", () => {
	const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		peerDependencies: Record<string, string>;
	};
	const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
		packages: Record<string, { peerDependencies?: Record<string, string> }>;
	};

	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert.equal(manifest.peerDependencies[name], ">=1.5.0", `${name} must not advertise the broken pre-1.5 prompt path`);
		assert.equal(lock.packages[""]?.peerDependencies?.[name], ">=1.5.0", `lockfile must keep the ${name} floor in sync`);
	}
});

test("plugin identity matches the independent policy package", () => {
	const plugin = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url), "utf8")) as {
		name: string;
		version: string;
		description: string;
		author: { name: string };
		license: string;
		repository?: string;
	};
	const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		name: string;
		version: string;
		author: string;
		license: string;
	};

	assert.equal(plugin.name, manifest.name);
	assert.equal(plugin.version, manifest.version);
	assert.deepEqual(plugin.author, { name: manifest.author });
	assert.equal(plugin.license, manifest.license);
	assert.match(plugin.description, /Global.*Project.*(?:visibility|policy)/i);
	assert.equal(plugin.repository, undefined);
});
