import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionContext,
	Skill as HostSkill,
} from "@earendil-works/pi-coding-agent";

import { skillKey } from "./identity.js";
import { skillsEnabledByPolicy } from "./input-gate.js";
import type { EffectivePolicy } from "./policy.js";
import { filterSystemPrompt, findSkillsBlock } from "./prompt-gate.js";
import { buildPinnedSkillPrompt, buildSkillContext, type PaletteSkill } from "./skill-content.js";

export interface RuntimePolicyDeps {
	getPolicy(ctx: ExtensionContext): EffectivePolicy;
	getQueued(): PaletteSkill[];
	getPinned(): PaletteSkill[];
	setQueued(skills: PaletteSkill[]): void;
	setPinned(skills: PaletteSkill[]): void;
	notifyWarningOnce(key: string, message: string): void;
}

const BLOCK_NOT_FOUND_KEY = "forced-prompt-skills-block-not-found";

function needsVisibleRemoval(skills: readonly HostSkill[], policy: EffectivePolicy): boolean {
	// Native-hidden entries never render a prompt block, so only visible Off skills prove drift.
	return skills.some((skill) => !skill.disableModelInvocation && !policy.isEnabled(skillKey(skill)));
}

export function createBeforeAgentStartHandler(deps: RuntimePolicyDeps) {
	return async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | undefined> => {
		const policy = deps.getPolicy(ctx);
		const options = event.systemPromptOptions;
		// A pre-forced prompt was rendered from the ORIGINAL catalog, so snapshot before mutating.
		const originalSkills = [...options.skills];
		const wasForced = options.forceSystemPrompt !== undefined;

		// Structured filtering keeps native-hidden entries; pi's formatter hides those itself.
		const keptSkills = skillsEnabledByPolicy(originalSkills, policy);
		if (keptSkills.length !== originalSkills.length) options.skills = keptSkills;

		// Filter the ephemeral queue/pins before any body read so Off entries are never injected.
		const pendingQueued = deps.getQueued();
		const pendingPinned = deps.getPinned();
		const queued = skillsEnabledByPolicy(pendingQueued, policy);
		const pinned = skillsEnabledByPolicy(pendingPinned, policy);
		// The queue is one-shot (consumed even if a body read fails); pins persist until removed.
		if (pendingQueued.length > 0) deps.setQueued([]);
		if (pinned.length !== pendingPinned.length) deps.setPinned(pinned);

		let message: BeforeAgentStartEventResult["message"];
		let pinnedPrompt: string | undefined;
		try {
			if (queued.length > 0) {
				message = { customType: "skill-context", content: buildSkillContext(queued), display: true };
			}
			if (pinned.length > 0) pinnedPrompt = buildPinnedSkillPrompt(pinned);
		} catch {
			const names = [...queued, ...pinned].map((skill) => skill.name).join(", ");
			deps.notifyWarningOnce(`skill-read-failed:${names}`, `Failed to load selected skills: ${names}`);
			// No early return: forced-prompt repair and its warning still run for this turn.
		}

		const forcedPrompt = wasForced ? event.systemPrompt : undefined;
		const repaired =
			forcedPrompt === undefined ? undefined : filterSystemPrompt(forcedPrompt, originalSkills, policy.offPaths);
		if (
			forcedPrompt !== undefined &&
			needsVisibleRemoval(originalSkills, policy) &&
			findSkillsBlock(forcedPrompt, originalSkills) < 0
		) {
			deps.notifyWarningOnce(
				BLOCK_NOT_FOUND_KEY,
				"pi-skill-policy: skills block not found in the existing forced system prompt — filtering inactive (pi update changed format?)",
			);
		}

		let systemPrompt: string | undefined;
		if (repaired !== undefined) {
			// The forced prompt is opaque: only override when repair changed it or pins follow.
			if (repaired !== forcedPrompt) systemPrompt = repaired;
			if (pinnedPrompt !== undefined) systemPrompt = `${repaired}\n\n${pinnedPrompt}`;
		} else if (pinnedPrompt !== undefined) {
			// Live getter: evaluated only after the structured skills mutation above.
			systemPrompt = `${event.systemPrompt}\n\n${pinnedPrompt}`;
		}

		if (message === undefined && systemPrompt === undefined) return undefined;
		return { message, systemPrompt };
	};
}
