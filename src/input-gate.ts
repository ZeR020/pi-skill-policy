import { firstSkillByName, skillKey } from "./identity.js";
import type { EffectivePolicy } from "./policy.js";

export const MAX_QUEUED_SKILLS = 3;

type PolicySkill = { sourceInfo: { path: string } };

// Mirrors pi's _expandSkillCommand exactly (agent-session.js): text must start
// with "/skill:" (no trim), name ends at the first ASCII space. Any looser rule
// would eat messages pi would have delivered as plain text.
export function parseNativeSkillInvocation(text: string): { name: string } | null {
	if (!text.startsWith("/skill:")) return null;
	const spaceIndex = text.indexOf(" ");
	const name = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
	return name === "" ? null : { name };
}

/** Pi resolves duplicate skill names first-discovered-wins; match that exactly. */
export function resolveNativeSkillTarget<T extends { name: string }>(skills: readonly T[], text: string): T | undefined {
	const invocation = parseNativeSkillInvocation(text);
	return invocation ? firstSkillByName(skills, invocation.name) : undefined;
}

export function skillsEnabledByPolicy<T extends PolicySkill>(skills: readonly T[], policy: EffectivePolicy): T[] {
	return skills.filter((skill) => policy.isEnabled(skillKey(skill)));
}

// All-or-nothing: a command with any disabled target is rejected whole, so no
// enabled sibling can be queued or injected on its own.
export function resolveInvocationPolicy<T extends PolicySkill>(
	skills: readonly T[],
	policy: EffectivePolicy,
): { allowed: true; skills: T[] } | { allowed: false; disabled: T[] } {
	const disabled = skills.filter((skill) => !policy.isEnabled(skillKey(skill)));
	return disabled.length > 0 ? { allowed: false, disabled } : { allowed: true, skills: [...skills] };
}
