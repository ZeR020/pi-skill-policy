import assert from "node:assert/strict";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, test, type TestContext } from "node:test";

import {
	formatSkillsForPrompt,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill as HostSkill,
} from "@earendil-works/pi-coding-agent";

import type { Skill } from "../index.js";
import { resolvePolicy, type EffectivePolicy } from "../src/policy.js";
import { createBeforeAgentStartHandler, type RuntimePolicyDeps } from "../src/runtime-policy.js";
import { filterSystemPrompt } from "../src/prompt-gate.js";
import { beforeAgentStartExtension, runBeforeAgentStart, type BeforeAgentStartHandler } from "./helpers/extension-runner.js";
import "./helpers/fake-home.js";
import { makeTempDir, skillEntry, sourceInfoFor, writeSkillFile } from "./helpers/fixtures.js";

// index.ts reads the palette theme at module scope, so it loads after the isolated home exists.
const { default: skillPaletteExtension, setCurrentPolicy, state } = await import("../index.js");

const allowAll = resolvePolicy({}, null, false);

function offPolicy(...skills: Skill[]): EffectivePolicy {
	return resolvePolicy(
		{ disabled: Object.fromEntries(skills.map((skill) => [skill.sourceInfo.path, true])) },
		null,
		false,
	);
}

function promptOptions(skills: HostSkill[], overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
	return { cwd: "/tmp/project", skills, ...overrides };
}

interface RuntimeState {
	queued: Skill[];
	pinned: Skill[];
	warnings: Array<{ key: string; message: string }>;
}

/** Mirrors index's `notifyWarningOnce` contract: one notification per key. */
function depsFor(runtimeState: RuntimeState, policy: EffectivePolicy): RuntimePolicyDeps {
	return {
		getPolicy: () => policy,
		getQueued: () => runtimeState.queued,
		getPinned: () => runtimeState.pinned,
		setQueued: (skills) => {
			runtimeState.queued = skills;
		},
		setPinned: (skills) => {
			runtimeState.pinned = skills;
		},
		notifyWarningOnce: (key, message) => {
			if (runtimeState.warnings.some((warning) => warning.key === key)) return;
			runtimeState.warnings.push({ key, message });
		},
	};
}

function runtimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
	return { queued: [], pinned: [], warnings: [], ...overrides };
}

/** A skill whose SKILL.md exists with a unique body marker. */
function readable(t: TestContext, name: string, marker: string): Skill {
	const dir = makeTempDir(t);
	return skillEntry(name, `desc:${name}`, {
		filePath: writeSkillFile(dir, `${name}.md`, `---\nname: ${name}\n---\n${marker}`),
	});
}

/** Off fixture: the body file never exists, so any attempted read fails loudly. */
function missing(t: TestContext, name: string): Skill {
	const dir = makeTempDir(t);
	return skillEntry(name, `desc:${name}`, { filePath: path.join(dir, "never-written", `${name}.md`) });
}

function messageText(message: { content: string | unknown[] }): string {
	assert.equal(typeof message.content, "string");
	return message.content as string;
}

function policyExtension(deps: RuntimePolicyDeps) {
	const handler = createBeforeAgentStartHandler(deps);
	return beforeAgentStartExtension("/policy.ts", [(event, ctx) => handler(event, ctx)]);
}

function forcingExtension(promptFor: (event: BeforeAgentStartEvent) => string) {
	const handler: BeforeAgentStartHandler = (event) => ({ systemPrompt: promptFor(event) });
	return beforeAgentStartExtension("/forcer.ts", [handler]);
}

type NativeByteTool = "read" | "bash" | "indirect";
type NativeByteCase = "oneOff" | "allVisibleOff" | "hiddenOff";

