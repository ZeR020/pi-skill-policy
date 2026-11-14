import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
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
	fakeHome,
	gamma,
	loadPolicy,
	makeHostHarness,
	readConfigFile,
	setAgentDir,
	writeConfigFile,
	type PolicyHost,
} from "./helpers/policy-host.js";

// index.ts reads the palette theme at module scope, so it loads after the isolated home exists.
const { setCurrentPolicy, state } = await import("../index.js");

const marker = { from: "pi-skill-manager", version: 1 };

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

test("session_start imports the legacy Global config only while the policy file is absent", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const legacyPath = legacySkillManagerPath(agentDir);
	writeConfigFile(legacyPath, { disabled: { "suite/alpha": true }, off: true });
	const legacyBefore = fs.readFileSync(legacyPath);

	const policy = loadPolicy();
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);

	const target = globalConfigPath(agentDir);
	assert.deepEqual(readConfigFile(target), {
		version: 1,
		disabled: { [alpha.filePath]: true },
		off: true,
		migration: marker,
	});
	assert.ok(fs.readFileSync(legacyPath).equals(legacyBefore), "the legacy file must stay byte-identical");

	const imported = fs.readFileSync(target);
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);
	assert.ok(fs.readFileSync(target).equals(imported), "a completed import must never run twice");
});

test("an existing policy Global file is never re-imported or overwritten", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const target = globalConfigPath(agentDir);
	writeConfigFile(target, { version: 1, disabled: { [beta.filePath]: true } });
	const targetBefore = fs.readFileSync(target);
	const legacyPath = legacySkillManagerPath(agentDir);
	writeConfigFile(legacyPath, { disabled: { "suite/alpha": true, "suite/beta": true }, off: true });
	const legacyBefore = fs.readFileSync(legacyPath);

	const policy = loadPolicy();
	state.queuedSkills = [alpha, beta];
	state.pinnedSkills = [alpha, beta];
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);

	assert.ok(fs.readFileSync(target).equals(targetBefore), "a valid policy file must never be re-imported over");
	assert.deepEqual(readConfigFile(target), { version: 1, disabled: { [beta.filePath]: true } });
	assert.ok(fs.readFileSync(legacyPath).equals(legacyBefore));
	assert.deepEqual(state.queuedSkills.map((skill) => skill.name), ["alpha"]);
	assert.deepEqual(state.pinnedSkills.map((skill) => skill.name), ["alpha"]);
});

test("startup applies trusted Global and Project policy and prunes Off pending skills", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(globalConfigPath(agentDir), { version: 1, disabled: { [alpha.filePath]: true } });
	writeConfigFile(projectConfigPath(cwd), {
		version: 1,
		overrides: { [alpha.filePath]: "on", [beta.filePath]: "off" },
	});

	const policy = loadPolicy();
	state.queuedSkills = [alpha, beta];
	state.pinnedSkills = [alpha];
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);

	assert.deepEqual(state.queuedSkills.map((skill) => skill.name), ["alpha"], "Project On overrides Global Off");
	assert.deepEqual(state.pinnedSkills.map((skill) => skill.name), ["alpha"], "Project Off prunes pending pins");
});

test("startup ignores Project policy in an untrusted session without reading the project file", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(globalConfigPath(agentDir), { version: 1, disabled: { [alpha.filePath]: true } });
	const projectPath = projectConfigPath(cwd);
	writeConfigFile(projectPath, { version: 1, overrides: { [alpha.filePath]: "on" } });

	const spy = mock.method(fs, "readFileSync");
	t.after(() => spy.mock.restore());

	const policy = loadPolicy();
	state.queuedSkills = [alpha, beta];
	state.pinnedSkills = [alpha];
	await startSession(policy, makeHostHarness({ cwd, trusted: false }).ctx);

	assert.equal(spy.mock.calls.filter((call) => call.arguments[0] === projectPath).length, 0);
	assert.deepEqual(state.queuedSkills.map((skill) => skill.name), ["beta"]);
	assert.deepEqual(state.pinnedSkills, []);
});

test("startup imports absolute legacy paths without starting the legacy policy owner", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const unmatched = "/retired/only-legacy/SKILL.md";
	writeConfigFile(legacySkillManagerPath(agentDir), { disabled: { [unmatched]: true } });

	const policy = loadPolicy();
	const harness = makeHostHarness({ cwd, trusted: true });
	await startSession(policy, harness.ctx);

	assert.deepEqual(readConfigFile(globalConfigPath(agentDir)), {
		version: 1,
		disabled: { [unmatched]: true },
		migration: marker,
	});
	assert.equal(policy.commands.size, 2, "only the policy's commands exist; no legacy skillmgr command");
	assert.deepEqual(harness.notifications, []);
});

