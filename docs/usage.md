# Using Pi Skill Policy

All interaction happens in one overlay with four tabs: **Load**, **Global**, **Project**, and **Config**. Left and Right move between tabs. Enter saves the active management tab and closes; Esc discards staged edits and closes.

- `/skill` opens the overlay on Load.
- `/skillmgr` opens it on Global.
- `/skillmgr disable` and `/skillmgr enable` save the Global master bypass and reload Pi once.

With no discovered skills, `/skill` reports "No skills found" instead of opening an empty overlay.

## Load controls

Load filters over skill names and descriptions.

| Key | Action |
| --- | --- |
| Type | Filter skills. Spaces are literal search characters here. |
| Up / Down | Move the selection. The list wraps at both ends. |
| Enter | Queue, pin, unqueue, or unpin the selected skill. |
| Esc | Close the overlay and discard any unsaved management edits. |
| Left / Right | Switch tabs. |

Enter picks the action from the skill's current state:

- An unselected skill is queued, or pinned when its frontmatter declares `pinned: true`.
- A queued skill is unqueued and a pinned skill is unpinned. Removing either asks for confirmation: Tab, Left, or Right toggles the choice, Y confirms, N cancels, and the dialog keeps "Keep" selected by default. A dialog left alone for 30 seconds counts as "Keep".
- Enter refuses to close while management edits are unsaved. Save or discard them on their tab first.

## Queue and pin behavior

- The queue holds at most **three different skills**. A fourth selection is refused with a warning.
- Queued skills apply to the next message and are then consumed.
- Pinned skills stay active across turns until you unpin them.
- Native `/skill:` input stays one-shot even for a skill that declares `pinned: true`.
- Queues and pins are in-memory selections. `/reload` and Pi restarts clear them.
- Turning a skill Off removes it from the queue and pins immediately. Re-enable it and select it again deliberately.
- Queued and pinned skills appear in Pi's status line and above the input. The widget labels them "will be applied to next message" and "active as instructions".
- If a selected skill body cannot be read, the queue is still consumed and a warning names the affected skills instead of injecting a partial result.

## Management controls

Global, Project, and Config edit a staged draft. Opening a tab or toggling a row writes nothing.

| Key | Action |
| --- | --- |
| Up / Down | Move between rows. |
| Left / Right | Switch tabs. |
| Type | Filter rows by pack/name. Whitespace is not accepted in management filters. |
| Space | Stage the next state for the selected row. |
| Tab | Stage every row shown for the selected package/source group. With a filter active, only matching rows change. |
| Enter | Save the active tab and close after a successful write. |
| Esc | Discard staged edits and close. |

Additional behavior:

- Global and Project are separate files. Switching between the Global draft (Global and Config) and Project is refused while edits are pending, with a notice naming the unsaved scope.
- Load is always reachable. Enter there refuses to close while either draft is dirty.
- An idle overlay keeps unsaved edits open; it never discards them by timeout.
- On narrow terminals, paths, notices, errors, and control hints wrap instead of being truncated, and the list fits the available rows.
- A failed save keeps the draft visible with the failing path and reason.

## Global policy

New skills default to **On**. The Global tab stores the exceptions:

- **`●`** — the skill is allowed by Global policy.
- **`○`** — the skill is Off for every session.

The Global tab also holds the Master switch. The Config tab holds the path display preference, which is saved globally. With an active filter, only skill rows are listed; the Master row returns when the filter is cleared.

## Project policy

Project choices are saved for one trusted working directory and never affect other projects. Each row cycles through three states:

- **`[~] Inherit`** — use the Global choice.
- **`●`** — explicitly On here, including when Global is Off.
- **`○`** — explicitly Off here, including when Global leaves it On.

The Project tab is locked while Pi does not trust the current project: the policy file is neither read nor written, and staging is refused with an explanation.

## Effective state and indicators

Rows show the combined policy result, not just the current tab's stored value. The compact suffix on each row (`on` or `off`) is the effective state, so Global Off with Project On reads as effectively on, and Project Off makes an otherwise enabled skill unavailable.

