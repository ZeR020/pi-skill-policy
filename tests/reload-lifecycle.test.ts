import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import "./helpers/fake-home.js";
import { skillEntry } from "./helpers/fixtures.js";

// index.ts reads the palette theme at module scope, so it loads after the isolated home exists.
const { state } = await import("../index.js");

const alpha = skillEntry("alpha");
const beta = skillEntry("beta");

function fakeApi(): { api: ExtensionAPI; commands: Map<string, unknown>; events: Map<string, unknown> } {
	const commands = new Map<string, unknown>();
	const events = new Map<string, unknown>();
	const api = {
		registerMessageRenderer: () => {},
		registerCommand: (name: string, options: unknown) => commands.set(name, options),
		on: (name: string, handler: unknown) => events.set(name, handler),
		getCommands: () => [],
	} as unknown as ExtensionAPI;
	return { api, commands, events };
}

test("a reload-like module reconstruction starts with empty queued and pinned state", async () => {
	state.queuedSkills = [alpha];
	state.pinnedSkills = [beta];
	assert.deepEqual(state.queuedSkills, [alpha]);
	assert.deepEqual(state.pinnedSkills, [beta]);

	// Pi re-evaluates the extension module on /reload; a cache-busted import is that same fresh
	// graph evaluation, with no live reload, model call, or host session.
	const reloaded = await import(`../index.js?reload=${Date.now()}`);
	assert.notEqual(reloaded.state, state, "the reload builds a separate module instance");
	assert.deepEqual(state.queuedSkills, [alpha]);
	assert.deepEqual(state.pinnedSkills, [beta]);
	assert.deepEqual(reloaded.state.queuedSkills, []);
	assert.deepEqual(reloaded.state.pinnedSkills, []);

	// The reconstructed factory registers the same surface and keeps the fresh state empty.
	const { api, commands, events } = fakeApi();
	reloaded.default(api);
	assert.deepEqual([...commands.keys()].sort(), ["skill", "skillmgr"]);
	assert.deepEqual([...events.keys()].sort(), ["before_agent_start", "input", "session_start"]);
	assert.deepEqual(reloaded.state.queuedSkills, []);
	assert.deepEqual(reloaded.state.pinnedSkills, []);
});
