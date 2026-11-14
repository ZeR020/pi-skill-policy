import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	InputSource,
	Skill as HostSkill,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import type { Skill } from "../index.js";
import { skillKey } from "../src/identity.js";
import {
	MAX_QUEUED_SKILLS,
	parseNativeSkillInvocation,
	resolveInvocationPolicy,
	resolveNativeSkillTarget,
	skillsEnabledByPolicy,
} from "../src/input-gate.js";
import { resolvePolicy, type EffectivePolicy } from "../src/policy.js";
import { globalConfigPath } from "../src/storage.js";
import "./helpers/fake-home.js";
import { makeTempDir, skillEntry, sourceInfoFor } from "./helpers/fixtures.js";
import { loadPolicy, makeHostHarness, setAgentDir, slashCommands, writeConfigFile } from "./helpers/policy-host.js";

// index.ts reads the palette theme at module scope, so it loads after the isolated home exists.
const { default: skillPaletteExtension, filterCompletionSkills, getSelectableSkills, handleSkillInput, queueSkills, setCurrentPolicy, state } =
	await import("../index.js");

const INPUT_SOURCES: InputSource[] = ["interactive", "rpc", "extension"];

const alpha = skillEntry("alpha");
const beta = skillEntry("beta");
const gamma = skillEntry("gamma");
const delta = skillEntry("delta");
const catalog: Skill[] = [alpha, beta, gamma, delta];

function policyOff(...sourcePaths: string[]): EffectivePolicy {
	return resolvePolicy(
		{ disabled: Object.fromEntries(sourcePaths.map((sourcePath) => [sourcePath, true])) },
		null,
		false,
	);
}

const allowAll = resolvePolicy({}, null, false);

function hostSkill(name: string, overrides: Partial<HostSkill> = {}): HostSkill {
	const filePath = overrides.filePath ?? `/skills/${name}/SKILL.md`;
	return {
		name,
		description: "",
		filePath,
		baseDir: `/skills/${name}`,
		sourceInfo: sourceInfoFor(filePath),
		disableModelInvocation: false,
		...overrides,
	};
}

function contextWithSkills(skills: HostSkill[]) {
	return { getSystemPromptOptions: () => ({ cwd: "/tmp", skills }) };
}

beforeEach(() => {
	state.queuedSkills = [];
	state.pinnedSkills = [];
});

test("parseNativeSkillInvocation matches pi's _expandSkillCommand rules exactly", () => {
	assert.deepEqual(parseNativeSkillInvocation("/skill:alpha"), { name: "alpha" });
	assert.deepEqual(parseNativeSkillInvocation("/skill:alpha do the thing"), { name: "alpha" });
	// pi parity: no trim — leading whitespace means pi sends plain text, so no gate.
	assert.equal(parseNativeSkillInvocation(" /skill:alpha\n"), null);
	// pi parity: the name ends at the first ASCII space only, so a tab stays in the name.
	assert.deepEqual(parseNativeSkillInvocation("/skill:alpha\targs"), { name: "alpha\targs" });
	assert.equal(parseNativeSkillInvocation("use the skill:alpha thing"), null);
	assert.equal(parseNativeSkillInvocation("/other:alpha"), null);
	assert.equal(parseNativeSkillInvocation("/skill:"), null);
	assert.equal(parseNativeSkillInvocation(""), null);
});

test("resolveNativeSkillTarget resolves the exposed first-discovery winner only", () => {
	const winner = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/one/alpha/SKILL.md") });
	const shadow = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/two/alpha/SKILL.md") });
	const skills = [winner, shadow, beta];

	assert.equal(resolveNativeSkillTarget(skills, "/skill:alpha"), winner);
	assert.equal(resolveNativeSkillTarget(skills, "/skill:beta"), beta);
	assert.equal(resolveNativeSkillTarget(skills, "/skill:missing"), undefined);
	assert.equal(resolveNativeSkillTarget(skills, "hello"), undefined);
});