function nativeByteCatalog(): [Skill, Skill, Skill] {
	return [
		{ name: "α & <β> 🚀", description: "KEEP-雪 <&>", suffix: "on" },
		{ name: "OFF-消す🚀", description: "REMOVE-尾 <&>", suffix: "off" },
		{ name: "HIDDEN-見えない", description: "HIDDEN-不要 <&>", suffix: "hidden", nativeHidden: true },
	].map(({ name, description, suffix, nativeHidden }) => {
		const filePath = `/tmp/native-byte/${suffix}/SKILL-雪-&.md`;
		return skillEntry(name, description, {
			filePath,
			baseDir: path.dirname(filePath),
			sourceInfo: sourceInfoFor(filePath),
			disableModelInvocation: nativeHidden === true,
		});
	}) as [Skill, Skill, Skill];
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function assertSameUtf8(actual: string, expected: string, label: string): void {
	const actualBytes = Buffer.from(actual, "utf8");
	const expectedBytes = Buffer.from(expected, "utf8");
	assert.ok(
		actualBytes.equals(expectedBytes),
		`${label}: expected ${expectedBytes.length} bytes/${sha256(expectedBytes)}, actual ${actualBytes.length} bytes/${sha256(actualBytes)}`,
	);
}

async function assertNativeForcedBytes(tool: NativeByteTool, mode: NativeByteCase): Promise<void> {
	const catalog = nativeByteCatalog();
	const [on, off, hidden] = catalog;
	const offSkills = mode === "oneOff" ? [off] : mode === "allVisibleOff" ? [on, off] : [hidden];
	const offPaths = new Set(offSkills.map((skill) => skill.sourceInfo.path));
	const nativeOptions: Partial<BuildSystemPromptOptions> = {
		cwd: "/tmp/native-byte-雪",
		customPrompt: "CUSTOM-PREAMBLE-首",
		appendSystemPrompt: "ADDENDUM-<雪>",
		sections: { audit: "CUSTOM-SECTION-尾" },
		contextFiles: [{ path: "/tmp/native-byte/CONTEXT-🚀.md", content: "CONTEXT-<雪> & invariant" }],
		selectedTools: tool === "bash" ? ["bash"] : ["read"],
		hiddenTools: tool === "indirect" ? ["read"] : [],
	};
	const forcer = forcingExtension((event) => `PRE-🚀\n${event.systemPrompt}\nPOST-尾`);
	const expected = await runBeforeAgentStart(
		[forcer],
		promptOptions(catalog.filter((skill) => !offPaths.has(skill.sourceInfo.path)), nativeOptions),
	);
	assert.deepEqual(expected.errors, []);
	const expectedPrompt = expected.result.systemPromptOptions.forceSystemPrompt;
	if (typeof expectedPrompt !== "string") throw new Error("the expected public runner must produce a forced prompt");
	const expectedBytes = Buffer.from(expectedPrompt, "utf8");
	const firstMode = { tool, mode };
	const actualPrompts: Buffer[] = [];
	for (let repeat = 0; repeat < 2; repeat++) {
		const runtime = runtimeState();
		const actual = await runBeforeAgentStart(
			[forcer, policyExtension(depsFor(runtime, offPolicy(...offSkills)))],
			promptOptions(catalog, nativeOptions),
		);
		assert.deepEqual(actual.errors, [], "the public runner must not swallow a handler error");
		assert.deepEqual(runtime.warnings, [], "recognized native output must not trigger the opaque-prompt warning");
		assert.deepEqual(
			actual.result.systemPromptOptions.skills.map((skill) => skill.sourceInfo.path),
			catalog.filter((skill) => !offPaths.has(skill.sourceInfo.path)).map((skill) => skill.sourceInfo.path),
		);
		const actualPrompt = actual.result.systemPromptOptions.forceSystemPrompt;
		if (typeof actualPrompt !== "string") throw new Error("the policy runner must produce a forced prompt");
		assert.ok(actualPrompt.startsWith("PRE-🚀\n"));
		assert.ok(actualPrompt.endsWith("\nPOST-尾"));
		assert.equal(actualPrompt.includes("REMOVE-尾"), mode === "hiddenOff");
		actualPrompts.push(Buffer.from(actualPrompt, "utf8"));
		assertSameUtf8(actualPrompt, expectedPrompt, JSON.stringify({ ...firstMode, repeat }));
	}
	assert.equal(actualPrompts[1].equals(actualPrompts[0]), true, "repeat public runs must be byte-identical");
	assert.equal(actualPrompts[0].equals(expectedBytes), true);
}
beforeEach(() => {
	state.queuedSkills = [];
	state.pinnedSkills = [];
});

test("live getter sees this policy's structured filtering and earlier custom sections", async (t) => {
	const on = readable(t, "on", "BODY-ON");
	const off = missing(t, "off");
	const hidden = skillEntry("hidden", "desc:hidden", {
		filePath: writeSkillFile(makeTempDir(t), "hidden.md", "BODY-HIDDEN"),
		disableModelInvocation: true,
	});
	const seen: Array<{ prompt: string; skills: string[] }> = [];

	const appendSection = beforeAgentStartExtension("/append.ts", [
		(event) => {
			event.systemPromptOptions.appendSystemPrompt = "APPEND-SENTINEL";
		},
	]);
	const policy = policyExtension(depsFor(runtimeState(), offPolicy(off)));
	const probe = beforeAgentStartExtension("/probe.ts", [
		(event) => {
			seen.push({ prompt: event.systemPrompt, skills: event.systemPromptOptions.skills.map((skill) => skill.name) });
		},
	]);

	const { result, errors } = await runBeforeAgentStart([appendSection, policy, probe], promptOptions([on, off, hidden]));

	assert.deepEqual(errors, []);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].prompt.includes("APPEND-SENTINEL"), true);
	assert.equal(seen[0].prompt.includes("desc:off"), false);
	assert.equal(seen[0].prompt.includes("desc:on"), true);
	// Native-hidden entries stay in the structured catalog and stay hidden from the prompt.
	assert.deepEqual(seen[0].skills, ["on", "hidden"]);
	assert.equal(seen[0].prompt.includes("desc:hidden"), false);
	assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
});

