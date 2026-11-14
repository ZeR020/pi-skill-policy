import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";

import { importLegacySkillManagerOnce, legacySkillManagerPath } from "../src/legacy-migration.js";
import { globalConfigPath, loadGlobalConfig } from "../src/storage.js";
import { makeTempDir } from "./helpers/fixtures.js";

const tddPath = "/agents/skills/tdd/SKILL.md";
const reviewPath = "/agents/skills/review/SKILL.md";
const dupAPath = "/agents/skills/a/dup/SKILL.md";
const dupBPath = "/agents/skills/b/dup/SKILL.md";
const catalog = [
	{ name: "tdd", filePath: tddPath, pack: "matt" },
	{ name: "review", filePath: reviewPath, pack: "vercel" },
	{ name: "dup", filePath: dupAPath, pack: "a" },
	{ name: "dup", filePath: dupBPath, pack: "b" },
];
const marker = { from: "pi-skill-manager", version: 1 };

function writeLegacy(agentDir: string, body: unknown): string {
	const path = legacySkillManagerPath(agentDir);
	fs.mkdirSync(join(agentDir, "config"), { recursive: true });
	fs.writeFileSync(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`, "utf8");
	return path;
}

function writeTarget(agentDir: string, body: unknown): string {
	const path = globalConfigPath(agentDir);
	fs.mkdirSync(join(agentDir, "config"), { recursive: true });
	fs.writeFileSync(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`, "utf8");
	return path;
}

function importedState(agentDir: string): Record<string, unknown> {
	const loaded = loadGlobalConfig(agentDir);
	assert.equal(loaded.valid, true);
	assert.equal(loaded.existed, true);
	return loaded.state as unknown as Record<string, unknown>;
}

test("imports absolute disabled paths and master-off with the marker in one create", (t) => {
	const agentDir = makeTempDir(t);
	const unmatched = "/elsewhere/only-legacy/SKILL.md";
	const legacyPath = writeLegacy(agentDir, { disabled: { [unmatched]: true, [tddPath]: true }, off: true });
	const before = fs.readFileSync(legacyPath);
	const events: string[] = [];
	const fsync = fs.fsyncSync;
	const link = fs.linkSync;
	const fsyncSpy = mock.method(fs, "fsyncSync", (fd: number) => {
		events.push("fsync");
		return fsync(fd);
	});
	t.after(() => fsyncSpy.mock.restore());
	const linkSpy = mock.method(fs, "linkSync", (from: string, to: string) => {
		events.push("link");
		return link(from, to);
	});
	t.after(() => linkSpy.mock.restore());
	const renameSpy = mock.method(fs, "renameSync", () => {
		throw new Error("import must create, not replace");
	});
	t.after(() => renameSpy.mock.restore());

	assert.deepEqual(importLegacySkillManagerOnce({ agentDir, catalog }), { imported: true, issues: [] });

	assert.deepEqual(events, ["fsync", "link"], "one atomic create commits the fsynced state and marker");
	assert.equal(linkSpy.mock.callCount(), 1);
	assert.equal(renameSpy.mock.callCount(), 0);
	assert.deepEqual(importedState(agentDir), {
		version: 1,
		disabled: { [unmatched]: true, [tddPath]: true },
		off: true,
		migration: marker,
	});
	assert.deepEqual(fs.readFileSync(legacyPath), before);
});

test("resolves an unambiguous legacy pack/name key", (t) => {
	const agentDir = makeTempDir(t);
	writeLegacy(agentDir, { disabled: { "matt/tdd": true } });

	assert.deepEqual(importLegacySkillManagerOnce({ agentDir, catalog }), { imported: true, issues: [] });
	assert.deepEqual(importedState(agentDir), { version: 1, disabled: { [tddPath]: true }, migration: marker });
});

test("resolves a unique bare name when the legacy pack label changed", (t) => {
	const agentDir = makeTempDir(t);
	writeLegacy(agentDir, { disabled: { "old-vendor/review": true } });

	assert.deepEqual(importLegacySkillManagerOnce({ agentDir, catalog }), { imported: true, issues: [] });
	assert.deepEqual(importedState(agentDir), { version: 1, disabled: { [reviewPath]: true }, migration: marker });
});