test("startup reports an invalid Global file and fails open without replacing it", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	const target = globalConfigPath(agentDir);
	writeConfigFile(target, "{ not json");
	writeConfigFile(legacySkillManagerPath(agentDir), { disabled: { [alpha.filePath]: true } });
	const before = fs.readFileSync(target);

	const policy = loadPolicy();
	state.queuedSkills = [alpha];
	const harness = makeHostHarness({ cwd, trusted: true });
	await startSession(policy, harness.ctx);

	assert.ok(fs.readFileSync(target).equals(before), "an invalid policy file must never be replaced");
	assert.deepEqual(state.queuedSkills.map((skill) => skill.name), ["alpha"], "invalid Global fails open");
	assert.ok(
		harness.notifications.some((entry) => entry.type === "warning" && entry.message.includes(target)),
		`the invalid path must be visible: ${JSON.stringify(harness.notifications)}`,
	);
});

test("the policy registers exactly one owner for its commands, prompt, input, and session hooks", async (t) => {
	const cwd = makeTempDir(t);
	const policy = loadPolicy();

	assert.deepEqual([...policy.commands.keys()].sort(), ["skill", "skillmgr"]);
	assert.deepEqual([...policy.handlers.keys()].sort(), ["before_agent_start", "input", "session_start"]);
	for (const name of ["before_agent_start", "input", "session_start"]) {
		assert.equal(policy.handlers.get(name)?.length, 1, `${name} must have one policy-owned handler`);
	}
	assert.equal(policy.messageRenderers, 1);

	const harness = makeHostHarness({ cwd, trusted: true });
	await startSession(policy, harness.ctx);
	assert.equal(harness.autocompleteProviders(), 1);
});

async function inputAction(policy: PolicyHost, ctx: ExtensionCommandContext, text: string): Promise<string> {
	const input = policy.handlers.get("input")?.[0];
	assert.ok(input);
	const result = (await input({ source: "interactive", text } as never, ctx)) as { action: string };
	return result.action;
}

test("a deferred legacy pack/name imports once at first post-discovery use and never re-imports", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(legacySkillManagerPath(agentDir), { disabled: { "suite/alpha": true } });
	// alpha is not in the catalog yet: this is the provisional pre-resource-discovery session.
	const policy = loadPolicy([beta]);
	const boot = makeHostHarness({ cwd, trusted: true });
	await startSession(policy, boot.ctx);

	const target = globalConfigPath(agentDir);
	assert.equal(fs.existsSync(target), false, "a deferred import must not write state or a marker");
	assert.deepEqual(boot.notifications, [], "a deferred key is not reported as unresolved yet");

	policy.setSkills([alpha, beta]); // simulated post-session_start resource discovery
	assert.equal(await inputAction(policy, boot.ctx, "/skill:alpha"), "handled", "the import must finalize before gating");
	assert.deepEqual(readConfigFile(target), {
		version: 1,
		disabled: { [alpha.filePath]: true },
		migration: marker,
	});

	const imported = fs.readFileSync(target);
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);
	assert.ok(fs.readFileSync(target).equals(imported), "an existing target must never re-import");
});

test("a deferred key that stays unresolved is reported and marked at the final catalog use", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(legacySkillManagerPath(agentDir), { disabled: { "suite/ghost": true } });
	const policy = loadPolicy([beta]);
	const boot = makeHostHarness({ cwd, trusted: true });
	await startSession(policy, boot.ctx);
	assert.equal(fs.existsSync(globalConfigPath(agentDir)), false);

	await inputAction(policy, boot.ctx, "/skill:beta");

	assert.deepEqual(readConfigFile(globalConfigPath(agentDir)), { version: 1, disabled: {}, migration: marker });
	const issue = boot.notifications.find((entry) => entry.message.includes('legacy key "suite/ghost"'));
	assert.ok(issue, `the unresolved key must be reported at the final boundary: ${JSON.stringify(boot.notifications)}`);
	assert.equal(issue.type, "warning");
});