test("skillsEnabledByPolicy keys on the verbatim sourceInfo path", () => {
	// Same name, two discovered sources: only the disabled path drops.
	const offWinner = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/one/alpha/SKILL.md") });
	const onShadow = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/two/alpha/SKILL.md") });
	assert.deepEqual(skillsEnabledByPolicy([offWinner, onShadow], policyOff("/one/alpha/SKILL.md")), [onShadow]);

	// The body-read filePath is not the policy identity.
	const divergent = skillEntry("alpha", "", {
		filePath: "/bodies/alpha/SKILL.md",
		sourceInfo: sourceInfoFor("/packages/alpha/SKILL.md"),
	});
	assert.deepEqual(skillsEnabledByPolicy([divergent], policyOff("/bodies/alpha/SKILL.md")), [divergent]);
	assert.deepEqual(skillsEnabledByPolicy([divergent], policyOff("/packages/alpha/SKILL.md")), []);

	// Master bypass restores every entry.
	assert.deepEqual(skillsEnabledByPolicy([offWinner], resolvePolicy({ off: true }, null, false)), [offWinner]);
});

test("resolveInvocationPolicy validates every target before allowing the batch", () => {
	assert.deepEqual(resolveInvocationPolicy([alpha, beta], allowAll), { allowed: true, skills: [alpha, beta] });
	assert.deepEqual(resolveInvocationPolicy([], allowAll), { allowed: true, skills: [] });

	const blocked = resolveInvocationPolicy([alpha, beta, gamma], policyOff(beta.sourceInfo.path, gamma.sourceInfo.path));
	assert.equal(blocked.allowed, false);
	if (!blocked.allowed) assert.deepEqual(blocked.disabled, [beta, gamma]);

	// Divergent body paths never make an enabled skill look disabled.
	const divergent = skillEntry("alpha", "", {
		filePath: "/bodies/alpha/SKILL.md",
		sourceInfo: sourceInfoFor("/packages/alpha/SKILL.md"),
	});
	assert.equal(resolveInvocationPolicy([divergent], policyOff("/bodies/alpha/SKILL.md")).allowed, true);
});

test("filterCompletionSkills omits disabled, already typed, and already queued skills", () => {
	const suggestions = (skills: Skill[], prefix: string, selected: string[], queued: Skill[], policy: EffectivePolicy) =>
		filterCompletionSkills(skills, prefix, new Set(selected), queued, policy)?.map((skill) => skill.name) ?? null;

	assert.deepEqual(suggestions(catalog, "", [], [], allowAll), ["alpha", "beta", "gamma", "delta"]);
	assert.deepEqual(suggestions(catalog, "", [], [], policyOff(beta.sourceInfo.path)), ["alpha", "gamma", "delta"]);
	assert.deepEqual(suggestions(catalog, "", ["alpha"], [], allowAll), ["beta", "gamma", "delta"]);
	assert.deepEqual(suggestions(catalog, "", [], [gamma], allowAll), ["alpha", "beta", "delta"]);
	assert.deepEqual(suggestions(catalog, "al", [], [], allowAll), ["alpha"]);
	assert.equal(suggestions(catalog, "zzz", [], [], allowAll), null);
});

test("filterCompletionSkills drops a queued entry by source path, not by body path", () => {
	const inCatalog = skillEntry("alpha", "", {
		filePath: "/bodies/alpha/SKILL.md",
		sourceInfo: sourceInfoFor("/packages/alpha/SKILL.md"),
	});
	const queuedSameSource = skillEntry("alpha", "", {
		filePath: "/other/body/SKILL.md",
		sourceInfo: sourceInfoFor("/packages/alpha/SKILL.md"),
	});
	assert.deepEqual(filterCompletionSkills([inCatalog, beta], "", new Set(), [queuedSameSource], allowAll), [beta]);
});

test("filterCompletionSkills stops suggesting at the three-skill cap", () => {
	assert.equal(
		filterCompletionSkills(catalog, "", new Set(["alpha", "beta", "gamma"]), [], allowAll),
		null,
	);
	assert.deepEqual(
		filterCompletionSkills(catalog, "", new Set(["alpha", "beta"]), [gamma], allowAll),
		null,
	);
	assert.ok(MAX_QUEUED_SKILLS > 0);
});

test("handleSkillInput keeps pi's own single-command expansion when policy allows it", () => {
	for (const source of INPUT_SOURCES) {
		const result = handleSkillInput({ source, text: "/skill:alpha do it" }, catalog, allowAll);
		assert.deepEqual(result, { action: "continue" }, source);
		assert.deepEqual(state.queuedSkills, [], source);
	}
});