test("reports ambiguous and unresolved legacy keys without importing them", (t) => {
	const agentDir = makeTempDir(t);
	writeLegacy(agentDir, { disabled: { "someone/dup": true, "ghost/missing": true } });

	const result = importLegacySkillManagerOnce({ agentDir, catalog });

	assert.equal(result.imported, true);
	assert.equal(result.issues.length, 2);
	assert.ok(result.issues.some((issue) => issue.includes('"someone/dup"') && /ambiguous/.test(issue)));
	assert.ok(result.issues.some((issue) => issue.includes('"ghost/missing"') && /no installed skill/.test(issue)));
	assert.deepEqual(importedState(agentDir), { version: 1, disabled: {}, migration: marker });
});

test("reports reserved nonempty projects data without importing it", (t) => {
	const agentDir = makeTempDir(t);
	writeLegacy(agentDir, { disabled: {}, projects: { repo: { skill: true } } });

	const result = importLegacySkillManagerOnce({ agentDir, catalog });

	assert.equal(result.imported, true);
	assert.equal(result.issues.length, 1);
	assert.match(result.issues[0], /projects/);
	assert.deepEqual(importedState(agentDir), { version: 1, disabled: {}, migration: marker });
});

test("never re-imports over an existing valid target, even without a marker", (t) => {
	const agentDir = makeTempDir(t);
	const targetPath = writeTarget(agentDir, { version: 1, disabled: { "/kept/SKILL.md": true } });
	const targetBefore = fs.readFileSync(targetPath);
	writeLegacy(agentDir, { disabled: { "matt/tdd": true } });

	assert.deepEqual(importLegacySkillManagerOnce({ agentDir, catalog }), { imported: false, issues: [] });
	assert.deepEqual(fs.readFileSync(targetPath), targetBefore);
	assert.deepEqual(importedState(agentDir), { version: 1, disabled: { "/kept/SKILL.md": true } });
});

test("never overwrites an invalid existing target", (t) => {
	const agentDir = makeTempDir(t);
	const targetPath = writeTarget(agentDir, "{ not json");
	const targetBefore = fs.readFileSync(targetPath);
	writeLegacy(agentDir, { disabled: { "matt/tdd": true } });

	const result = importLegacySkillManagerOnce({ agentDir, catalog });

	assert.equal(result.imported, false);
	assert.ok(result.issues.some((issue) => issue.includes(targetPath)));
	assert.deepEqual(fs.readFileSync(targetPath), targetBefore);
});

test("does nothing when there is no legacy file", (t) => {
	const agentDir = makeTempDir(t);
	assert.deepEqual(importLegacySkillManagerOnce({ agentDir, catalog }), { imported: false, issues: [] });
	assert.equal(fs.existsSync(globalConfigPath(agentDir)), false);
});

for (const invalid of [
	{ label: "malformed legacy JSON", body: "{ not json" },
	{ label: "a non-object legacy file", body: [] },
	{ label: "a non-object legacy disabled record", body: { disabled: [] } },
]) {
	test(`fails closed on ${invalid.label}`, (t) => {
		const agentDir = makeTempDir(t);
		const legacyPath = writeLegacy(agentDir, invalid.body);
		const before = fs.readFileSync(legacyPath);

		const result = importLegacySkillManagerOnce({ agentDir, catalog });

		assert.equal(result.imported, false);
		assert.ok(result.issues.length > 0);
		assert.ok(result.issues.some((issue) => issue.includes(legacyPath)));
		assert.equal(fs.existsSync(globalConfigPath(agentDir)), false);
		assert.deepEqual(fs.readFileSync(legacyPath), before);
	});
}

test("leaves no completion marker when the import create fails", (t) => {
	const agentDir = makeTempDir(t);
	const legacyPath = writeLegacy(agentDir, { disabled: { [tddPath]: true }, off: true });
	const before = fs.readFileSync(legacyPath);
	const spy = mock.method(fs, "linkSync", () => {
		throw new Error("link failed");
	});
	t.after(() => spy.mock.restore());

	const result = importLegacySkillManagerOnce({ agentDir, catalog });

	assert.equal(result.imported, false);
	assert.ok(result.issues.some((issue) => issue.includes(globalConfigPath(agentDir))));
	assert.equal(fs.existsSync(globalConfigPath(agentDir)), false);
	assert.deepEqual(fs.readdirSync(join(agentDir, "config")), ["pi-skill-manager.json"]);
	assert.deepEqual(fs.readFileSync(legacyPath), before);
});