test("no pins and no pre-forced prompt: queued message without a systemPrompt override", async (t) => {
	const on = readable(t, "on", "BODY-ON");
	const runtime = runtimeState({ queued: [on] });
	const { result, errors } = await runBeforeAgentStart(
		[policyExtension(depsFor(runtime, allowAll))],
		promptOptions([on]),
	);

	assert.deepEqual(errors, []);
	assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0].customType, "skill-context");
	assert.equal(messageText(result.messages[0]).includes("BODY-ON"), true);
	assert.deepEqual(runtime.queued, []);
});

test("enabled pinned skill appends its body and stays pinned", async (t) => {
	const on = readable(t, "on", "BODY-ON");
	const runtime = runtimeState({ pinned: [on] });
	const { result, errors } = await runBeforeAgentStart(
		[policyExtension(depsFor(runtime, allowAll))],
		promptOptions([on]),
	);

	assert.deepEqual(errors, []);
	const forced = result.systemPromptOptions.forceSystemPrompt;
	assert.equal(typeof forced, "string");
	assert.equal(forced?.includes("Pinned skill instructions:"), true);
	assert.equal(forced?.includes("BODY-ON"), true);
	assert.deepEqual(runtime.pinned, [on]);
});

test("Off pinned skill is neither read nor appended, and is pruned", async (t) => {
	const on = readable(t, "on", "BODY-ON");
	const off = missing(t, "off");
	const runtime = runtimeState({ pinned: [off, on] });
	const { result, errors } = await runBeforeAgentStart(
		[policyExtension(depsFor(runtime, offPolicy(off)))],
		promptOptions([on, off]),
	);

	assert.deepEqual(errors, []);
	const forced = result.systemPromptOptions.forceSystemPrompt;
	assert.equal(typeof forced, "string");
	assert.equal(forced?.includes("BODY-ON"), true);
	assert.equal(forced?.includes('name="off"'), false);
	// The pinned append must read the live getter AFTER structured filtering removed the Off skill.
	assert.equal(forced?.includes("desc:off"), false);
	assert.deepEqual(runtime.pinned, [on]);
});