test("handleSkillInput blocks a disabled native invocation from every input source", () => {
	for (const source of INPUT_SOURCES) {
		state.queuedSkills = [beta];
		const result = handleSkillInput({ source, text: "/skill:alpha do it" }, catalog, policyOff(alpha.sourceInfo.path));

		assert.equal(result.action, "handled", source);
		assert.equal(result.action === "handled" ? result.notice.level : undefined, "warning", source);
		assert.match(result.action === "handled" ? result.notice.text : "", /disabled/, source);
		assert.match(result.action === "handled" ? result.notice.text : "", /alpha/, source);
		// A rejected invocation never touches the pending queue.
		assert.deepEqual(state.queuedSkills, [beta], source);
	}
});

test("handleSkillInput leaves unknown and malformed commands to pi", () => {
	for (const text of [
		"/skill:missing",
		"/skill:",
		"/skill:alpha-extra",
		"hello /skill:alpha",
		"/other:alpha",
		"/skill:alpha,missing task",
		"/skill:alpha,/skill:",
	]) {
		assert.deepEqual(handleSkillInput({ source: "interactive", text }, catalog, policyOff(alpha.sourceInfo.path)), {
			action: "continue",
		});
		assert.deepEqual(state.queuedSkills, [], text);
	}
});

test("handleSkillInput queues enabled multi commands exactly as baseline", () => {
	const transforming = handleSkillInput({ source: "interactive", text: "/skill:alpha,beta do it" }, catalog, allowAll);
	assert.equal(transforming.action, "transform");
	assert.equal(transforming.action === "transform" ? transforming.text : "", "do it");
	assert.equal(transforming.action === "transform" ? transforming.notice.level : "", "info");
	assert.deepEqual(state.queuedSkills, [alpha, beta]);

	state.queuedSkills = [];
	const handled = handleSkillInput({ source: "rpc", text: "/skill:alpha,/skill:beta" }, catalog, allowAll);
	assert.equal(handled.action, "handled");
	assert.match(handled.action === "handled" ? handled.notice.text : "", /2\/3/);
	assert.deepEqual(state.queuedSkills, [alpha, beta]);

	state.queuedSkills = [];
	const three = handleSkillInput({ source: "interactive", text: "/skill:alpha,beta,gamma" }, catalog, allowAll);
	assert.equal(three.action, "handled");
	assert.match(three.action === "handled" ? three.notice.text : "", /3\/3/);
	assert.deepEqual(state.queuedSkills, [alpha, beta, gamma]);
});

test("handleSkillInput keeps baseline's extension-originated exemption once policy allows", () => {
	const result = handleSkillInput({ source: "extension", text: "/skill:alpha,beta" }, catalog, allowAll);
	assert.deepEqual(result, { action: "continue" });
	assert.deepEqual(state.queuedSkills, []);
});

test("handleSkillInput rejects the whole multi command when any target is disabled", () => {
	for (const source of INPUT_SOURCES) {
		state.queuedSkills = [gamma];
		const result = handleSkillInput(
			{ source, text: "/skill:alpha,beta,delta do it" },
			catalog,
			policyOff(beta.sourceInfo.path),
		);

		assert.equal(result.action, "handled", source);
		assert.match(result.action === "handled" ? result.notice.text : "", /^Skill "beta" is disabled — nothing was queued/, source);
		// No enabled sibling is queued, transformed, or injected.
		assert.deepEqual(state.queuedSkills, [gamma], source);
	}
});

test("handleSkillInput reports every disabled member of a rejected command", () => {
	const result = handleSkillInput(
		{ source: "interactive", text: "/skill:alpha,beta,gamma" },
		catalog,
		policyOff(alpha.sourceInfo.path, gamma.sourceInfo.path),
	);

	assert.equal(result.action, "handled");
	const text = result.action === "handled" ? result.notice.text : "";
	assert.match(text, /alpha/);
	assert.match(text, /gamma/);
	assert.doesNotMatch(text, /beta/);
	assert.deepEqual(state.queuedSkills, []);
});

test("handleSkillInput only queues new multi commands by source path", () => {
	const divergent = skillEntry("alpha", "", {
		filePath: "/bodies/alpha/SKILL.md",
		sourceInfo: sourceInfoFor("/packages/alpha/SKILL.md"),
	});

	const result = handleSkillInput({ source: "interactive", text: "/skill:alpha,beta" }, [divergent, beta], allowAll);

	assert.equal(result.action, "handled");
	assert.deepEqual(state.queuedSkills, [divergent, beta]);
});

