import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { fakeHome } from "./helpers/fake-home.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = path.join(repoRoot, "tests", "fixtures", "palette-foundation.ts");
const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-policy-baseline-"));
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-policy-parity-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const previousUserProfile = process.env.USERPROFILE;
process.env.USERPROFILE = fakeHome;
assert.equal(os.homedir(), fakeHome, "parity fixture must redirect the host home directory");

const baselineSource = fs.readFileSync(fixturePath, "utf-8");
const baselinePath = path.join(baselineDir, "index.ts");
fs.writeFileSync(baselinePath, baselineSource);
fs.writeFileSync(path.join(baselineDir, "package.json"), '{"type":"module"}\n');
fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(baselineDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");

const baselineUrl = pathToFileURL(baselinePath).href;
const policyUrl = pathToFileURL(path.join(repoRoot, "index.ts")).href;
let importSequence = 0;

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserProfile;
	fs.rmSync(baselineDir, { recursive: true, force: true });
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.rmSync(fakeHome, { recursive: true, force: true });
});

type PaletteModule = { default: (pi: unknown) => void };
type Handler = (event: never, ctx: ExtensionCommandContext) => unknown;
type PaletteComponent = { handleInput(data: string): void; dispose(): void };
type Injected = { message?: { content?: unknown }; systemPrompt?: string } | undefined;

interface Overlay {
	component: PaletteComponent;
	done(value: unknown): void;
}

async function loadPair(label: string): Promise<{ baseline: PaletteModule; policy: PaletteModule }> {
	importSequence += 1;
	const suffix = `?baseline-parity=${label}-${importSequence}`;
	return {
		baseline: await import(`${baselineUrl}${suffix}`),
		policy: await import(`${policyUrl}${suffix}`),
	};
}

const skillRoot = path.join(fakeHome, "parity-skills");
const skills = [
	{ name: "alpha", pinned: false, body: "ALPHA-BODY-SENTINEL" },
	{ name: "beta", pinned: false, body: "BETA-BODY-SENTINEL" },
	{ name: "pin", pinned: true, body: "PIN-BODY-SENTINEL" },
].map(({ name, pinned, body }) => {
	const baseDir = path.join(skillRoot, name);
	const filePath = path.join(baseDir, "SKILL.md");
	fs.mkdirSync(baseDir, { recursive: true });
	fs.writeFileSync(
		filePath,
		`---\nname: ${name}\ndescription: ${name} helper\n${pinned ? "pinned: true\n" : ""}---\n${body}\n`,
	);
	return {
		name,
		description: `${name} helper`,
		filePath,
		baseDir,
		sourceInfo: { path: filePath, source: "test", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
	};
});
const commands = skills.map((skill) => ({
	name: `skill:${skill.name}`,
	description: skill.description,
	source: "skill",
	sourceInfo: skill.sourceInfo,
}));

function harness(module: PaletteModule) {
	const handlers = new Map<string, Handler[]>();
	const registeredCommands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const autocompleteFactories: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
	const notices: Array<{ message: string; level?: string }> = [];
	const statuses: Array<string | undefined> = [];
	const widgets: unknown[] = [];
	const overlays: Overlay[] = [];
	const api = {
		registerMessageRenderer: () => {},
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			registeredCommands.set(name, options.handler);
		},
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getCommands: () => commands,
	};
	module.default(api);

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: fakeHome,
		isProjectTrusted: () => true,
		getSystemPromptOptions: () => ({ cwd: fakeHome, skills }),
		ui: {
			notify: (message: string, level?: string) => notices.push({ message, level }),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			setWidget: (_key: string, value: unknown) => widgets.push(value),
			addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => {
				autocompleteFactories.push(factory);
			},
			custom: (
				factory: (_tui: unknown, _theme: unknown, _keys: unknown, done: (value: unknown) => void) => PaletteComponent,
				_options: unknown,
			) => new Promise((resolve) => {
				const component = factory({}, {}, {}, resolve);
				overlays.push({ component, done: resolve });
			}),
		},
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		handlers,
		commands: registeredCommands,
		autocompleteFactories,
		notices,
		statuses,
		widgets,
		overlays,
		dispose() {
			for (const overlay of overlays) overlay.component.dispose();
		},
	};
}

async function invoke<T>(h: ReturnType<typeof harness>, name: string, event: unknown): Promise<T> {
	const handler = h.handlers.get(name)?.[0];
	assert.ok(handler, `${name} handler must be registered`);
	return await handler(event as never, h.ctx) as T;
}

function event() {
	return {
		messageType: "user",
		prompt: "next",
		systemPrompt: "BASE-SYSTEM-PROMPT",
		systemPromptOptions: { cwd: fakeHome, skills },
	};
}