test("Off queued skill is neither read nor injected, and the queue is consumed", async (t) => {
	const on = readable(t, "on", "BODY-ON");
	const off = missing(t, "off");
	const runtime = runtimeState({ queued: [off, on] });
	const { result, errors } = await runBeforeAgentStart(
		[policyExtension(depsFor(runtime, offPolicy(off)))],
		promptOptions([on, off]),
	);

	assert.deepEqual(errors, []);
	assert.equal(result.messages.length, 1);
	const content = messageText(result.messages[0]);
	assert.equal(content.includes("BODY-ON"), true);
	assert.equal(content.includes('name="off"'), false);
	assert.deepEqual(runtime.queued, []);
});

test("two enabled skills produce two blocks and three produce three", async (t) => {
	const alpha = readable(t, "alpha", "BODY-ALPHA");
	const beta = readable(t, "beta", "BODY-BETA");
	const gamma = readable(t, "gamma", "BODY-GAMMA");

	const two = runtimeState({ queued: [alpha, beta] });
	const first = await runBeforeAgentStart([policyExtension(depsFor(two, allowAll))], promptOptions([alpha, beta]));
	assert.deepEqual(first.errors, []);
	const twoBlocks = messageText(first.result.messages[0]);
	assert.equal(twoBlocks.includes('<skills count="2">'), true);
	assert.equal(twoBlocks.split("<skill name=").length - 1, 2);

	const three = runtimeState({ queued: [alpha, beta, gamma] });
	const second = await runBeforeAgentStart(
		[policyExtension(depsFor(three, allowAll))],
		promptOptions([alpha, beta, gamma]),
	);
	assert.deepEqual(second.errors, []);
	const threeBlocks = messageText(second.result.messages[0]);
	assert.equal(threeBlocks.includes('<skills count="3">'), true);
	assert.equal(threeBlocks.split("<skill name=").length - 1, 3);
});

test("pre-forced prompt keeps its sentinel and filters the ORIGINAL catalog snapshot", async (t) => {
	const on = readable(t, "on", "BODY-ON");
	const off = missing(t, "off");
	const catalog = [on, off];
	// The earlier extension forces the prompt pi rendered from the unfiltered catalog.
	const forcer = forcingExtension((event) => `FORCED-SENTINEL\n\n${event.systemPrompt}`);

	const { result, errors } = await runBeforeAgentStart(
		[forcer, policyExtension(depsFor(runtimeState(), offPolicy(off)))],
		promptOptions(catalog),
	);

	assert.deepEqual(errors, []);
	const forced = result.systemPromptOptions.forceSystemPrompt;
	assert.equal(typeof forced, "string");
	assert.equal(forced?.startsWith("FORCED-SENTINEL"), true);
	assert.equal(forced?.includes("desc:on"), true);
	assert.equal(forced?.includes("desc:off"), false);
	// The structured catalog was filtered too, even though this turn renders the forced string.
	assert.deepEqual(result.systemPromptOptions.skills.map((skill) => skill.name), ["on"]);
});

