import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

test("host Pi formatter accepts an empty skill catalog", () => {
	assert.equal(formatSkillsForPrompt([]), "");
});