test("handleSkillInput keeps baseline's fourth-skill rejection", () => {
	assert.deepEqual(queueSkills([alpha, beta, gamma]), { status: "queued" });

	const result = handleSkillInput({ source: "interactive", text: "/skill:delta,alpha" }, catalog, allowAll);
	assert.equal(result.action, "handled");
	assert.match(result.action === "handled" ? result.notice.text : "", /up to 3/);
	assert.deepEqual(state.queuedSkills, [alpha, beta, gamma]);
});

test("handleSkillInput removes disabled queue and pin entries and needs a fresh selection", () => {
	state.queuedSkills = [alpha, beta];
	state.pinnedSkills = [gamma, delta];
	const offBetaGamma = policyOff(beta.sourceInfo.path, gamma.sourceInfo.path);

	assert.deepEqual(handleSkillInput({ source: "interactive", text: "/skill:missing" }, catalog, offBetaGamma), {
		action: "continue",
	});
	assert.deepEqual(state.queuedSkills, [alpha]);
	assert.deepEqual(state.pinnedSkills, [delta]);

	// Re-enabling policy does not resurrect the removed entries.
	assert.deepEqual(handleSkillInput({ source: "interactive", text: "/skill:missing" }, catalog, allowAll), {
		action: "continue",
	});
	assert.deepEqual(state.queuedSkills, [alpha]);
	assert.deepEqual(state.pinnedSkills, [delta]);

	assert.deepEqual(queueSkills([beta]), { status: "queued" });
	assert.deepEqual(state.queuedSkills, [alpha, beta]);
});

test("handleSkillInput never promotes a same-name shadow of a disabled winner", () => {
	const offWinner = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/one/alpha/SKILL.md") });
	const onShadow = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/two/alpha/SKILL.md") });
	const skills = [offWinner, onShadow, beta];
	const policy = policyOff(offWinner.sourceInfo.path);

	const single = handleSkillInput({ source: "interactive", text: "/skill:alpha" }, skills, policy);
	assert.equal(single.action, "handled");
	assert.deepEqual(state.queuedSkills, []);

	const multi = handleSkillInput({ source: "interactive", text: "/skill:alpha,beta" }, skills, policy);
	assert.equal(multi.action, "handled");
	assert.deepEqual(state.queuedSkills, []);
});

test("getSelectableSkills filters Load candidates through policy and keeps native metadata", () => {
	const hidden = hostSkill("hidden", {
		filePath: "/bodies/hidden/SKILL.md",
		sourceInfo: sourceInfoFor("/packages/hidden/SKILL.md"),
		disableModelInvocation: true,
	});
	const ctx = contextWithSkills([hostSkill("alpha"), hostSkill("beta"), hidden]);

	const selectable = getSelectableSkills(ctx, policyOff("/skills/beta/SKILL.md"));
	assert.deepEqual(selectable.map((skill) => skill.name), ["alpha", "hidden"]);

	// Native-hidden skills stay loadable; only effective Off removes a candidate.
	const hiddenEntry = selectable.find((skill) => skill.name === "hidden");
	assert.ok(hiddenEntry);
	assert.equal(hiddenEntry.disableModelInvocation, true);
	// The rendered/body path stays filePath; policy identity stays the verbatim source path.
	assert.equal(hiddenEntry.filePath, "/bodies/hidden/SKILL.md");
	assert.equal(skillKey(hiddenEntry), "/packages/hidden/SKILL.md");
});

test("getSelectableSkills never promotes a same-name shadow over a disabled winner", () => {
	const offWinner = hostSkill("alpha", { sourceInfo: sourceInfoFor("/one/alpha/SKILL.md") });
	const onShadow = hostSkill("alpha", { filePath: "/two/alpha/SKILL.md" });
	const ctx = contextWithSkills([offWinner, onShadow, hostSkill("beta")]);

	const selectable = getSelectableSkills(ctx, policyOff("/one/alpha/SKILL.md"));
	assert.deepEqual(selectable.map((skill) => skillKey(skill)), ["/skills/beta/SKILL.md"]);

	// The shadow is not queued through a Load selection either.
	assert.deepEqual(queueSkills(selectable), { status: "queued" });
	assert.ok(!state.queuedSkills.some((skill) => skill.name === "alpha"));
});

