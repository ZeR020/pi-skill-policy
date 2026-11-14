# Pi Skill Policy

**Maintained by ZeR020.**

Pi Skill Policy is an extension for the [Pi coding agent](https://github.com/earendil-works/pi). It gives you one place to load skills when you need them, pin skills as standing instructions, and decide which skills are available globally or in a particular project.

All management happens locally through `/skill`. No external service is involved.

## Features

- **Load on demand:** queue up to three different skills for your next message.
- **Pin standing instructions:** keep selected skills active across turns until you unpin them.
- **Global policy:** turn skills On or Off for every Pi session.
- **Project policy:** inherit the global choice or explicitly force a skill On or Off for one trusted project.
- **Master bypass:** temporarily bypass every manager restriction without losing your saved choices.
- **Compatibility:** invoke skills through the palette or Pi's native `/skill:<name>` commands.
- **Local-first behavior:** no runtime dependencies, network calls, telemetry, or provider registration.
- **Migration:** import an existing `pi-skill-manager` Global policy once without modifying the legacy file.

## Requirements

- **Pi 1.5.0 or newer**. The current development and verification baseline is **Pi/Pi-TUI 1.5.2**.
- Only one skill-policy owner should be active. Do not run Pi Skill Policy alongside another extension that filters the same skill prompt and input events, including the legacy `pi-skill-manager` extension.

Keep the legacy manager's configuration file if you want its saved choices imported. Its extension registration is what must be disabled or removed.

## Install

Run this in a terminal:

```bash
pi install git:github.com/ZeR020/pi-skill-policy@main
```

Then, inside Pi:

```text
/reload
/skill
```

To update an existing Git installation, run this in a terminal and then reload Pi:

```bash
pi update --extensions
```

Pi Skill Policy is distributed from this Git repository; it is not currently published to npm.

## Quick start

1. Open **`/skill`**.
2. Start typing part of a skill's name or description to filter the list.
3. Press **Enter** on a skill to queue it, pin it, or remove an existing queue/pin selection.
4. Send a message. Queued skills are included once; pinned skills remain active until removed.
5. Use the **Global**, **Project**, and **Config** tabs to manage visibility and display preferences.

Use **Esc** to close a clean Load view or discard unsaved management edits.

## Command reference

| Command | Purpose |
| --- | --- |
| `/skill` | Open Load, Global, Project, and Config in one overlay. |
| `/skillmgr` | Open the same overlay directly on Global policy. |
| `/skillmgr disable` | Save the Global master bypass and reload once. Existing per-skill choices are preserved. |
| `/skillmgr enable` | Restore enforcement of saved policy and reload once. |
| `/skill:<name>` | Use Pi's native single-skill invocation when that skill is enabled. |
| `/skill:a,b` | Queue multiple enabled skills, up to the three-skill limit. |
| `/skill:a /skill:b` | Repeat the native prefix to queue multiple enabled skills. |

A multi-skill command is rejected as a whole if any selected skill is Off, if the command is ambiguous, or if it would exceed the queue limit. An enabled sibling is never loaded by itself after such a rejection.

If a multi-skill command has no remaining prompt, its selection is queued for the next message instead.

## Load controls

Load retains a fuzzy search over skill names and descriptions.

| Key | Action |
| --- | --- |
| Type | Filter skills. Spaces are literal search characters in Load. |
| Up / Down | Move the selection. |
| Enter | Queue, pin, unqueue, or unpin the selected skill. Removal asks for confirmation. |
| Esc | Cancel and close. |

- The queue holds **three different skills at most**.
- A skill with `pinned: true` frontmatter is pinned by default when selected.
- Native `/skill:` loading is one-shot, including for a skill that declares `pinned: true`.
- Queues and pins are in-memory selections. They reset after `/reload` or a Pi restart.
- Turning a skill Off while it is queued or pinned removes that pending selection. Re-enable the skill and select it again deliberately.

## Global, Project, and Config controls

The management tabs use staged edits: nothing is written when you open a tab or toggle a row.

| Key | Action |
| --- | --- |
| Up / Down | Move between rows. |
| Left / Right | Change tabs. Unsaved edits must be saved or discarded first. |
| Type | Filter rows. Spaces are not allowed in management filters. |
| Space | Stage the selected row's next state. |
| Tab | Stage all visible rows in the selected package/source group. |
| Enter | Save the active tab and close after a successful write. |
| Esc | Discard staged edits and close. |

On a narrow terminal, long paths, notices, errors, and help text wrap so their actionable content remains reachable. The list fits the terminal's available rows instead of hiding the controls below the viewport.

### Global policy

New skills default to **On** unless you explicitly turn them Off.

- **`● On`** — the skill is allowed by Global policy.
- **`○ Off`** — the skill is removed from effective availability.

### Project policy

Project choices apply only while Pi trusts the current project.

- **`[~] Inherit`** — use the Global choice.
- **`● On`** — explicitly enable the skill here, including when Global turns it Off.
- **`○ Off`** — explicitly disable the skill here, including when Global leaves it On.

An untrusted Project tab is locked. Its policy file is neither read nor written.

### Effective state

Rows show the result of the combined policy, not just the current tab's saved choice. Global Off can therefore coexist with Project On, and Project Off can make an otherwise enabled skill unavailable.

Skills are identified by Pi's exact discovered `sourceInfo.path`, not by a lowercased name or a realpath-collapsed identity. If two source files provide the same skill name, Pi's first discovered winner remains authoritative. Turning Off the winner does not promote a shadowed skill.

### Master bypass

The Global **Master switch** controls whether this extension enforces its saved restrictions:

- **`●`** — restrictions are enforced.
- **`○` with “OFF, restrictions bypassed”** — all manager restrictions are bypassed, so saved Global Off and Project Off choices are temporarily ineffective.

The choices themselves are not erased. Enabling the Master switch again restores them. Saving Master OFF also reloads Pi once so every runtime policy owner is refreshed.

This bypass does not alter Pi's native skill-discovery or `disable-model-invocation` behavior.

### Config

**Show skill file paths** is a Global display preference:

- **`●`** — show source paths in the catalog.
- **`○`** — hide catalog path labels.

This changes presentation only. It does not change policy, prompt identity, selection, diagnostic paths, or the Project file.

The effective-policy summary remains visible above the Config controls.

### Package/source groups

Headings make long catalogs easier to scan. Skills from the same package share its package heading, including unscoped npm packages such as `pi-lens`. Global and project Hermes procedural-memory skills share the **`auto-learned`** heading.

These headings are display labels only; they never replace a skill's source identity.

## Prompt and invocation behavior

When a skill is Off, Pi Skill Policy prevents it from being loaded through the palette or unambiguous native invocation and removes it from the model-facing skill options for the next prompt.

Normal prompts retain Pi's native structured prompt composition. If another extension has already forced a complete prompt, Pi Skill Policy repairs the recognized skills block while preserving unrelated content. An unrecognized block produces a warning rather than deleting text speculatively. A later extension can still replace the entire prompt.

A skill marked `disable-model-invocation: true` remains tagged **`(native)`** in management. Turning it On restores manager availability but does not change Pi's native flag: it stays hidden from Pi's model-facing catalog and remains available for deliberate explicit loading or pinning.

Read failures consume the one-shot queue selection and emit a warning instead of silently injecting a partial result.

## Saved state and migration

```text
Global:  <agent-dir>/config/pi-skill-palette.json
Project: <trusted-cwd>/.pi/config/pi-skill-palette.json
```

The filename is intentionally retained so existing policy remains compatible. It does not mean another extension is active.

### Atomic writes

- Saves use a fresh same-directory temporary file, restrictive permissions, `fsync`, and atomic rename.
- A failed write leaves pending choices visible so you can fix the reported path or permission problem.
- Existing invalid files are reported and are not silently replaced.
- Invalid JSON or an invalid policy shape fails open with a visible warning for that file.

### Legacy import

If no Global Pi Skill Policy file exists, the extension can read:

```text
<agent-dir>/config/pi-skill-manager.json
```

The import runs once and records a migration marker. Absolute paths import directly. Relative legacy keys must resolve to exactly one currently discovered pack/name or skill name; ambiguous and unresolved entries are reported instead of guessed.

The legacy configuration is read, never rewritten. One-time import also carries over a legacy master-off setting; use `/skillmgr enable` to restore enforcement while keeping the imported choices.

Project policy is never read or written while the project is untrusted.

## Theme and appearance

Copy `theme.example.json` to customize the palette colors. For compatibility, the theme remains at:

```text
~/.pi/agent/extensions/pi-skill-palette/theme.json
```

Missing or invalid theme data falls back to the built-in defaults. The theme path is read-only from the extension's perspective.

Skill rows, Master, and Config use the same visual language: **`●`** for enabled/active and **`○`** for disabled/bypassed. Project Inherit remains **`[~]`**.

## Headless and RPC use

In print or JSON mode, `/skill` and `/skillmgr` print one effective-policy summary to **stderr**, leaving JSON stdout clean. RPC sessions with a UI receive the same summary through `ui.notify`.

The summary includes enabled counts, prompt-size impact, Global Off state, and Project override/trust state.

## Privacy and safety limits

Pi Skill Policy reads only local host resources needed for its work: discovered skill files, policy files, the optional theme, and the optional shared skill-lock file used for group labels. Its runtime makes no network calls, sends no telemetry, registers no provider, starts no model inference, and creates no background service.

Policy is not an operating-system security boundary:

- Content already present in the conversation is not erased.
- A user or another extension can still deliberately read a skill file.
- An arbitrary later extension can replace the entire system prompt after this extension runs.
- Unsaved staged choices do not change saved policy.
- External edits to policy files are adopted on reload, not through a file watcher.

For a complete policy-owner changeover, reload Pi after changing extension registration.

## Development

```bash
git clone https://github.com/ZeR020/pi-skill-policy.git
cd pi-skill-policy
npm ci
npm test
npm run typecheck
node --import tsx scripts/verify-overlay.mts
```

The tests use temporary homes, policy files, and model-free host fixtures. The viewport tests exercise a real 70×24 PTY on POSIX systems where `/usr/bin/script` is available.

### Source layout

| Path | Responsibility |
| --- | --- |
| `index.ts` | Extension registration, commands, autocomplete, overlay, and policy saves. |
| `src/` | Storage, identity, policy resolution, migration, grouping, prompt filtering, and skill composition. |
| `scripts/verify-overlay.mts` | Real keybinding/render/storage verification in a temporary home. |
| `tests/` | Unit, integration, native byte-parity, viewport, migration, and palette-behavior coverage. |
| `tests/fixtures/palette-foundation.ts` | Checked-in original palette baseline used by offline compatibility tests. |
| `plugin.json` | Agent Plugins metadata; runtime remains Pi-specific. |
| `theme.example.json` | Example color overrides. |

### Verification before submitting a change

Run all three core checks:

```bash
npm test
npm run typecheck
node --import tsx scripts/verify-overlay.mts
```

For dependency changes, also run:

```bash
npm audit --audit-level=high
```

Keep runtime behavior on public Pi APIs. Do not add private/deep imports, telemetry, a second skill-discovery engine, or a dependency for a small piece of existing functionality.

## Contributing

Use the [issue tracker](https://github.com/ZeR020/pi-skill-policy/issues) for bugs and proposals. For code changes:

1. Create a focused branch from `main`.
2. Add or update regression coverage for behavior changes.
3. Preserve saved config compatibility, source-path identity, and the documented controls.
4. Run the verification commands above.
5. Open a pull request against `ZeR020/pi-skill-policy` with the behavior change and test evidence.

Small corrections do not need new abstractions, settings frameworks, animation systems, or runtime dependencies.

## License

Pi Skill Policy is available under the [MIT License](LICENSE). Copyright for the independent project and its modifications belongs to ZeR020; the original foundation's copyright and the full MIT permission notice are retained in `LICENSE`.

## Foundation credit

The original palette and Load workflow came from **Nico Bailon**'s [`pi-skill-palette`](https://github.com/nicobailon/pi-skill-palette). That foundation made this project possible and is used under the MIT License. Nico's original copyright notice remains preserved in `LICENSE`.
