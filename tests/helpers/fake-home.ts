import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/**
 * index.ts reads <home>/.pi/agent/extensions/pi-skill-palette/theme.json at module scope, so an
 * isolated home must exist before index is evaluated: import this helper first, then dynamically
 * `await import("../index.js")`. Static index imports evaluate before any test setup runs.
 */
const originalHome = process.env.HOME;
export const fakeHome = fs.mkdtempSync(join(os.tmpdir(), "pi-skill-policy-home-"));
process.env.HOME = fakeHome;

after(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	fs.rmSync(fakeHome, { recursive: true, force: true });
});

/** Write a palette theme file into the isolated home and return its border color code. */
export function writeFakeHomeTheme(theme: Record<string, string>): string {
	const themePath = join(fakeHome, ".pi", "agent", "extensions", "pi-skill-palette", "theme.json");
	fs.mkdirSync(join(fakeHome, ".pi", "agent", "extensions", "pi-skill-palette"), { recursive: true });
	fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`, "utf8");
	return theme.border ?? "";
}
