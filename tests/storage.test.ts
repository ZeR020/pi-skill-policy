import assert from "node:assert/strict";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { mock, test } from "node:test";

import {
	globalConfigPath,
	loadGlobalConfig,
	loadProjectConfig,
	projectConfigPath,
	saveGlobalConfig,
	saveProjectConfig,
	type ProjectConfig,
} from "../src/storage.js";
import { makeTempDir } from "./helpers/fixtures.js";

const globalDefaults = { version: 1, disabled: {} };
const projectDefaults = { version: 1, overrides: {} };

function writeConfigFile(path: string, body: unknown): void {
	fs.mkdirSync(dirname(path), { recursive: true });
	fs.writeFileSync(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function readConfigFile(path: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
}

function assertInvalidAt(loaded: { state: unknown; existed: boolean; valid: boolean; issues: string[] }, path: string, defaults: unknown): void {
	assert.equal(loaded.valid, false);
	assert.equal(loaded.existed, true);
	assert.deepEqual(loaded.state, defaults);
	assert.ok(loaded.issues.length > 0, "invalid config must report an issue");
	assert.ok(loaded.issues.some((issue) => issue.includes(path)), `issues must name ${path}: ${loaded.issues.join("; ")}`);
}

test("loadGlobalConfig returns defaults when the config file is absent", (t) => {
	const agentDir = makeTempDir(t);
	assert.deepEqual(loadGlobalConfig(agentDir), { state: globalDefaults, existed: false, valid: true, issues: [] });
});

test("loadGlobalConfig fails open on malformed JSON", (t) => {
	const agentDir = makeTempDir(t);
	const path = globalConfigPath(agentDir);
	writeConfigFile(path, "{ not json");
	assertInvalidAt(loadGlobalConfig(agentDir), path, globalDefaults);
});

for (const invalid of [
	{ label: "an array", body: [] },
	{ label: "a string", body: '"global"' },
	{ label: "null", body: "null" },
	{ label: "an unknown version", body: { version: 2, disabled: {} } },
	{ label: "a disabled value that is not true", body: { version: 1, disabled: { "/x/SKILL.md": false } } },
	{ label: "a disabled record that is an array", body: { version: 1, disabled: [] } },
	{ label: "a non-boolean master switch", body: { version: 1, off: "yes" } },
	{ label: "a non-boolean path display preference", body: { version: 1, show_paths: "yes" } },
	{ label: "an unknown migration source", body: { version: 1, migration: { from: "other", version: 1 } } },
]) {
	test(`loadGlobalConfig fails open on ${invalid.label}`, (t) => {
		const agentDir = makeTempDir(t);
		const path = globalConfigPath(agentDir);
		writeConfigFile(path, invalid.body);
		assertInvalidAt(loadGlobalConfig(agentDir), path, globalDefaults);
	});
}

test("loadGlobalConfig reads known fields and keeps unrelated fields", (t) => {
	const agentDir = makeTempDir(t);
	const path = globalConfigPath(agentDir);
	writeConfigFile(path, {
		version: 1,
		disabled: { "/one/SKILL.md": true },
		off: true,
		migration: { from: "pi-skill-manager", version: 1 },
		theme: { accent: "cyan" },
	});
	assert.deepEqual(loadGlobalConfig(agentDir), {
		state: {
			version: 1,
			disabled: { "/one/SKILL.md": true },
			off: true,
			migration: { from: "pi-skill-manager", version: 1 },
			theme: { accent: "cyan" },
		},
		existed: true,
		valid: true,
		issues: [],
	});
	writeConfigFile(path, { version: 1 });
	assert.deepEqual(loadGlobalConfig(agentDir), { state: globalDefaults, existed: true, valid: true, issues: [] });
});

test("saveGlobalConfig renames a fresh 0600 temp from the config directory", (t) => {
	const agentDir = makeTempDir(t);
	const path = globalConfigPath(agentDir);
	const rename = fs.renameSync;
	const observed: Array<{ from: string; to: string; mode: number; body: unknown }> = [];
	const spy = mock.method(fs, "renameSync", (from: string, to: string) => {
		observed.push({ from, to, mode: fs.statSync(from).mode & 0o777, body: JSON.parse(fs.readFileSync(from, "utf8")) });
		rename(from, to);
	});
	t.after(() => spy.mock.restore());

	saveGlobalConfig(agentDir, { version: 1, disabled: { "/a/SKILL.md": true } });
	saveGlobalConfig(agentDir, { version: 1, disabled: {} });

	assert.equal(observed.length, 2);
	for (const write of observed) {
		assert.equal(write.to, path);
		assert.equal(dirname(write.from), dirname(path));
		assert.match(basename(write.from), /^\.pi-skill-palette\.json\..+\.tmp$/);
		assert.equal(write.mode, 0o600);
	}
	assert.notEqual(observed[0].from, observed[1].from, "each save must use a fresh temp name");
	assert.deepEqual(observed[0].body, { version: 1, disabled: { "/a/SKILL.md": true } });
	assert.deepEqual(observed[1].body, globalDefaults);
	assert.equal(fs.statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(dirname(path)), ["pi-skill-palette.json"]);
});

test("saveGlobalConfig keeps unrelated fields and omits the false master switch", (t) => {
	const agentDir = makeTempDir(t);
	const path = globalConfigPath(agentDir);
	writeConfigFile(path, { version: 1, disabled: { "/one/SKILL.md": true }, off: true, theme: "cyan" });
	const loaded = loadGlobalConfig(agentDir);

	saveGlobalConfig(agentDir, { ...loaded.state, off: false, disabled: {} });
	const saved = readConfigFile(path);
	assert.equal("off" in saved, false);
	assert.equal(saved.theme, "cyan");
	assert.deepEqual(saved.disabled, {});
	assert.equal(saved.version, 1);

	saveGlobalConfig(agentDir, { ...loaded.state, off: true });
	assert.equal(readConfigFile(path).off, true);
});

test("show_paths booleans survive policy saves and preserve the other Global fields", (t) => {
	const agentDir = makeTempDir(t);
	const path = globalConfigPath(agentDir);
	writeConfigFile(path, {
		version: 1,
		disabled: { "/old/SKILL.md": true },
		show_paths: false,
		migration: { from: "pi-skill-manager", version: 1 },
		theme: { accent: "cyan" },
	});

	const loaded = loadGlobalConfig(agentDir);
	assert.equal(loaded.valid, true);
	assert.equal(loaded.state.show_paths, false);
	saveGlobalConfig(agentDir, { version: 1, disabled: { "/new/SKILL.md": true } });
	assert.deepEqual(readConfigFile(path), {
		version: 1,
		disabled: { "/new/SKILL.md": true },
		show_paths: false,
		migration: { from: "pi-skill-manager", version: 1 },
		theme: { accent: "cyan" },
	});

	saveGlobalConfig(agentDir, { ...loadGlobalConfig(agentDir).state, show_paths: true });
	assert.equal(readConfigFile(path).show_paths, true);
	assert.deepEqual(readConfigFile(path).disabled, { "/new/SKILL.md": true });
});

test("saveGlobalConfig keeps unrelated on-disk fields when saving fresh known state", (t) => {
	const agentDir = makeTempDir(t);
	const path = globalConfigPath(agentDir);
	writeConfigFile(path, {
		version: 1,
		disabled: { "/old/SKILL.md": true },
		migration: { from: "pi-skill-manager", version: 1 },
		theme: { accent: "cyan" },
	});

	saveGlobalConfig(agentDir, { version: 1, disabled: { "/new/SKILL.md": true } });

	const saved = readConfigFile(path);
	assert.deepEqual(saved.disabled, { "/new/SKILL.md": true });
	assert.deepEqual(saved.theme, { accent: "cyan" });
	assert.deepEqual(saved.migration, { from: "pi-skill-manager", version: 1 });
	assert.equal(saved.version, 1);
});

test("saveGlobalConfig does not resurrect a stale on-disk master switch", (t) => {
	const agentDir = makeTempDir(t);
	const path = globalConfigPath(agentDir);
	writeConfigFile(path, { version: 1, disabled: {}, off: true, theme: "cyan" });

	saveGlobalConfig(agentDir, { version: 1, disabled: {} });

	const saved = readConfigFile(path);
	assert.equal("off" in saved, false);
	assert.equal(saved.theme, "cyan");
});

test("saveGlobalConfig refuses to replace an invalid file", (t) => {
	const agentDir = makeTempDir(t);
	const path = globalConfigPath(agentDir);
	writeConfigFile(path, "{ not json");
	assert.throws(
		() => saveGlobalConfig(agentDir, { version: 1, disabled: {} }),
		(error: unknown) => error instanceof Error && error.message.includes(path) && /invalid/i.test(error.message),
	);
	assert.equal(fs.readFileSync(path, "utf8"), "{ not json");
	assert.deepEqual(fs.readdirSync(dirname(path)), ["pi-skill-palette.json"]);
});

test("saveGlobalConfig cleans up its temp file when the rename fails", (t) => {
	const agentDir = makeTempDir(t);
	const spy = mock.method(fs, "renameSync", () => {
		throw new Error("rename failed");
	});
	t.after(() => spy.mock.restore());

	assert.throws(() => saveGlobalConfig(agentDir, { version: 1, disabled: {} }), /rename failed/);
	assert.deepEqual(fs.readdirSync(join(agentDir, "config")), []);
	assert.equal(fs.existsSync(globalConfigPath(agentDir)), false);
});

test("saveGlobalConfig never unlinks a temp it did not create", (t) => {
	const agentDir = makeTempDir(t);
	let tempPath = "";
	const openSpy = mock.method(fs, "openSync", (target: string) => {
		tempPath = target;
		fs.writeFileSync(target, "sentinel", "utf8");
		throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
	});
	t.after(() => openSpy.mock.restore());

	assert.throws(() => saveGlobalConfig(agentDir, { version: 1, disabled: {} }), /EACCES/);
	assert.notEqual(tempPath, "");
	assert.equal(fs.readFileSync(tempPath, "utf8"), "sentinel");
	assert.equal(fs.existsSync(globalConfigPath(agentDir)), false);
});

test("saveGlobalConfig fsyncs the temp before renaming it", (t) => {
	const agentDir = makeTempDir(t);
	const events: string[] = [];
	const fsync = fs.fsyncSync;
	const rename = fs.renameSync;
	const fsyncSpy = mock.method(fs, "fsyncSync", (fd: number) => {
		events.push("fsync");
		return fsync(fd);
	});
	t.after(() => fsyncSpy.mock.restore());
	const renameSpy = mock.method(fs, "renameSync", (from: string, to: string) => {
		events.push("rename");
		return rename(from, to);
	});
	t.after(() => renameSpy.mock.restore());

	saveGlobalConfig(agentDir, { version: 1, disabled: {} });

	assert.deepEqual(events, ["fsync", "rename"]);
});

for (const failure of [
	{ label: "the write", method: "writeFileSync" as const, message: /write failed/ },
	{ label: "fsync", method: "fsyncSync" as const, message: /fsync failed/ },
]) {
	test(`saveGlobalConfig cleans up and preserves a valid file when ${failure.label} fails`, (t) => {
		const agentDir = makeTempDir(t);
		const path = globalConfigPath(agentDir);
		writeConfigFile(path, { version: 1, disabled: { "/keep/SKILL.md": true }, theme: "cyan" });
		const before = fs.readFileSync(path);
		const spy = mock.method(fs, failure.method, () => {
			throw new Error(failure.label === "fsync" ? "fsync failed" : "write failed");
		});
		t.after(() => spy.mock.restore());

		assert.throws(() => saveGlobalConfig(agentDir, { version: 1, disabled: {} }), failure.message);
		assert.ok(fs.readFileSync(path).equals(before), "an existing valid target must stay byte-identical");
		assert.deepEqual(fs.readdirSync(dirname(path)), ["pi-skill-palette.json"]);
	});
}

test("saving global config never touches project config", (t) => {
	const cwd = join(makeTempDir(t), "workspace");
	saveGlobalConfig(makeTempDir(t), { version: 1, disabled: {} });
	assert.equal(fs.existsSync(join(cwd, ".pi")), false);
});

test("loadProjectConfig returns defaults when the project config is absent", (t) => {
	const cwd = makeTempDir(t);
	assert.deepEqual(loadProjectConfig(cwd, true), { state: projectDefaults, existed: false, valid: true, issues: [] });
});

test("loadProjectConfig fails open only for the project file", (t) => {
	const agentDir = makeTempDir(t);
	const cwd = makeTempDir(t);
	writeConfigFile(globalConfigPath(agentDir), { version: 1, disabled: { "/global/SKILL.md": true } });
	writeConfigFile(projectConfigPath(cwd), "{ broken");

	assertInvalidAt(loadProjectConfig(cwd, true), projectConfigPath(cwd), projectDefaults);
	assert.deepEqual(loadGlobalConfig(agentDir), {
		state: { version: 1, disabled: { "/global/SKILL.md": true } },
		existed: true,
		valid: true,
		issues: [],
	});
});

for (const invalid of [
	{ label: "an array", body: [] },
	{ label: "an unknown version", body: { version: 2, overrides: {} } },
	{ label: "an overrides record that is an array", body: { version: 1, overrides: [] } },
	{ label: "an override value outside on/off", body: { version: 1, overrides: { "/a/SKILL.md": "maybe" } } },
]) {
	test(`loadProjectConfig fails open on ${invalid.label}`, (t) => {
		const cwd = makeTempDir(t);
		const path = projectConfigPath(cwd);
		writeConfigFile(path, invalid.body);
		assertInvalidAt(loadProjectConfig(cwd, true), path, projectDefaults);
	});
}

test("loadProjectConfig reads known fields and keeps unrelated fields", (t) => {
	const cwd = makeTempDir(t);
	writeConfigFile(projectConfigPath(cwd), {
		version: 1,
		overrides: { "/a/SKILL.md": "on", "/b/SKILL.md": "off" },
		note: "keep",
	});
	assert.deepEqual(loadProjectConfig(cwd, true), {
		state: { version: 1, overrides: { "/a/SKILL.md": "on", "/b/SKILL.md": "off" }, note: "keep" },
		existed: true,
		valid: true,
		issues: [],
	});
});

test("loadProjectConfig reads nothing while the project is untrusted", (t) => {
	const cwd = join(makeTempDir(t), "missing-workspace");
	const spy = mock.method(fs, "readFileSync");
	t.after(() => spy.mock.restore());

	assert.deepEqual(loadProjectConfig(cwd, false), { state: projectDefaults, existed: false, valid: true, issues: [] });
	assert.equal(spy.mock.callCount(), 0);

	// Control: a real read of this path fails loudly, so the clean result above proves the untrusted path never reads.
	fs.mkdirSync(projectConfigPath(cwd), { recursive: true });
	assert.deepEqual(loadProjectConfig(cwd, false), { state: projectDefaults, existed: false, valid: true, issues: [] });
	assert.equal(spy.mock.callCount(), 0);
	assertInvalidAt(loadProjectConfig(cwd, true), projectConfigPath(cwd), projectDefaults);
	assert.equal(spy.mock.callCount(), 1);
});

test("saveProjectConfig throws while the project is untrusted and writes nothing", (t) => {
	const cwd = makeTempDir(t);
	assert.throws(
		() => saveProjectConfig(cwd, false, { version: 1, overrides: {} }),
		(error: unknown) => error instanceof Error && /trusted/.test(error.message) && error.message.includes(projectConfigPath(cwd)),
	);
	assert.equal(fs.existsSync(join(cwd, ".pi")), false);
});

test("saveProjectConfig refuses to replace an invalid project file", (t) => {
	const cwd = makeTempDir(t);
	const path = projectConfigPath(cwd);
	writeConfigFile(path, "{ not json");
	assert.throws(
		() => saveProjectConfig(cwd, true, { version: 1, overrides: {} }),
		(error: unknown) => error instanceof Error && error.message.includes(path) && /invalid/i.test(error.message),
	);
	assert.equal(fs.readFileSync(path, "utf8"), "{ not json");
	assert.deepEqual(fs.readdirSync(dirname(path)), ["pi-skill-palette.json"]);
});

test("saveProjectConfig keeps unrelated fields and omits Inherit overrides", (t) => {
	const cwd = makeTempDir(t);
	const path = projectConfigPath(cwd);
	// UI staged state may carry Inherit; the save must omit it instead of writing a third state.
	const staged = {
		version: 1,
		overrides: { "/a/SKILL.md": "on", "/b/SKILL.md": "off", "/c/SKILL.md": "inherit" },
		note: "keep",
	} as unknown as ProjectConfig;

	saveProjectConfig(cwd, true, staged);

	const saved = readConfigFile(path);
	assert.deepEqual(saved.overrides, { "/a/SKILL.md": "on", "/b/SKILL.md": "off" });
	assert.equal(saved.note, "keep");
	assert.equal(saved.version, 1);
	assert.equal(fs.statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(dirname(path)), ["pi-skill-palette.json"]);
});

test("saveProjectConfig keeps unrelated on-disk fields when saving fresh known state", (t) => {
	const cwd = makeTempDir(t);
	const path = projectConfigPath(cwd);
	writeConfigFile(path, { version: 1, overrides: { "/old/SKILL.md": "off" }, note: "keep" });

	saveProjectConfig(cwd, true, { version: 1, overrides: { "/new/SKILL.md": "on" } });

	const saved = readConfigFile(path);
	assert.deepEqual(saved.overrides, { "/new/SKILL.md": "on" });
	assert.equal(saved.note, "keep");
	assert.equal(saved.version, 1);
});
