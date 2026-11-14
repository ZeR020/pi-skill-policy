export interface EffectivePolicy {
	bypassed: boolean;
	offPaths: ReadonlySet<string>;
	isEnabled(filePath: string): boolean;
}

export function resolvePolicy(
	global: { disabled?: Record<string, true>; off?: boolean },
	project: { overrides?: Record<string, "on" | "off"> } | null,
	projectTrusted: boolean,
): EffectivePolicy {
	const bypassed = global.off === true;
	const projectOn = new Set<string>();
	const projectOff = new Set<string>();
	if (projectTrusted && project?.overrides) {
		for (const [filePath, override] of Object.entries(project.overrides)) {
			if (override === "on") projectOn.add(filePath);
			if (override === "off") projectOff.add(filePath);
		}
	}

	const offPaths = new Set<string>();
	if (!bypassed) {
		for (const [filePath, disabled] of Object.entries(global.disabled ?? {})) {
			if (disabled === true && !projectOn.has(filePath)) offPaths.add(filePath);
		}
		for (const filePath of projectOff) offPaths.add(filePath);
	}

	return { bypassed, offPaths, isEnabled: (filePath) => !offPaths.has(filePath) };
}