test("raw and trimmed read/bash/indirect forced blocks are repaired", async (t) => {
	const on = readable(t, "on", "BODY-ON");
	const off = missing(t, "off");
	const catalog = [on, off];
	const toolOptions: Record<string, Partial<BuildSystemPromptOptions>> = {
		read: {},
		bash: { selectedTools: ["bash"] },
		indirect: { selectedTools: ["read"], hiddenTools: ["read"] },
	};

	for (const tool of ["read", "bash", "indirect"] as const) {
		for (const trimmed of [false, true]) {
			const block = formatSkillsForPrompt(catalog, tool);
			const forced = (trimmed ? block.trim() : block) + "\n\nFORCED-TAIL";
			const forcer = forcingExtension(() => forced);
			const { result, errors } = await runBeforeAgentStart(
				[forcer, policyExtension(depsFor(runtimeState(), offPolicy(off)))],
				promptOptions(catalog, toolOptions[tool]),
			);

			assert.deepEqual(errors, [], `${tool} trimmed=${trimmed}`);
			const repaired = result.systemPromptOptions.forceSystemPrompt;
			assert.equal(repaired?.includes("desc:off"), false, `${tool} trimmed=${trimmed} removes Off`);
			assert.equal(repaired?.includes("desc:on"), true, `${tool} trimmed=${trimmed} keeps On`);
			assert.equal(repaired?.includes("FORCED-TAIL"), true, `${tool} trimmed=${trimmed} keeps the tail`);
			assert.equal(repaired?.includes("Use the read tool to load"), tool === "read", `${tool} wording`);
			assert.equal(repaired?.includes("Use bash to load"), tool === "bash", `${tool} wording`);
			assert.equal(repaired?.includes("Load a skill's file"), tool === "indirect", `${tool} wording`);
		}
	}
});

test("zero-visible and native-hidden-only catalogs produce no false block warning", async (t) => {
	const hiddenOff = skillEntry("hidden-off", "desc:hidden-off", {
		disableModelInvocation: true,
		filePath: missing(t, "hidden-off").filePath,
	});
	// Pi renders no skills block for a hidden-only catalog, so the forced prompt has none either.
	const forcer = forcingExtension((event) => `FORCED-SENTINEL\n\n${event.systemPrompt}`);

	const hidden = runtimeState();
	const hiddenRun = await runBeforeAgentStart(
		[forcer, policyExtension(depsFor(hidden, offPolicy(hiddenOff)))],
		promptOptions([hiddenOff]),
	);
	assert.deepEqual(hiddenRun.errors, []);
	assert.deepEqual(hidden.warnings, []);
	assert.equal(hiddenRun.result.systemPromptOptions.forceSystemPrompt?.startsWith("FORCED-SENTINEL"), true);

	const empty = runtimeState();
	const emptyRun = await runBeforeAgentStart(
		[forcer, policyExtension(depsFor(empty, offPolicy(hiddenOff)))],
		promptOptions([]),
	);
	assert.deepEqual(emptyRun.errors, []);
	assert.deepEqual(empty.warnings, []);
});

test("unrecognized forced block warns once while queue/pin gates still apply", async (t) => {
	const on = readable(t, "on", "BODY-ON");
	const off = missing(t, "off");
	const runtime = runtimeState({ queued: [on], pinned: [off] });
	// No skills block at all while a native-visible Off skill needs removal.
	const forcer = forcingExtension(() => "FORCED-WITHOUT-SKILLS-BLOCK");
	const deps = depsFor(runtime, offPolicy(off));
	const policy = policyExtension(deps);
	const options = promptOptions([on, off]);

	const first = await runBeforeAgentStart([forcer, policy], options);
	assert.deepEqual(first.errors, []);
	assert.equal(first.result.systemPromptOptions.forceSystemPrompt, "FORCED-WITHOUT-SKILLS-BLOCK");
	assert.equal(runtime.warnings.length, 1);
	assert.match(runtime.warnings[0].message, /^pi-skill-policy: skills block not found/);
	assert.equal(first.result.messages.length, 1);
	assert.equal(messageText(first.result.messages[0]).includes("BODY-ON"), true);
	assert.deepEqual(runtime.pinned, []);
	assert.deepEqual(runtime.queued, []);

	const second = await runBeforeAgentStart([forcer, policy], options);
	assert.deepEqual(second.errors, []);
	assert.equal(runtime.warnings.length, 1);
});

