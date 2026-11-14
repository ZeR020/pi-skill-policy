# Pi Skill Policy

Pi Skill Policy is a Pi extension for loading skills on demand, pinning them as standing instructions, and deciding which skills each session may use. Global choices apply to every session; Project choices override them in one trusted repository. Everything is managed locally through `/skill`, with no account, network call, or external service involved.

## Features

- **Load on demand:** queue up to three different skills for your next message.
- **Pin standing instructions:** keep selected skills active across turns until you unpin them.
- **Global visibility:** turn any skill On or Off for every Pi session.
- **Project overrides:** inherit the Global choice, or force a skill On or Off in one trusted project.
- **Master bypass:** suspend every saved restriction without deleting your choices.

## Requirements

- **Pi 1.5.0 or newer.** Development and verification use Pi 1.5.2.

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

Pi Skill Policy is distributed from this Git repository and is not published to npm.

## Quick start

1. Open `/skill`.
2. Type part of a skill name or description to filter the list.
3. Press Enter to queue or pin the selected skill.
4. Send a message. Queued skills apply to that message; pinned skills stay active until you remove them.
5. Use the Global, Project, and Config tabs to change availability and display preferences.

Esc closes a clean Load view or discards unsaved management edits.

## Commands

| Command | Purpose |
| --- | --- |
| `/skill` | Open Load, Global, Project, and Config in one overlay. |
| `/skillmgr` | Open the same overlay on the Global tab. |
| `/skillmgr disable` | Save the Global master bypass and reload once. Per-skill choices are kept. |
| `/skillmgr enable` | Restore saved restrictions and reload once. |
| `/skill:<name>` | Invoke one enabled skill through Pi's native command. |

`/skill:a,b` queues several enabled skills, up to three. Such a command is rejected as a whole if any named skill is Off or if the queue would overflow. If a name cannot be matched to a discovered skill, nothing is queued and the input is left to Pi.

## Documentation

- [Usage](docs/usage.md): Load and management controls, policy scopes, invocation, and headless output.
- [Configuration](docs/configuration.md): policy files, master bypass, theme, and troubleshooting.
- [Contributing](CONTRIBUTING.md): local setup, source map, tests, and review expectations.

## License

Pi Skill Policy is released under the [MIT License](LICENSE).

## Acknowledgments

The original skill palette and Load workflow come from [Nico Bailon's pi-skill-palette](https://github.com/nicobailon/pi-skill-palette), used under the MIT License.