test("filterCompletionSkills never suggests a same-name shadow over a disabled winner", () => {
	const offWinner = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/one/alpha/SKILL.md") });
	const onShadow = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/two/alpha/SKILL.md") });
	const policy = policyOff("/one/alpha/SKILL.md");

	assert.equal(filterCompletionSkills([offWinner, onShadow], "al", new Set(), [], policy), null);
	assert.deepEqual(filterCompletionSkills([offWinner, onShadow, beta], "", new Set(), [], policy), [beta]);
});

test("filterCompletionSkills counts occupied source-path slots, not names", () => {
	const first = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/one/alpha/SKILL.md") });
	const second = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/two/alpha/SKILL.md") });
	const third = skillEntry("alpha", "", { sourceInfo: sourceInfoFor("/three/alpha/SKILL.md") });

	// Three distinct source paths occupy all three slots even though they share one name.
	assert.equal(filterCompletionSkills([beta], "", new Set(), [first, second, third], allowAll), null);

	// A typed target and the same skill queued (different body path) occupy one slot.
	const alphaOtherBody = skillEntry("alpha", "", {
		filePath: "/other-body/alpha.md",
		sourceInfo: sourceInfoFor("/skills/alpha/SKILL.md"),
	});
	assert.deepEqual(
		filterCompletionSkills([alpha, beta, gamma], "", new Set(["alpha"]), [alphaOtherBody], allowAll),
		[beta, gamma],
	);
});

test("the registered input adapter refreshes indicators after pruning a disabled pending entry", (t) => {
	const commands: SlashCommandInfo[] = [alpha, beta].map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill",
		sourceInfo: skill.sourceInfo,
	}));
	let inputHandler: ((event: InputEvent, ctx: ExtensionContext) => InputEventResult) | undefined;
	skillPaletteExtension({
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		on: (name: string, handler: unknown) => {
			if (name === "input") {
				inputHandler = handler as (event: InputEvent, ctx: ExtensionContext) => InputEventResult;
			}
		},
		getCommands: () => commands,
	} as unknown as ExtensionAPI);

	state.queuedSkills = [alpha];
	state.pinnedSkills = [alpha];
	setCurrentPolicy(policyOff(alpha.sourceInfo.path));
	t.after(() => setCurrentPolicy(allowAll));

	const statusValues: Array<string | undefined> = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: (_key: string, value: string | undefined) => statusValues.push(value),
			setWidget: () => {},
		},
	} as unknown as ExtensionContext;

	assert.ok(inputHandler, "input handler registered");
	const result = inputHandler({ type: "input", source: "interactive", text: "/skill:missing" }, ctx);

	// A continue result must still repaint the indicators after pruning.
	assert.deepEqual(result, { action: "continue" });
	assert.deepEqual(state.queuedSkills, []);
	assert.deepEqual(state.pinnedSkills, []);
	assert.deepEqual(statusValues, [undefined]);
});

test("the registered input adapter warns on stderr in headless print and JSON modes", (t) => {
	const commands: SlashCommandInfo[] = [alpha, beta].map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill",
		sourceInfo: skill.sourceInfo,
	}));
	const handlers = new Map<string, (event: InputEvent, ctx: ExtensionContext) => InputEventResult>();
	skillPaletteExtension({
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		on: (name: string, handler: unknown) => {
			handlers.set(name, handler as (event: InputEvent, ctx: ExtensionContext) => InputEventResult);
		},
		getCommands: () => commands,
	} as unknown as ExtensionAPI);
	const inputHandler = handlers.get("input");
	assert.ok(inputHandler, "input handler registered");

	setCurrentPolicy(policyOff(alpha.sourceInfo.path));
	t.after(() => setCurrentPolicy(allowAll));
	const stderr: string[] = [];
	t.mock.method(console, "error", (message: string) => stderr.push(message));
	const notifications: string[] = [];
	const headless = (mode: "print" | "json") =>
		({
			mode,
			hasUI: false,
			cwd: "/tmp/project",
			isProjectTrusted: () => false,
			getSystemPromptOptions: () => ({ cwd: "/tmp/project", skills: [hostSkill("alpha"), hostSkill("beta")] }),
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: () => {},
				setWidget: () => {},
			},
		}) as unknown as ExtensionContext;

	for (const mode of ["print", "json"] as const) {
		stderr.length = 0;
		notifications.length = 0;
		const result = inputHandler({ type: "input", source: "interactive", text: "/skill:alpha" }, headless(mode));

		assert.deepEqual(result, { action: "handled" }, `${mode}: the rejected invocation is still handled`);
		assert.equal(stderr.length, 1, `${mode}: exactly one stderr warning`);
		assert.match(stderr[0]!, /disabled/, `${mode}: the warning explains the rejection`);
		assert.deepEqual(notifications, [], `${mode}: ui.notify is never used without a UI`);
		assert.deepEqual(state.queuedSkills, [], `${mode}: nothing is queued`);
	}
});

