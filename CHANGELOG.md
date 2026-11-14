# Changelog

All notable user-facing changes to Pi Skill Policy are recorded here. Entries follow the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow semantic versioning.

## Unreleased

### Changed

- Restructure the documentation into a concise README with dedicated usage, configuration, and contribution guides.

## [2.2.0] - 2026-11-14

First version of the independent `ZeR020/pi-skill-policy` project.

### Added

- Load up to three different skills on demand with fuzzy search, confirmation, and one-shot injection.
- Pin selected skills as recurring instructions while native `/skill:` loading stays one-shot.
- Manage persistent Global visibility and trusted Project On/Off/Inherit overrides in one overlay.
- Bypass and restore restrictions with the Global Master switch without losing saved choices.
- Import a legacy `pi-skill-manager` Global policy once, including relative-key resolution and master-off carryover.
- Choose whether the catalog shows skill file paths.
- Group skills by package or source, including unscoped npm packages and a shared `auto-learned` Hermes procedural-memory group.
- Print an effective-policy summary to stderr in headless modes and notify it over RPC.

### Changed

- Require Pi 1.5.0 or newer; use Pi and Pi-TUI 1.5.2 as the development baseline.
- Preserve Pi's native structured prompt composition and repair only recognized skills blocks in already-forced prompts.
- Identify skills by their exact discovered `sourceInfo.path` and follow Pi's first-discovered winner for duplicate names.
- Use `●` for enabled or active and `○` for disabled or bypassed across skill, Master, and Config rows; keep Project's `[~]` Inherit marker.
- Keep `/skill`, `/skillmgr`, native `/skill:<name>` and multi-skill forms, both `pi-skill-palette.json` paths, the migration marker, and the legacy theme directory.
- Publish and maintain the project directly as `ZeR020/pi-skill-policy`.

### Security

- Save Global and Project policy transactionally with atomic writes, restrictive permissions, and full-path error reporting.
- Ignore invalid policy files with a visible warning instead of replacing them.
- Leave Project policy unread and unwritable while the project is untrusted.
- Run without network calls, telemetry, provider registration, model inference, or a background service.
- Never edit `SKILL.md`, `.skill-lock.json`, or Pi's native settings files.
- Document that visibility policy is not an operating-system security boundary: it does not erase existing conversation content or prevent deliberate file reads.
