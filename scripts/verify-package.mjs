import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootUrl = new URL("../", import.meta.url);
const root = fileURLToPath(rootUrl);
const readJson = (name) => {
	try {
		return JSON.parse(readFileSync(new URL(name, rootUrl), "utf8"));
	} catch (cause) {
		throw new Error(`Could not read valid JSON metadata from ${name}`, { cause });
	}
};
const manifest = readJson("package.json");
const lock = readJson("package-lock.json");
const plugin = readJson("plugin.json");
const expectedVersion = process.argv[2] ?? manifest.version;

assert.equal(manifest.name, "pi-skill-policy");
assert.equal(manifest.version, expectedVersion, "Package version does not match requested release");
assert.equal(lock.version, expectedVersion, "Lockfile version does not match package version");
assert.equal(lock.packages[""].version, expectedVersion, "Lockfile root version does not match package version");
assert.equal(plugin.version, expectedVersion, "Plugin version does not match package version");
assert.equal(manifest.main, "index.ts");
assert.equal(manifest.license, "MIT");
assert.equal(manifest.repository.url, "git+https://github.com/ZeR020/pi-skill-policy.git");
assert.ok(manifest.keywords.includes("pi-package"));
assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);

let results;
try {
	const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	results = JSON.parse(raw);
} catch (cause) {
	throw new Error("Could not produce or parse npm's dry-run package output", { cause });
}
assert.ok(Array.isArray(results), "npm dry-run output must be an array");
assert.equal(results.length, 1, "Expected exactly one npm package preview");
const result = results[0];
assert.equal(result.name, manifest.name);
assert.equal(result.version, manifest.version);

const files = result.files.map(({ path }) => path).sort();
const required = [
	"CHANGELOG.md",
	"LICENSE",
	"README.md",
	"index.ts",
	"package.json",
	"plugin.json",
	"theme.example.json",
].sort();
const isAllowed = (path) => required.includes(path) || (path.startsWith("src/") && path.endsWith(".ts"));
const missing = required.filter((path) => !files.includes(path));
const unexpected = files.filter((path) => !isAllowed(path));
assert.deepEqual(missing, [], "Required native Pi files are missing from npm package");
assert.deepEqual(unexpected, [], "Unexpected files would enter the npm package");
assert.ok(files.includes("src/runtime-policy.ts"), "Policy runtime must be included");
assert.ok(files.includes("src/skill-content.ts"), "Skill content handling must be included");

console.log(JSON.stringify({
	name: result.name,
	version: result.version,
	filename: result.filename,
	totalFiles: files.length,
	files,
}, null, 2));
