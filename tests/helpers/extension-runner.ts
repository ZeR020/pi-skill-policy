import {
	createExtensionRuntime,
	ExtensionRunner,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type Extension,
	type ExtensionActions,
	type ExtensionContextActions,
	type ExtensionError,
	type ExtensionHandler,
} from "@earendil-works/pi-coding-agent";

export type BeforeAgentStartHandler = ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;

/** Minimal public Extension record: Pi's runner only reads `path` and the event handler map here. */
export function beforeAgentStartExtension(path: string, handlers: BeforeAgentStartHandler[]): Extension {
	return {
		path,
		resolvedPath: path,
		sourceInfo: { path, source: "test", scope: "temporary", origin: "top-level" },
		handlers: new Map([["before_agent_start", handlers]]) as unknown as Extension["handlers"],
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

export interface BeforeAgentStartRun {
	result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>;
	/** Handler throws are swallowed by the runner and surface here, never as test failures. */
	errors: ExtensionError[];
}

export async function runBeforeAgentStart(
	extensions: Extension[],
	systemPromptOptions: BuildSystemPromptOptions,
): Promise<BeforeAgentStartRun> {
	const unused = () => {
		throw new Error("host dependency unused by this harness");
	};
	// Session manager and model registry stay null: before_agent_start never reads them.
	const runner = new ExtensionRunner(
		extensions,
		createExtensionRuntime(),
		systemPromptOptions.cwd,
		null as unknown as ConstructorParameters<typeof ExtensionRunner>[3],
		null as unknown as ConstructorParameters<typeof ExtensionRunner>[4],
	);
	runner.bindCore({} as ExtensionActions, {
		getModel: unused,
		getScopedModels: unused,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: unused,
		abort: unused,
		hasPendingMessages: () => false,
		shutdown: unused,
		getContextUsage: unused,
		compact: unused,
		getSystemPrompt: unused,
		executeTool: unused,
	} satisfies ExtensionContextActions);

	const errors: ExtensionError[] = [];
	runner.onError((error) => errors.push(error));
	const result = await runner.emitBeforeAgentStart({ messageType: "user", prompt: "go" }, systemPromptOptions);
	return { result, errors };
}