test("the base autocomplete wrapper removes an Off first-winner without promoting its shadow", async (t) => {
	const offWinner = hostSkill("alpha", { sourceInfo: sourceInfoFor("/one/alpha/SKILL.md") });
	const onShadow = hostSkill("alpha", { filePath: "/two/alpha/SKILL.md" });
	const enabled = hostSkill("beta");
	const skills = [offWinner, onShadow, enabled];
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(globalConfigPath(agentDir), { version: 1, disabled: { [offWinner.sourceInfo.path]: true } });
	t.after(() => setCurrentPolicy(allowAll));

	const policy = loadPolicy(skills);
	const harness = makeHostHarness({ cwd, skills });
	const startup = policy.handlers.get("session_start")?.[0];
	assert.ok(startup);
	await startup({ type: "session_start", reason: "startup" } as never, harness.ctx);

	const base = new CombinedAutocompleteProvider([
		...slashCommands(skills),
		{ name: "prompt-template", description: "unrelated prompt template" },
		{ name: "unrelated", description: "unrelated extension command" },
	], cwd, null);
	const original = await base.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
	assert.deepEqual(original?.items.map((item) => item.value), [
		"skill:alpha",
		"skill:alpha",
		"skill:beta",
		"prompt-template",
		"unrelated",
	]);

	const wrap = harness.autocompleteFactories[0];
	assert.ok(wrap);
	const provider = wrap(base) as AutocompleteProvider;
	const initial = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
	assert.deepEqual(initial?.items.map((item) => item.value), ["skill:beta", "prompt-template", "unrelated"]);

	const filteredCompletion = await provider.getSuggestions(["/skill:a"], 0, 8, { signal: new AbortController().signal });
	assert.deepEqual(filteredCompletion?.items.map((item) => item.value), ["beta"]);
	const enabledCompletion = await provider.getSuggestions(["/skill:b"], 0, 8, { signal: new AbortController().signal });
	assert.deepEqual(enabledCompletion?.items.map((item) => item.value), ["beta"]);
});

test("the base autocomplete wrapper preserves a valid non-skill value collision", async (t) => {
	const offWinner = hostSkill("alpha", { sourceInfo: sourceInfoFor("/collision/alpha/SKILL.md") });
	const enabled = hostSkill("beta");
	const skills = [offWinner, enabled];
	const extensionCommand: SlashCommandInfo = {
		name: "skill:alpha",
		description: "independent extension command",
		source: "extension",
		sourceInfo: sourceInfoFor("/extensions/independent.ts"),
	};
	const agentDir = setAgentDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(globalConfigPath(agentDir), { version: 1, disabled: { [offWinner.sourceInfo.path]: true } });
	t.after(() => setCurrentPolicy(allowAll));
	const policy = loadPolicy(skills, [extensionCommand]);
	const harness = makeHostHarness({ cwd, skills });
	const startup = policy.handlers.get("session_start")?.[0];
	assert.ok(startup);
	await startup({ type: "session_start", reason: "startup" } as never, harness.ctx);

	const base = new CombinedAutocompleteProvider([...slashCommands(skills), extensionCommand], cwd, null);
	const original = await base.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
	assert.deepEqual(original?.items.map((item) => item.value), ["skill:alpha", "skill:beta", "skill:alpha"]);
	const wrap = harness.autocompleteFactories[0];
	assert.ok(wrap);
	const provider = wrap(base) as AutocompleteProvider;
	const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
	assert.deepEqual(suggestions?.items.map((item) => [item.value, item.description]), [
		["skill:alpha", undefined],
		["skill:beta", undefined],
		["skill:alpha", "independent extension command"],
	]);
});
