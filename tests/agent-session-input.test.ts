import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import "./helpers/fake-home.js";

// Keep this module's policy state isolated from the other extension tests.
const { default: paletteExtension } = await import(`../index.js?native-agent-session=${Date.now()}`);

test("bindExtensions loads policy before a native Off command, including a native-hidden one", async (t) => {
	const root = fs.mkdtempSync(join(os.tmpdir(), "pi-skill-policy-native-input-"));
	const agentDir = join(root, "agent");
	const skillPath = join(root, "skills", "native-off", "SKILL.md");
	const nativeHiddenPath = join(root, "skills", "native-hidden-off", "SKILL.md");
	for (const [filePath, extraFrontmatter] of [[skillPath, ""], [nativeHiddenPath, "disable-model-invocation: true\n"]]) {
		fs.mkdirSync(dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `---\nname: ${filePath === skillPath ? "native-off" : "native-hidden-off"}\ndescription: Off invocation fixture\n${extraFrontmatter}---\nNever read this body.\n`);
	}
	fs.mkdirSync(join(agentDir, "config"), { recursive: true });
	fs.writeFileSync(join(agentDir, "config", "pi-skill-palette.json"), JSON.stringify({
		version: 1,
		disabled: { [skillPath]: true, [nativeHiddenPath]: true },
	}));

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
	t.after(async () => {
		if (session && "dispose" in session) await session.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	});
	const errors: unknown[] = [];
	const warnings: string[] = [];
	t.mock.method(console, "error", (...args: unknown[]) => {
		warnings.push(args.join(" "));
	});

	const extensionFactories: Array<typeof paletteExtension> = [paletteExtension];
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		additionalSkillPaths: [skillPath, nativeHiddenPath],
		extensionFactories,
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	// No provider is available here. A gate failure must hit the no-key guard, never inference.
	modelRuntime.getAvailable = async () => [];
	modelRuntime.getAllAvailable = async () => [];
	modelRuntime.getAvailableSnapshot = () => [];
	modelRuntime.hasConfiguredAuth = () => false;
	modelRuntime.checkAuth = async () => undefined;
	await loader.reload();
	assert.equal(loader.getSkills().skills.find((skill) => skill.name === "native-hidden-off")?.disableModelInvocation, true);
	({ session } = await createAgentSession({
		cwd: root,
		agentDir,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(root),
		modelRuntime,
		noTools: "all",
	}));
	const realSession = session;
	realSession.extensionRunner.onError((error) => errors.push(error));
	await realSession.bindExtensions({ mode: "print" });

	let disposition: "handled" | "queued" | "started" | undefined;
	await realSession.prompt("/skill:native-off", { preflightResult: (value) => { disposition = value; } });

	assert.equal(disposition, "handled");
	disposition = undefined;
	await realSession.prompt("/skill:native-hidden-off", { preflightResult: (value) => { disposition = value; } });

	assert.equal(disposition, "handled");
	assert.deepEqual(warnings, [
		'Skill "native-off" is disabled. Re-enable it in /skill Global or Project.',
		'Skill "native-hidden-off" is disabled. Re-enable it in /skill Global or Project.',
	]);
	assert.deepEqual(errors, []);
});
