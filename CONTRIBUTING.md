# Contributing to Pi Skill Policy

Bug reports and focused pull requests are welcome through the [issue tracker](https://github.com/ZeR020/pi-skill-policy/issues).

## Development setup

Requirements:

- Pi and Pi-TUI 1.5.2 for the development baseline; the extension's peer requirement is `>=1.5.0`.
- The Node.js release that runs your Pi installation. The current baseline was verified with Node.js 24.19.0.
- POSIX `/usr/bin/script` for the viewport tests.

```bash
git clone https://github.com/ZeR020/pi-skill-policy.git
cd pi-skill-policy
npm ci
```

The package has no runtime dependencies. `devDependencies` are the Pi host API and the test toolchain only.

## Source map

| Path | Responsibility |
| --- | --- |
| `index.ts` | Extension registration, commands, autocomplete, overlay, and policy saves. |
| `src/storage.ts` | Global and Project policy file reads and atomic writes. |
| `src/policy.ts` | Combined effective policy for Global, Project, and trust. |
| `src/manage-state.ts` | Staged management state, indicators, pack labels, and summaries. |
| `src/identity.ts` | Source-path skill identity and first-discovered-winner lookup. |
| `src/input-gate.ts` | Native invocation parsing, queue limit, and invocation gating. |
| `src/prompt-gate.ts` | Structured prompt filtering and recognized forced-prompt repair. |
| `src/runtime-policy.ts` | Prompt-time policy, queue/pin injection, and one-shot warnings. |
| `src/legacy-migration.ts` | One-time `pi-skill-manager` Global policy import. |
| `src/skill-content.ts` | Skill body loading and prompt composition. |
| `scripts/verify-overlay.mts` | Real keybinding, render, and storage verification in a temporary home. |
| `tests/` | Unit, integration, native byte-parity, viewport, migration, and palette-behavior coverage. |
| `tests/fixtures/palette-foundation.ts` | Checked-in original palette baseline for offline compatibility tests. |
| `plugin.json` | Agent Plugins metadata; the runtime remains Pi-specific. |
| `theme.example.json` | Example color overrides. |

## Checks

Run the three core checks before submitting:

```bash
npm test
npm run typecheck
node --import tsx scripts/verify-overlay.mts
```

For viewport work, run the narrow-terminal test directly:

```bash
node --import tsx --test tests/viewport.test.ts
```

Focused runs use the same command with another test file, for example `node --import tsx --test tests/overlay.test.ts`.

The tests create temporary homes, policy files, and model-free host fixtures. They do not read your personal configuration, call a model, or use the network.

## Making a change

- Start from a focused branch of `main`.
- Add or update regression coverage for any behavior change, and make it fail before the fix.
- Keep a correction small. A bug fix or documentation fix does not need a new abstraction, settings framework, animation system, or runtime dependency.
- Run the checks above and include the behavior change and test evidence in the pull request.
- Open the pull request against `ZeR020/pi-skill-policy`.

## Project contracts

These constraints protect users and existing installations. A change that breaks one needs explicit discussion in an issue first.

- **Public Pi APIs only.** No private or deep imports, prototype patches, or a second skill-discovery engine.
- **Local and quiet at runtime.** No network calls, telemetry, provider registration, model inference, or background service.
- **No runtime dependencies.** A small feature should not add a package.
- **Respect user data.** Never edit `SKILL.md`, `.skill-lock.json`, native Pi settings, or another extension's live state. Policy writes go only to `<agent-dir>/config/pi-skill-palette.json` and `<trusted-cwd>/.pi/config/pi-skill-palette.json`.
- **Preserve compatibility.** Keep `/skill`, `/skillmgr`, native `/skill:<name>` and multi-skill forms, both `pi-skill-palette.json` paths, the migration marker, and the legacy theme directory working.
- **Keep identity exact.** Skill identity is the verbatim `sourceInfo.path`; do not lowercase it or collapse it through realpath.
- **One policy owner.** Do not add a second extension that filters the same skill prompt and input events.
- **Trust is load-bearing.** Project policy stays unread and unwritable while the project is untrusted.

## Reporting a bug

Include the Pi and extension versions, the reproduction steps, and what you expected instead. If the report involves saved policy, include the relevant policy file contents with any private paths you do not want to share removed. For a prompt-filtering problem, say which other extensions are registered.