The line above the rows summarizes the whole policy: enabled/total counts, the prompt-size impact, the number of Global Off entries (or `master off`), and the Project On/Off counts (or `untrusted`).

Skills are identified by Pi's exact discovered `sourceInfo.path`. Skill names are not lowercased, and paths are not collapsed through realpath. When two files provide the same skill name, Pi's first discovered winner remains authoritative; turning that winner Off does not promote a shadowed skill.

## Master bypass

The Global **Master switch** controls whether saved restrictions are enforced:

- **`●`** — restrictions are enforced.
- **`○` with "OFF, restrictions bypassed"** — Global Off and Project Off choices are temporarily ineffective.

The saved choices are kept intact. Turning the switch back on restores them. Saving a Global draft with the Master switch Off reloads Pi once so the switch takes effect; an ordinary visibility save applies without a reload.

The bypass affects only this extension's policy. It does not change Pi's native skill discovery or `disable-model-invocation` behavior.

## Config

**Show skill file paths** is a Global display preference:

- **`●`** — show source paths in the catalog.
- **`○`** — hide catalog path labels.

Config changes presentation only. It does not alter policy, prompt identity, selection, diagnostic paths, or the Project file, and it saves to the Global policy file even when the project is untrusted.

## Source groups

Skills are grouped under a heading derived from their source: Git package repository, skill-lock owner, scoped or unscoped npm package, the Hermes procedural-memory group, or the parent folder. Global and project Hermes memory skills share the **`auto-learned`** heading.

Headings are display labels and never replace a skill's source identity.

## Native invocation, prompts, and autocomplete

Pi's native command forms keep working when policy allows them:

- `/skill:<name>` invokes one skill through Pi's own expansion. It is one-shot.
- `/skill:a,b` and `/skill:a /skill:b` queue several skills, up to the three-skill limit.
- `/skill:a,b rest of prompt` queues the skills and sends the remaining text as the message.
- With no remaining prompt, the selection is queued for the next message.

Multi-skill input is validated before anything is queued. The whole command is rejected if any named skill is Off or if it would exceed the queue limit, and an enabled sibling is never loaded alone after such a rejection. If a name cannot be matched to a discovered skill, nothing is queued and the input is left to Pi.

When a skill is Off, the extension:

- blocks unambiguous native invocation and autocomplete suggestions for it,
- keeps ambiguous suggestions when another registered command shares the same `skill:<name>` value, because autocomplete items carry no source identity,
- removes it from the model-facing skills text for the next prompt.

Normal prompts keep Pi's native structured prompt composition. If another extension has already forced a complete prompt, Pi Skill Policy repairs the recognized skills block and preserves unrelated content. If the block cannot be recognized, it warns instead of deleting text:

```text
pi-skill-policy: skills block not found in the existing forced system prompt — filtering inactive (pi update changed format?)
```

A later extension can still replace the entire prompt after this one runs.

A skill marked `disable-model-invocation: true` keeps its native flag and is tagged **`(native)`** in management. Turning it On restores this extension's availability but does not expose it in Pi's model-facing catalog; it remains available for deliberate loading or pinning.

## Headless and RPC

In print or JSON mode, `/skill` and `/skillmgr` print one effective-policy summary to **stderr**, keeping JSON stdout clean. RPC sessions with a UI receive the same summary through `ui.notify`. `/skillmgr disable` and `/skillmgr enable` report their result the same way.

The summary reports enabled/total skills, prompt-size impact, Global Off state, and Project override and trust state, followed by any policy-file warnings.

## Safety limits

Skill visibility policy is not an operating-system security boundary:

- Content already in the conversation is not erased.
- A user or another extension can still read a skill file deliberately.
- An arbitrary later extension can replace the entire system prompt.
- Unsaved staged choices do not change saved policy.
- External edits to policy files are adopted on reload; there is no file watcher.
- After changing extension registration, reload Pi before judging the result.

For policy files, theme, and troubleshooting, see [Configuration](configuration.md). Installation and commands are summarized in the [README](../README.md).
