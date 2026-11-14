# Configuring Pi Skill Policy

The overlay saves policy for you. This page explains what is stored, where it lives, and what to check when a saved choice does not behave as expected. For controls, see [Using Pi Skill Policy](usage.md).

## Policy files

| Scope | Path | Contents |
| --- | --- | --- |
| Global | `<agent-dir>/config/pi-skill-palette.json` | Off skills, master bypass, path display |
| Project | `<trusted-cwd>/.pi/config/pi-skill-palette.json` | On/Off overrides for one working directory |

`<agent-dir>` is Pi's agent directory (normally `~/.pi/agent`). The `pi-skill-palette.json` filename is kept deliberately so existing policy remains compatible; it does not mean another extension is active.

Global keeps an Off list, so a skill that is absent is On and newly installed skills are available by default. Project stores only explicit `on` or `off` overrides; an absent path means Inherit.

Opening the overlay does not create either file. Project policy is never read or written while Pi does not trust the project, so an untrusted session cannot leak or modify it.

## Saving and failure behavior

- A save writes a fresh temporary file in the same directory with `0600` permissions, flushes it with `fsync`, and renames it into place.
- A failed save reports the full path and reason, and keeps the staged draft on screen so you can fix permissions or free space and retry.
- An existing file that is not valid JSON, or has an invalid policy shape, is reported and is not silently replaced. Delete or repair it, then reload.
- An invalid file fails open for that scope: it is ignored with a warning, and the remaining scopes still apply. Startup and headless summaries repeat the warning.

Writes and reads cover only local files needed for this work. There is no network access, telemetry, provider registration, model inference, or background service.

## Master bypass

The Global Master switch is stored as an optional boolean `off` in the Global file. `off: true` means saved restrictions are bypassed; the absence of the field means restrictions are enforced.

Bypass is a runtime convenience, not a reset. The Off list and Project overrides stay untouched, so turning enforcement back on restores exactly the previous policy. Saving a Global draft with the Master switch Off reloads Pi once; `/skillmgr disable` and `/skillmgr enable` also reload once after saving.

Bypass exists so enforcement can be suspended without rewriting the choices you would need to restore later.

## Theme

Colors are optional. Copy `theme.example.json` to:

```text
~/.pi/agent/extensions/pi-skill-palette/theme.json
```

The old theme directory is kept so existing appearance settings continue to work. Values are ANSI SGR codes such as `"36"` or `"38;2;R;G;B"`. Missing or invalid theme data falls back to the built-in defaults, and the file is only read; Pi Skill Policy never writes it.

Skill rows, Master, and Config share one visual language: `●` for enabled or active and `○` for disabled or bypassed. Project Inherit remains `[~]`.

## Troubleshooting

### A skill is still available after I turned it Off

Check the Global Master switch. `○ Master switch: OFF, restrictions bypassed` makes every saved Off choice temporarily ineffective. Turn it back on, or run `/skillmgr enable`.

### Pi warns that a policy file is not valid JSON or has an invalid shape

The file at the reported path is ignored for that scope, so policy fails open instead of blocking the session. Repair or delete the file, then reload. A save refuses to replace an invalid file, so the warning will persist until the file is fixed.

### Project choices have no effect

Project policy applies only while Pi trusts the current working directory. An untrusted Project tab is locked; it reads and writes nothing. Trust the project or use Global policy instead.

### Autocomplete still suggests a skill that is Off

Off skills are removed from unambiguous suggestions. A suggestion is kept when another registered command shares the same `skill:<name>` value, because autocomplete items carry no source identity; native input for a disabled winner is still blocked. If two sources provide the same skill name, Pi's first discovered winner decides availability, and turning it Off does not promote the other one.

### A forced-prompt warning appears

```text
pi-skill-policy: skills block not found in the existing forced system prompt — filtering inactive (pi update changed format?)
```

Another extension has already replaced the complete system prompt in a form this extension does not recognize. It warns once per reload instead of deleting text speculatively. Run `pi update --extensions` to pick up a newer release of this extension, reload, and retry. If the warning persists, report the Pi version and the other prompt-forcing extension in an issue.

A later extension can always replace the entire prompt after Pi Skill Policy runs.