test("an unreadable enabled body warns through the once-notify seam and consumes the queue", async (t) => {
	const broken = missing(t, "broken");
	const runtime = runtimeState({ queued: [broken] });
	const { result, errors } = await runBeforeAgentStart(
		[policyExtension(depsFor(runtime, allowAll))],
		promptOptions([broken]),
	);

	assert.deepEqual(errors, []);
	assert.deepEqual(result.messages, []);
	assert.deepEqual(runtime.queued, []);
	assert.equal(runtime.warnings.length, 1);
	assert.match(runtime.warnings[0].message, /Failed to load selected skills: broken/);
});

// Review P0: a failed body read must not skip repair of an already-forced prompt.
test("an unreadable enabled body still repairs an earlier forced prompt", async (t) => {
	const on = readable(t, "on", "BODY-ON");
	const off = missing(t, "off");
	const broken = missing(t, "broken");
	// The earlier extension forces the block pi rendered from the original [On, Off] catalog.
	const forcer = forcingExtension((event) => `FORCED-SENTINEL\n\n${event.systemPrompt}`);
	const runtime = runtimeState({ queued: [broken] });

	const { result, errors } = await runBeforeAgentStart(
		[forcer, policyExtension(depsFor(runtime, offPolicy(off)))],
		promptOptions([on, off]),
	);

	assert.deepEqual(errors, []);
	const repaired = result.systemPromptOptions.forceSystemPrompt;
	assert.equal(repaired?.startsWith("FORCED-SENTINEL"), true);
	assert.equal(repaired?.includes("desc:on"), true);
	assert.equal(repaired?.includes("desc:off"), false);
	assert.deepEqual(result.messages, []);
	assert.deepEqual(runtime.queued, []);
	assert.equal(runtime.warnings.length, 1);
	assert.match(runtime.warnings[0].message, /Failed to load selected skills: broken/);
});

// Review P0: the same early return also skipped the unrecognized-block warning.
test("an unreadable enabled body still reports an unrecognized forced block", async (t) => {
	const on = readable(t, "on", "BODY-ON");
	const off = missing(t, "off");
	const broken = missing(t, "broken");
	const forcer = forcingExtension(() => "FORCED-WITHOUT-SKILLS-BLOCK");
	const runtime = runtimeState({ queued: [broken] });

	const { result, errors } = await runBeforeAgentStart(
		[forcer, policyExtension(depsFor(runtime, offPolicy(off)))],
		promptOptions([on, off]),
	);

	assert.deepEqual(errors, []);
	assert.equal(result.systemPromptOptions.forceSystemPrompt, "FORCED-WITHOUT-SKILLS-BLOCK");
	assert.deepEqual(result.messages, []);
	assert.deepEqual(runtime.queued, []);
	assert.equal(runtime.warnings.length, 2);
	assert.match(runtime.warnings[0].message, /Failed to load selected skills: broken/);
	assert.match(runtime.warnings[1].message, /skills block not found/);
});

test("registered before_agent_start wiring consumes state and notifies the block warning once", async (t) => {
	let registered: ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<BeforeAgentStartEventResult | undefined>) | undefined;
	skillPaletteExtension({
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		on: (name: string, handler: unknown) => {
			if (name === "before_agent_start") {
				registered = handler as typeof registered;
			}
		},
		getCommands: () => [],
	} as unknown as ExtensionAPI);
	assert.ok(registered, "before_agent_start handler registered");

	const on = readable(t, "on", "BODY-ON");
	const off = missing(t, "off");
	state.queuedSkills = [on];
	state.pinnedSkills = [off];
	setCurrentPolicy(offPolicy(off));
	t.after(() => setCurrentPolicy(allowAll));

	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			setWidget: () => {},
		},
	} as unknown as ExtensionContext;
	const forced = "FORCED-WITHOUT-SKILLS-BLOCK";
	const event = {
		type: "before_agent_start",
		messageType: "user",
		prompt: "",
		systemPrompt: forced,
		systemPromptOptions: {
			...promptOptions([on, off]),
			selectedTools: ["read"],
			hiddenTools: [],
			toolSnippets: {},
			toolGuidelines: {},
			promptGuidelines: [],
			appendSystemPrompt: "",
			sections: {},
			contextFiles: [],
			forceSystemPrompt: forced,
		},
	} as unknown as BeforeAgentStartEvent;

	const first = await registered(event, ctx);
	const second = await registered(event, ctx);

	assert.equal(first?.systemPrompt, undefined);
	assert.equal(messageText(first?.message ?? { content: [] }).includes("BODY-ON"), true);
	assert.equal(second?.systemPrompt, undefined);
	assert.deepEqual(state.queuedSkills, []);
	assert.deepEqual(state.pinnedSkills, []);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /skills block not found/);
});

