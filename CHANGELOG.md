# Changelog

This file records user-facing changes to **Pi Skill Policy**, maintained by ZeR020. Entries follow the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## [2.2.0] - 2026-11-14

Initial independent project history for the current extension source and public Git repository.

### Added

- Load up to three different skills with fuzzy search, confirmation dialogs, native command support, and one-shot injection.
- Pin selected skills as recurring instructions while keeping native `/skill:` loading one-shot.
- Manage persistent Global visibility and trusted Project On/Off/Inherit overrides from the shared `/skill` overlay.
- Bypass and restore manager restrictions with the Global Master switch without losing saved choices.
- Import the legacy `pi-skill-manager` Global policy once, including deferred resolution of relative keys and master-off migration.
- Add transactional Global and Project saves with atomic writes and full-path feedback on failure.
- Filter disabled skills from structured prompts and supported pre-forced prompt forms while preserving unrelated content.
- Filter native invocation and unambiguous autocomplete suggestions using Pi's first-discovered winner semantics.
- Group skills by their package or source, including unscoped npm packages and a shared `auto-learned` Hermes procedural-memory group.
- Keep project policy unread and unwritable while the project is untrusted.
- Add Config display preferences and wrapped, terminal-aware management views with complete actionable errors and controls.
- Provide headless stderr and RPC notification summaries without polluting JSON stdout.
- Keep checked-in offline compatibility and palette-behavior regression coverage.

### Changed

- Require Pi 1.5.0 or newer and use Pi/Pi-TUI 1.5.2 as the development verification baseline.
- Use `●` for enabled/active and `○` for disabled/bypassed across skill, Master, and Config rows; preserve Project's `[~]` Inherit state.
- Preserve Pi's native structured prompt composition wherever possible rather than forcing a replacement prompt.
- Keep skill identity tied to the exact discovered `sourceInfo.path`; disabled winners never promote same-name shadows.
- Publish and maintain the project directly as `ZeR020/pi-skill-policy`, with ZeR020 package/plugin metadata and repository ownership.

### Compatibility

- Keep `/skill`, `/skillmgr`, native `/skill:<name>` commands, and multi-skill forms.
- Keep the existing Global and trusted-Project `pi-skill-palette.json` paths and migration marker.
- Keep the legacy optional theme directory so existing appearance settings remain usable.
- Leave the legacy skill-manager source and configuration untouched; only one policy-owner extension should be registered at a time.

### Privacy and safety

- No runtime network calls, telemetry, provider registration, model inference, or background service.
- No edits to `SKILL.md`, shared `.skill-lock.json`, or Pi's native settings files.
- Invalid policy files fail open with visible warnings and are not silently overwritten.
- Skill visibility policy is not an OS security boundary and does not erase existing conversation content or prevent deliberate file reads.
