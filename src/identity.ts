/**
 * Policy/queue identity: the verbatim discovered `sourceInfo.path`. `filePath` stays the
 * body-read/rendered location and is never substituted for identity.
 */
export function skillKey(skill: { sourceInfo: { path: string } }): string {
	return skill.sourceInfo.path;
}

export function firstSkillByName<T extends { name: string }>(skills: readonly T[], name: string): T | undefined {
	return skills.find((skill) => skill.name === name);
}

/**
 * Exposure catalog: pi dedupes by bare name before extensions see skills, keeping the
 * first-discovery winner. Projecting again keeps a disabled winner from promoting a shadow.
 */
export function firstWinnerPerName<T extends { name: string }>(skills: readonly T[]): T[] {
	const seen = new Set<string>();
	return skills.filter((skill) => {
		if (seen.has(skill.name)) return false;
		seen.add(skill.name);
		return true;
	});
}
