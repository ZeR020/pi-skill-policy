import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Skill as HostSkill,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { PaletteSkill } from "../../src/skill-content.js";

// The isolated home must exist before index.ts evaluates its module-scope theme read.
import { fakeHome } from "./fake-home.js";
export { fakeHome };
const { default: skillPaletteExtension } = await import("../../index.js");

function hostSkill(name: string, description: string): PaletteSkill {
	const filePath = join(fakeHome, ".agents", "skills", "suite", name, "SKILL.md");
	return {
		name,
		description,
		filePath,
		baseDir: dirname(filePath),
		sourceInfo: { path: filePath, source: "test", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
		pinByDefault: false,
		searchName: name.toLowerCase(),
		searchDescription: description.toLowerCase(),
		sortIndex: 0,
	};
}

export const alpha = hostSkill("alpha", "Alpha helper");
export const beta = hostSkill("beta", "Beta helper");
export const gamma = hostSkill("gamma", "Gamma helper");

export function slashCommands(skills: HostSkill[] = [alpha, beta]): SlashCommandInfo[] {
	return skills.map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill",
		sourceInfo: skill.sourceInfo,
	}));
}

export function setAgentDir(t: TestContext): string {
	const agentDir = fs.mkdtempSync(join(os.tmpdir(), "pi-skill-policy-policy-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
	return agentDir;
}

export function writeConfigFile(path: string, body: unknown): void {
	fs.mkdirSync(dirname(path), { recursive: true });
	fs.writeFileSync(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export function readConfigFile(path: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
}

export interface PolicyHost {
	commands: Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>;
	commandDescriptions: Map<string, string | undefined>;
	handlers: Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>;
	messageRenderers: number;
	/** Simulates the post-session_start resource-discovery phase in tests. */
	setSkills(skills: HostSkill[]): void;
}

/** Run the policy factory exactly once against a fake ExtensionAPI; never touches a live Pi. */
export function loadPolicy(skills: HostSkill[] = [alpha, beta], additionalCommands: SlashCommandInfo[] = []): PolicyHost {
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const commandDescriptions = new Map<string, string | undefined>();
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	let messageRenderers = 0;
	let currentSkills = skills;

	const api = {
		registerMessageRenderer: () => {
			messageRenderers += 1;
		},
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands.set(name, options.handler);
			commandDescriptions.set(name, options.description);
		},
		on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getCommands: () => [...slashCommands(currentSkills), ...additionalCommands],
	} as unknown as ExtensionAPI;

	skillPaletteExtension(api);
	const setSkills = (next: HostSkill[]) => {
		currentSkills = next;
	};
	return { commands, commandDescriptions, handlers, messageRenderers, setSkills };
}

export interface CapturedNotification {
	message: string;
	type: string | undefined;
}

export interface CapturedOverlay {
	options: unknown;
	component: unknown;
	done: (value: unknown) => void;
}

export interface HostHarness {
	ctx: ExtensionCommandContext;
	notifications: CapturedNotification[];
	statuses: Array<string | undefined>;
	overlays: CapturedOverlay[];
	reloads(): number;
	autocompleteProviders(): number;
	autocompleteFactories: Array<(current: unknown) => unknown>;
}

export interface HostHarnessOptions {
	cwd: string;
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	trusted?: boolean | (() => boolean);
	skills?: HostSkill[];
}

/** Minimal public-API host context shared by session_start and command handlers. */
export function makeHostHarness(options: HostHarnessOptions): HostHarness {
	const notifications: CapturedNotification[] = [];
	const statuses: Array<string | undefined> = [];
	const overlays: CapturedOverlay[] = [];
	let reloads = 0;
	let autocompleteProviders = 0;
	const autocompleteFactories: Array<(current: unknown) => unknown> = [];
	const trusted = options.trusted ?? true;

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? (options.mode ?? "tui") === "tui",
		cwd: options.cwd,
		isProjectTrusted: () => (typeof trusted === "function" ? trusted() : trusted),
		getSystemPromptOptions: () => ({ cwd: options.cwd, skills: options.skills ?? [alpha, beta] }),
		reload: async () => {
			reloads += 1;
		},
		ui: {
			custom: (
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown,
				overlayOptions: unknown,
			) =>
				new Promise((resolve) => {
					const overlay: CapturedOverlay = { options: overlayOptions, component: undefined, done: resolve };
					overlays.push(overlay);
					overlay.component = factory({}, {}, {}, resolve);
				}),
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			setStatus: (_key: string, value: string | undefined) => {
				statuses.push(value);
			},
			setWidget: () => {},
			addAutocompleteProvider: (factory: (current: unknown) => unknown) => {
				autocompleteProviders += 1;
				autocompleteFactories.push(factory);
			},
		},
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		notifications,
		statuses,
		overlays,
		reloads: () => reloads,
		autocompleteProviders: () => autocompleteProviders,
		autocompleteFactories,
	};
}