test("refuses to replace a valid target created while the legacy file is being read", (t) => {
	const agentDir = makeTempDir(t);
	const legacyPath = writeLegacy(agentDir, { disabled: { "matt/tdd": true } });
	const targetPath = globalConfigPath(agentDir);
	const racedBody = `${JSON.stringify({ version: 1, disabled: { "/raced/SKILL.md": true }, note: "raced" }, null, 2)}\n`;
	const read = fs.readFileSync;
	const spy = mock.method(fs, "readFileSync", (path: string) => {
		if (path === legacyPath) fs.writeFileSync(targetPath, racedBody, "utf8");
		return read(path, "utf8");
	});
	t.after(() => spy.mock.restore());

	const result = importLegacySkillManagerOnce({ agentDir, catalog });

	assert.equal(result.imported, false, "a target that appeared after the absence check must not be replaced");
	assert.ok(result.issues.some((issue) => issue.includes(targetPath)));
	assert.equal(fs.readFileSync(targetPath, "utf8"), racedBody);
});

test("imports only once across repeated calls", (t) => {
	const agentDir = makeTempDir(t);
	writeLegacy(agentDir, { disabled: { "matt/tdd": true } });

	assert.equal(importLegacySkillManagerOnce({ agentDir, catalog }).imported, true);
	const targetPath = globalConfigPath(agentDir);
	const targetBefore = fs.readFileSync(targetPath);
	assert.deepEqual(importLegacySkillManagerOnce({ agentDir, catalog }), { imported: false, issues: [] });
	assert.deepEqual(fs.readFileSync(targetPath), targetBefore);
});

test("deferUnresolved leaves no target when a relative key cannot resolve yet", (t) => {
	const agentDir = makeTempDir(t);
	writeLegacy(agentDir, { disabled: { "suite/late": true }, off: true });

	const result = importLegacySkillManagerOnce({ agentDir, catalog: [], deferUnresolved: true });

	assert.deepEqual(result, { imported: false, issues: [], deferred: true });
	assert.equal(fs.existsSync(globalConfigPath(agentDir)), false);
	assert.equal(loadGlobalConfig(agentDir).existed, false);
});

test("deferUnresolved treats a still-ambiguous relative key as not ready", (t) => {
	const agentDir = makeTempDir(t);
	writeLegacy(agentDir, { disabled: { dup: true } });

	const result = importLegacySkillManagerOnce({
		agentDir,
		catalog: catalog.filter((skill) => skill.name === "dup"),
		deferUnresolved: true,
	});

	assert.deepEqual(result, { imported: false, issues: [], deferred: true });
	assert.equal(loadGlobalConfig(agentDir).existed, false);
});

test("deferUnresolved imports immediately when every relative key resolves", (t) => {
	const agentDir = makeTempDir(t);
	writeLegacy(agentDir, { disabled: { "matt/tdd": true } });

	const result = importLegacySkillManagerOnce({ agentDir, catalog, deferUnresolved: true });

	assert.deepEqual(result, { imported: true, issues: [] });
	assert.deepEqual(importedState(agentDir), {
		version: 1,
		disabled: { [tddPath]: true },
		migration: marker,
	});
});

test("deferUnresolved imports absolute paths and master-off without waiting for the catalog", (t) => {
	const agentDir = makeTempDir(t);
	const unmatched = "/elsewhere/only-legacy/SKILL.md";
	writeLegacy(agentDir, { disabled: { [unmatched]: true }, off: true });

	const result = importLegacySkillManagerOnce({ agentDir, catalog: [], deferUnresolved: true });

	assert.deepEqual(result, { imported: true, issues: [] });
	assert.deepEqual(importedState(agentDir), {
		version: 1,
		disabled: { [unmatched]: true },
		off: true,
		migration: marker,
	});
});