test("registered before_agent_start warns on stderr once when headless", async (t) => {
	let registered: ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<BeforeAgentStartEventResult | undefined>) | undefined;
	skillPaletteExtension({
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		on: (name: string, handler: unknown) => {
			if (name === "before_agent_start") {
				registered = handler as typeof registered;
			}
		},
		getCommands: () => [],
	} as unknown as ExtensionAPI);
	assert.ok(registered, "before_agent_start handler registered");

	// The body file never exists, so the body read fails and the runtime path warns.
	const broken = missing(t, "headless");
	state.queuedSkills = [broken];
	setCurrentPolicy(allowAll);
	t.after(() => {
		state.queuedSkills = [];
		setCurrentPolicy(allowAll);
	});

	const stderr: string[] = [];
	t.mock.method(console, "error", (message: string) => stderr.push(message));
	const notifications: string[] = [];
	const ctx = {
		mode: "print",
		hasUI: false,
		cwd: "/tmp/project",
		isProjectTrusted: () => false,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			setWidget: () => {},
		},
	} as unknown as ExtensionContext;
	const event = {
		type: "before_agent_start",
		messageType: "user",
		prompt: "",
		systemPrompt: "SYSTEM",
		systemPromptOptions: promptOptions([]),
	} as unknown as BeforeAgentStartEvent;

	assert.equal(await registered(event, ctx), undefined, "a failed read injects nothing this turn");
	assert.deepEqual(state.queuedSkills, [], "the one-shot queue is still consumed");
	state.queuedSkills = [broken];
	assert.equal(await registered(event, ctx), undefined);

	assert.equal(stderr.length, 1, "the runtime warning reaches stderr exactly once");
	assert.match(stderr[0]!, /Failed to load selected skills: headless/);
	assert.deepEqual(notifications, [], "ui.notify is never used without a UI");
});

for (const tool of ["read", "bash", "indirect"] as const) {
	test(`native byte parity ${tool}: one visible Off matches native-filtered UTF-8`, async () => {
		await assertNativeForcedBytes(tool, "oneOff");
	});
	test(`native byte parity ${tool}: all visible Off matches native-filtered UTF-8`, async () => {
		await assertNativeForcedBytes(tool, "allVisibleOff");
	});
}

test("native byte parity: native-hidden-only Off preserves the generated prompt", async () => {
	await assertNativeForcedBytes("read", "hiddenOff");
});

test("native byte parity: unchanged/no-pin/unforced handler returns undefined", async () => {
	const catalog = nativeByteCatalog();
	const runtime = runtimeState();
	const handler = createBeforeAgentStartHandler(depsFor(runtime, allowAll));
	let calls = 0;
	let returned: BeforeAgentStartEventResult | undefined;
	const extension = beforeAgentStartExtension("/unchanged.ts", [async (event, ctx) => {
		calls++;
		returned = await handler(event, ctx);
		return returned;
	}]);
	const { result, errors } = await runBeforeAgentStart([extension], promptOptions(catalog));

	assert.equal(calls, 1);
	assert.equal(returned, undefined);
	assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
	assert.deepEqual(result.messages, []);
	assert.deepEqual(errors, []);
	assert.deepEqual(runtime.warnings, []);
	assert.deepEqual(runtime.queued, []);
	assert.deepEqual(runtime.pinned, []);
	assert.deepEqual(result.systemPromptOptions.skills.map((skill) => skill.sourceInfo.path), catalog.map((skill) => skill.sourceInfo.path));
});