function normalized(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

async function compare(
	label: string,
	scenario: (module: PaletteModule) => Promise<unknown>,
): Promise<{ baseline: unknown; policy: unknown }> {
	const pair = await loadPair(label);
	const baseline = await scenario(pair.baseline);
	const policy = await scenario(pair.policy);
	assert.deepEqual(normalized(policy), normalized(baseline));
	return { baseline, policy };
}

test("the checked-in palette foundation fixture is importable", async () => {
	const fixtureUrl = pathToFileURL(path.join(repoRoot, "tests", "fixtures", "palette-foundation.ts")).href;
	const module = await import(`${fixtureUrl}?fixture-import-check`);
	assert.equal(typeof module.default, "function");
});

test("the retained baseline and independent policy extension are distinct", async () => {
	const pair = await loadPair("independent-identity");
	const baseline = harness(pair.baseline);
	const policy = harness(pair.policy);
	try {
		assert.deepEqual([...baseline.commands.keys()], ["skill"]);
		assert.deepEqual([...policy.commands.keys()].sort(), ["skill", "skillmgr"]);
	} finally {
		baseline.dispose();
		policy.dispose();
	}
});

test("baseline parity: multi-skill queueing and one-shot injection", async () => {
	const result = await compare("queue", async (module) => {
		const h = harness(module);
		try {
			const input = await invoke<{ action: string; text?: string }>(h, "input", {
				source: "interactive",
				text: "/skill:alpha,beta queued task",
			});
			const injected = await invoke<Injected>(h, "before_agent_start", event());
			return { input, injected, notices: h.notices, statuses: h.statuses, widgets: h.widgets };
		} finally {
			h.dispose();
		}
	});
	const serialized = JSON.stringify(result.policy);
	assert.match(serialized, /ALPHA-BODY-SENTINEL/);
	assert.match(serialized, /BETA-BODY-SENTINEL/);
	assert.match(serialized, /"action":"transform","text":"queued task"/);
});

test("baseline parity: filtered pin selection and pinned system prompt", async () => {
	const result = await compare("pin", async (module) => {
		const h = harness(module);
		try {
			const pending = h.commands.get("skill")!("", h.ctx);
			assert.equal(h.overlays.length, 1);
			for (const key of "pin") h.overlays[0].component.handleInput(key);
			h.overlays[0].component.handleInput("\r");
			await pending;
			const injected = await invoke<Injected>(h, "before_agent_start", event());
			// The policy skips the baseline's redundant unchanged pin repaint; compare the final effective indicators.
			return { injected, notices: h.notices, status: h.statuses.at(-1), widget: h.widgets.at(-1) };
		} finally {
			h.dispose();
		}
	});
	const injected = (result.policy as { injected: Injected }).injected;
	assert.match(injected?.systemPrompt ?? "", /^BASE-SYSTEM-PROMPT\n\nPinned skill instructions:/);
	assert.match(injected?.systemPrompt ?? "", /PIN-BODY-SENTINEL/);
});

test("baseline parity: skill autocomplete and native forwarding", async () => {
	const result = await compare("autocomplete", async (module) => {
		const h = harness(module);
		await invoke(h, "session_start", { type: "session_start", reason: "startup" });
		assert.equal(h.autocompleteFactories.length, 1);
		const base: AutocompleteProvider = {
			triggerCharacters: [],
			getSuggestions: async () => ({
				prefix: "",
				items: [
					{ value: "skill:alpha", label: "skill:alpha" },
					{ value: "unrelated", label: "unrelated" },
				],
			}),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
			shouldTriggerFileCompletion: () => true,
		};
		const provider = h.autocompleteFactories[0](base);
		const skillText = "/skill:alpha,b";
		const custom = await provider.getSuggestions([skillText], 0, skillText.length, { signal: new AbortController().signal });
		const forwarded = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		return { custom, forwarded };
	});
	const custom = (result.policy as { custom: { items: Array<{ value: string }> } }).custom;
	assert.deepEqual(custom.items.map((item) => item.value), ["beta"]);
	assert.match(JSON.stringify((result.policy as { forwarded: unknown }).forwarded), /unrelated/);
});

test("baseline parity: confirmed unqueue removes the pending skill", async () => {
	const result = await compare("confirm", async (module) => {
		const h = harness(module);
		try {
			const first = h.commands.get("skill")!("", h.ctx);
			h.overlays[0].component.handleInput("\r");
			await first;

			const second = h.commands.get("skill")!("", h.ctx);
			assert.equal(h.overlays.length, 2);
			h.overlays[1].component.handleInput("\r");
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(h.overlays.length, 3);
			h.overlays[2].component.handleInput("y");
			await second;

			const injected = await invoke<Injected>(h, "before_agent_start", event());
			// Pi treats the baseline's empty result and the policy's undefined result identically.
			const effectiveInjection = injected?.message === undefined && injected?.systemPrompt === undefined ? undefined : injected;
			return { injected: effectiveInjection, notices: h.notices, statuses: h.statuses, widgets: h.widgets };
		} finally {
			h.dispose();
		}
	});
	assert.match(JSON.stringify((result.policy as { notices: unknown }).notices), /Skill unqueued: alpha/);
	assert.equal((result.policy as { injected: Injected }).injected?.message, undefined);
});