test("autocomplete suggestions finalize a deferred import before reading commands", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(legacySkillManagerPath(agentDir), { disabled: { "suite/beta": true } });
	const policy = loadPolicy([alpha]);
	const boot = makeHostHarness({ cwd, trusted: true });
	await startSession(policy, boot.ctx);
	policy.setSkills([alpha, beta, gamma]);

	const factory = boot.autocompleteFactories[0];
	assert.ok(factory, "the provider is registered at session_start");
	const provider = factory({}) as {
		getSuggestions(lines: string[], line: number, col: number, options: unknown): Promise<{ items: Array<{ value: string }> } | null>;
	};
	const suggestions = await provider.getSuggestions(["/skill:ga"], 0, 9, {});

	assert.deepEqual(readConfigFile(globalConfigPath(agentDir)), {
		version: 1,
		disabled: { [beta.filePath]: true },
		migration: marker,
	});
	assert.ok(suggestions?.items.some((item) => item.value === "gamma"), "the final catalog feeds suggestions");
});

test("before_agent_start finalizes a deferred import before the policy handler reads it", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(legacySkillManagerPath(agentDir), { disabled: { "suite/alpha": true } });
	const policy = loadPolicy([beta]);
	await startSession(policy, makeHostHarness({ cwd, trusted: true }).ctx);
	policy.setSkills([alpha, beta]);

	const handler = policy.handlers.get("before_agent_start")?.[0];
	assert.ok(handler);
	const event = {
		messageType: "user",
		prompt: "go",
		systemPromptOptions: { cwd, skills: [alpha, beta] },
	};
	await handler(event as never, makeHostHarness({ cwd, trusted: true }).ctx);

	assert.deepEqual(readConfigFile(globalConfigPath(agentDir)), {
		version: 1,
		disabled: { [alpha.filePath]: true },
		migration: marker,
	});
	assert.deepEqual(event.systemPromptOptions.skills.map((skill) => skill.name), ["beta"], "structured filtering uses the final policy");
});

test("startup warnings reach stderr in print/JSON sessions and ui.notify in RPC", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(globalConfigPath(agentDir), "{ not json");
	const target = globalConfigPath(agentDir);
	const policy = loadPolicy();
	const stderr = mock.method(console, "error", () => {});
	t.after(() => stderr.mock.restore());

	for (const mode of ["print", "json"] as const) {
		const before = stderr.mock.calls.length;
		const harness = makeHostHarness({ cwd, trusted: true, mode });
		await startSession(policy, harness.ctx);

		const printed = stderr.mock.calls.slice(before).map((call) => String(call.arguments[0]));
		assert.ok(printed.some((line) => line.includes(target)), `${mode} must print the warning to stderr`);
		assert.equal(harness.notifications.length, 0, `${mode} must not rely on the empty no-UI notify`);
	}

	const beforeRpc = stderr.mock.calls.length;
	const rpc = makeHostHarness({ cwd, trusted: true, mode: "rpc", hasUI: true });
	await startSession(policy, rpc.ctx);
	assert.ok(rpc.notifications.some((entry) => entry.message.includes(target)), "RPC keeps ui.notify");
	assert.equal(stderr.mock.calls.length, beforeRpc, "RPC must not write warnings to stderr");
});

test("a malformed nested lock entry cannot abort startup policy adoption or autocomplete", async (t) => {
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	// First session adopts a restrictive trusted state: beta Off, alpha On.
	writeConfigFile(globalConfigPath(agentDir), { version: 1, disabled: { [beta.filePath]: true } });
	await startSession(loadPolicy(), makeHostHarness({ cwd, trusted: true }).ctx);

	// Next session has a changed Global and trust plus a malformed lock entry for the skills folder.
	writeConfigFile(globalConfigPath(agentDir), { version: 1, disabled: { [alpha.filePath]: true } });
	writeConfigFile(join(fakeHome, ".agents", ".skill-lock.json"), { skills: { suite: { source: 42 } } });
	writeConfigFile(projectConfigPath(cwd), { version: 1, overrides: { [beta.filePath]: "on" } });
	const policy = loadPolicy();
	const harness = makeHostHarness({ cwd, trusted: false });
	await startSession(policy, harness.ctx);

	assert.equal(harness.autocompleteProviders(), 1, "autocomplete must still be registered");
	assert.equal(await inputAction(policy, harness.ctx, "/skill:alpha"), "handled", "fresh Global Off is adopted");
	assert.equal(await inputAction(policy, harness.ctx, "/skill:beta"), "continue", "the previous session policy does not leak");
});