test("native byte parity: ordinary structured Off uses the native live getter without a string override", async () => {
	const [on, off, hidden] = nativeByteCatalog();
	const runtime = runtimeState();
	const handler = createBeforeAgentStartHandler(depsFor(runtime, offPolicy(off)));
	let calls = 0;
	let returned: BeforeAgentStartEventResult | undefined;
	const policy = beforeAgentStartExtension("/structured-policy.ts", [async (event, ctx) => {
		calls++;
		returned = await handler(event, ctx);
		return returned;
	}]);
	let expectedPrompt: string | undefined;
	let actualPrompt: string | undefined;
	const capture = (file: string, write: (prompt: string) => void) => beforeAgentStartExtension(file, [(event) => {
		write(event.systemPrompt);
	}]);
	const options: Partial<BuildSystemPromptOptions> = {
		cwd: "/tmp/native-byte-雪",
		customPrompt: "STRUCTURED-首",
		selectedTools: ["read"],
		sections: { audit: "STRUCTURED-尾" },
	};
	const expected = await runBeforeAgentStart([capture("/expected.ts", (prompt) => { expectedPrompt = prompt; })], promptOptions([on, hidden], options));
	const actual = await runBeforeAgentStart([policy, capture("/actual.ts", (prompt) => { actualPrompt = prompt; })], promptOptions([on, off, hidden], options));

	assert.deepEqual(expected.errors, []);
	assert.deepEqual(actual.errors, []);
	assert.deepEqual(runtime.warnings, []);
	assert.equal(calls, 1);
	assert.equal(returned, undefined);
	assert.equal(actual.result.systemPromptOptions.forceSystemPrompt, undefined);
	assert.deepEqual(actual.result.messages, []);
	assert.deepEqual(actual.result.systemPromptOptions.skills.map((skill) => skill.name), [on.name, hidden.name]);
	if (typeof expectedPrompt !== "string" || typeof actualPrompt !== "string") assert.fail("both public runs must render a prompt");
	assertSameUtf8(actualPrompt, expectedPrompt, "ordinary structured Off");
	assert.ok(actualPrompt.includes("STRUCTURED-首"));
	assert.ok(actualPrompt.endsWith("STRUCTURED-尾\n</audit>"));
	assert.equal(actualPrompt.includes(off.description), false);
	assert.equal(actualPrompt.includes(hidden.description), false);
});

test("native empty-frame correction preserves raw and non-native adjacent markers", () => {
	const [on, off] = nativeByteCatalog();
	const catalog = [on, off];
	const disabled = new Set(catalog.map((skill) => skill.sourceInfo.path));
	const block = formatSkillsForPrompt(catalog, "read");
	assert.equal(
		filterSystemPrompt(`LEGACY-RAW\n${block}\n\nLEGACY-POST-雪`, catalog, disabled),
		"LEGACY-RAW\n\n\nLEGACY-POST-雪",
	);

	const content = block.trim();
	for (const variant of [
		{ input: `<skills> \n${content}\n</skills>`, output: "<skills> \n\n</skills>" },
		{ input: `<skills>\n${content}\n </skills>`, output: "<skills>\n\n </skills>" },
	]) {
		assert.equal(
			filterSystemPrompt(`PREFIX-雪\n${variant.input}\n\nSUFFIX-尾`, catalog, disabled),
			`PREFIX-雪\n${variant.output}\n\nSUFFIX-尾`,
		);
	}
});
