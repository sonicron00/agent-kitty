import * as acp from '@agentclientprotocol/sdk';
import {
    spawn,
    type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import type { HarnessDefinition } from './harness.js';

export type TokenUsage = {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
};

export type ContextUsage = {
    used: number;
    size: number;
    cost?: {
        amount: number;
        currency: string;
    };
};

/*
 * Harnesses that report usage outside the ACP spec
 * (Kiro's "_kiro.dev/metadata") give a context
 * percentage and metered credits instead of tokens.
 */
export type MeteredUsage = {
    contextPercent?: number;
    metering?: {
        value: number;
        unit: string;
    }[];
};

export type PromptUsage = {
    durationMs: number;
    tokens?: TokenUsage;
    context?: ContextUsage;
    metered?: MeteredUsage;
};

export type PromptResult = {
    response: string;
    stopReason: string;
    sessionId: string;
    usage: PromptUsage;
};

export type PermissionOption = {
    optionId: string;
    name: string;
    kind: string;
};

export type PermissionRequest = {
    requestId: string;
    title: string;
    options: PermissionOption[];
};

export type ToolActivity = {
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: string;
    locations?: string[];
    rawInput?: unknown;
    rawOutput?: unknown;
};

export type ModelOption = {
    value: string;
    name: string;
    description?: string;
};

export type ModelState = {
    currentModelId: string | null;
    /*
     * The model the harness chose for this session,
     * when it offers a "Default" choice.
     */
    defaultModelId: string | null;
    options: ModelOption[];
};

export type ReasoningOption = {
    value: string;
    name: string;
    description?: string;
};

export type ReasoningState = {
    currentReasoningEffort: string | null;
    options: ReasoningOption[];
};

export class WorkspaceAgent {
    private process: ChildProcessWithoutNullStreams | null = null;
    private connection: acp.ClientSideConnection | null = null;
    private sessionId: string | null = null;

    private currentResponse = '';
    private latestContextUsage: ContextUsage | null = null;
    private latestMeteredUsage: MeteredUsage | null = null;
    private onChunk: ((text: string) => void) | null = null;

    private onPermission:
    ((permission: PermissionRequest) => void) | null = null;

    private pendingPermissions = new Map<
        string,
        (response: any) => void
    >();

    private modelConfigId: string | null = null;
    /*
     * "config" uses session/set_config_option. "legacy"
     * is the older session "models" state with
     * session/set_model (Kiro CLI v2 engine).
     */
    private modelApi: 'config' | 'legacy' | null = null;
    private currentModelId: string | null = null;
    private modelOptions: ModelOption[] = [];
    private defaultModelId: string | null = null;

    private reasoningConfigId: string | null = null;
    private currentReasoningEffort: string | null = null;
    private reasoningOptions: ReasoningOption[] = [];

    private startPromise: Promise<void> | null = null;

    private busy = false;

    private stopped = false;

    constructor(
        private readonly workspacePath: string,
        private readonly workspaceName: string,
        private readonly harness: HarnessDefinition,
        private readonly loadMcpServers: () => Promise<any[]>,
    ) {}

    get harnessId(): string {
        return this.harness.id;
    }

    get harnessLabel(): string {
        return this.harness.label;
    }

    get supportsMcpListCommand(): boolean {
        return this.harness.supportsMcpListCommand;
    }

    isBusy(): boolean {
        return this.busy;
    }

    stop(): void {
        this.stopped = true;

        for (const resolver of this.pendingPermissions.values()) {
            resolver({ outcome: { outcome: 'cancelled' } });
        }

        this.pendingPermissions.clear();

        const child = this.process;

        this.process = null;
        this.connection = null;
        this.sessionId = null;

        if (child && child.exitCode === null) {
            child.kill('SIGTERM');

            setTimeout(() => {
                if (child.exitCode === null) {
                    child.kill('SIGKILL');
                }
            }, 3000).unref();
        }
    }

    private async sessionMcpServers(): Promise<any[]> {
        if (!this.harness.mcpViaAcp) {
            return [];
        }

        try {
            return await this.loadMcpServers();
        } catch (error) {
            console.error(
                `[${this.workspaceName}] Unable to load MCP servers`,
                error,
            );

            return [];
        }
    }

    private updateReasoningState(
    configOptions: any[] | undefined,
): void {
    if (!Array.isArray(configOptions)) {
        return;
    }

    const reasoningConfig = configOptions.find(
        (option) =>
            option.id === 'reasoning_effort' ||
            option.id === 'effortLevel' ||
            option.category === 'reasoning_effort' ||
            option.category === 'thought_level' ||
            option.name?.toLowerCase().includes('reasoning'),
    );

    if (!reasoningConfig) {
        this.reasoningConfigId = null;
        this.currentReasoningEffort = null;
        this.reasoningOptions = [];

        return;
    }

    this.reasoningConfigId = reasoningConfig.id;

    if (
        typeof reasoningConfig.currentValue === 'string'
    ) {
        this.currentReasoningEffort =
            reasoningConfig.currentValue;
    }

    const flattenOptions = (
        options: any[],
    ): ReasoningOption[] => {
        const result: ReasoningOption[] = [];

        for (const option of options ?? []) {
            if (Array.isArray(option.options)) {
                result.push(
                    ...flattenOptions(option.options),
                );

                continue;
            }

            if (typeof option.value === 'string') {
                result.push({
                    value: option.value,
                    name:
                        option.name ??
                        option.value,
                    description:
                        option.description,
                });
            }
        }

        return result;
    };

    this.reasoningOptions =
        flattenOptions(
            reasoningConfig.options ?? [],
        );
}

private reasoningState(): ReasoningState {
    return {
        currentReasoningEffort:
            this.currentReasoningEffort,
        options: this.reasoningOptions,
    };
}

    private updateModelState(
    configOptions: any[] | undefined,
    ): void {
        if (!Array.isArray(configOptions)) {
            return;
        }

        const modelConfig = configOptions.find(
            (option) =>
                option.category === 'model' ||
                option.id === 'model' ||
                option.name?.toLowerCase() === 'model',
        );

        if (!modelConfig) {
            return;
        }

        this.modelConfigId = modelConfig.id;
        this.modelApi = 'config';

        if (
            typeof modelConfig.currentValue ===
            'string'
        ) {
            this.currentModelId =
                modelConfig.currentValue;
        }

        const flattenOptions = (
            options: any[],
        ): ModelOption[] => {
            const result: ModelOption[] = [];

            for (const option of options ?? []) {
                /*
                * ACP also permits grouped select options.
                */
                if (Array.isArray(option.options)) {
                    result.push(
                        ...flattenOptions(
                            option.options,
                        ),
                    );

                    continue;
                }

                if (
                    typeof option.value === 'string'
                ) {
                    result.push({
                        value: option.value,
                        name:
                            option.name ??
                            option.value,
                        description:
                            option.description,
                    });
                }
            }

            return result;
        };

        this.modelOptions = flattenOptions(
            modelConfig.options ?? [],
        );
    }

    /*
     * Older ACP agents (Kiro CLI v2) return
     * { availableModels, currentModelId } in "models"
     * instead of a model config option.
     */
    private updateLegacyModelState(
        models: any,
    ): void {
        if (
            this.modelApi === 'config' ||
            !models ||
            !Array.isArray(models.availableModels)
        ) {
            return;
        }

        this.modelApi = 'legacy';
        this.modelConfigId = null;

        this.modelOptions = models.availableModels
            .filter(
                (model: any) =>
                    typeof model?.modelId === 'string',
            )
            .map((model: any) => ({
                value: model.modelId,
                name: model.name ?? model.modelId,
                ...(model.description
                    ? { description: model.description }
                    : {}),
            }));

        if (typeof models.currentModelId === 'string') {
            this.currentModelId = models.currentModelId;
        }
    }

    private applySessionState(session: any): void {
        this.modelApi = null;
        this.modelConfigId = null;

        const configOptions = session?.configOptions;

        this.updateModelState(configOptions);
        this.updateReasoningState(configOptions);
        this.updateLegacyModelState(session?.models);

        this.defaultModelId = this.currentModelId;
    }

    private async applyModel(
        modelId: string,
    ): Promise<void> {
        if (!this.connection || !this.sessionId) {
            throw new Error(
                'ACP session is not available',
            );
        }

        if (this.modelApi === 'legacy') {
            await this.connection.extMethod(
                'session/set_model',
                {
                    sessionId: this.sessionId,
                    modelId,
                },
            );
        } else if (this.modelConfigId) {
            const result =
                await this.connection.setSessionConfigOption({
                    sessionId: this.sessionId,
                    configId: this.modelConfigId,
                    value: modelId,
                });

            const configOptions =
                (result as any).configOptions;

            this.updateModelState(configOptions);
            this.updateReasoningState(configOptions);
        } else {
            throw new Error(
                `${this.harness.label} did not advertise a model selector`,
            );
        }

        this.currentModelId = modelId;
    }

    private modelState(): ModelState {
        return {
            currentModelId:
                this.currentModelId,
            defaultModelId:
                this.harness.offersDefaultModel
                    ? this.defaultModelId
                    : null,
            options: this.modelOptions,
        };
    }

    async getModels(): Promise<ModelState> {
    await this.start();

    return this.modelState();
}

async getReasoning(): Promise<ReasoningState> {
    await this.start();

    return this.reasoningState();
}

async setReasoning(
    effort: string,
): Promise<ReasoningState> {
    await this.start();

    if (
        !this.connection ||
        !this.sessionId
    ) {
        throw new Error(
            'ACP session is not available',
        );
    }

    if (!this.reasoningConfigId) {
        throw new Error(
            `This ${this.harness.label} session does not expose configurable reasoning`,
        );
    }

    if (this.busy) {
        throw new Error(
            `Cannot change reasoning while ${this.harness.label} is working`,
        );
    }

    const exists =
        this.reasoningOptions.some(
            (option) =>
                option.value === effort,
        );

    if (!exists) {
        throw new Error(
            `Reasoning effort is not available: ${effort}`,
        );
    }

    const result =
        await this.connection.setSessionConfigOption({
            sessionId: this.sessionId,
            configId:
                this.reasoningConfigId,
            value: effort,
        });

    const configOptions =
        (result as any).configOptions;

    this.updateModelState(configOptions);
    this.updateReasoningState(configOptions);

    this.currentReasoningEffort =
        effort;

    return this.reasoningState();
}

async setModel(
    modelId: string,
): Promise<ModelState> {
    await this.start();

    if (
        !this.connection ||
        !this.sessionId
    ) {
        throw new Error(
            'ACP session is not available',
        );
    }

    if (!this.modelApi) {
        throw new Error(
            `${this.harness.label} did not advertise a model selector`,
        );
    }

    if (this.busy) {
        throw new Error(
            `Cannot change model while ${this.harness.label} is working`,
        );
    }

    const modelExists =
        this.modelOptions.some(
            (model) =>
                model.value === modelId,
        );

    if (!modelExists) {
        throw new Error(
            `Model is not available: ${modelId}`,
        );
    }

    await this.applyModel(modelId);

    return this.modelState();
}

    private onToolActivity:
    ((activity: ToolActivity) => void) | null = null;

    async start(): Promise<void> {
    if (
        this.connection &&
        this.sessionId
    ) {
        return;
    }

    if (this.startPromise) {
        await this.startPromise;
        return;
    }

    this.startPromise =
        this.startInternal();

    try {
        await this.startPromise;
    } finally {
        this.startPromise = null;
    }
}

private async startInternal(): Promise<void> {
        if (this.connection && this.sessionId) {
            return;
        }

        if (this.stopped) {
            throw new Error(
                `${this.workspaceName} agent was stopped`,
            );
        }

        const launch = this.harness.launch(
            this.workspacePath,
        );

        const copilotProcess = spawn(
            launch.command,
            launch.args,
            {
                cwd: this.workspacePath,
                env: {
                    ...process.env,
                    ...launch.env,
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            },
        );

        this.process = copilotProcess;

        const spawnFailed = new Promise<never>(
            (_resolve, reject) => {
                copilotProcess.once('error', (error) => {
                    console.error(
                        `[${this.workspaceName}] Unable to start ${this.harness.label}`,
                        error,
                    );

                    reject(
                        new Error(
                            `Unable to start ${this.harness.label}: ${error.message}`,
                        ),
                    );
                });

                copilotProcess.once('exit', (code, signal) => {
                    reject(
                        new Error(
                            `${this.harness.label} exited during startup (code ${code}, signal ${signal})`,
                        ),
                    );
                });
            },
        );

        spawnFailed.catch(() => undefined);

        let startupStderr = '';

        copilotProcess.stderr.on('data', (data) => {
            const text = data.toString().trim();

            if (text) {
                if (!this.sessionId) {
                    startupStderr = `${startupStderr}\n${text}`.slice(-2000);
                }

                console.error(
                    `[${this.workspaceName}] ${text}`,
                );
            }
        });

        copilotProcess.on('exit', (code, signal) => {
            console.log(
                `[${this.workspaceName}] ${this.harness.label} exited`,
                { code, signal },
            );

            if (this.process !== copilotProcess) {
                return;
            }

            this.process = null;
            this.connection = null;
            this.sessionId = null;
        });

        if (
            !copilotProcess.stdin ||
            !copilotProcess.stdout
        ) {
            throw new Error(
                `Unable to create ACP pipes for ${this.workspaceName}`,
            );
        }

        const output = Writable.toWeb(
            copilotProcess.stdin,
        ) as WritableStream<Uint8Array>;

        const input = Readable.toWeb(
            copilotProcess.stdout,
        ) as ReadableStream<Uint8Array>;

        const stream = acp.ndJsonStream(output, input);

        const client: acp.Client = {
/**         requestPermission: async (params) => {
            const requestId = randomUUID();

            const title =
                params.toolCall?.title ??
                'Copilot wants to use a tool';

            const permission: PermissionRequest = {
                requestId,
                title,
                options: params.options.map((option) => ({
                    optionId: option.optionId,
                    name: option.name,
                    kind: option.kind,
                })),
            };

            console.log(
                `[${this.workspaceName}] Permission requested`,
                permission,
            );

            this.onPermission?.(permission);

            return await new Promise((resolve) => {
                this.pendingPermissions.set(
                    requestId,
                    resolve,
                );
            });
        }, */

        requestPermission: async (params) => {

            const allowOnce = params.options.find(
                (option) => option.kind === 'allow_once',
            );

            if (!allowOnce) {
                console.log(
                    `[${this.workspaceName}] No allow_once option available`,
                );

                return {
                    outcome: {
                        outcome: 'cancelled',
                    },
                };
            }

            return {
                outcome: {
                    outcome: 'selected',
                    optionId: allowOnce.optionId,
                },
            };
        },

    

        sessionUpdate: async (params) => {
            const update = params.update;

            if (
                update.sessionUpdate ===
                'config_option_update'
            ) {
                const configOptions =
                    (update as any).configOptions;

                this.updateModelState(configOptions);
                this.updateReasoningState(configOptions);

                return;
            }

            if (
                update.sessionUpdate ===
                'usage_update'
            ) {
                const usage = update as any;

                if (
                    typeof usage.used === 'number' &&
                    typeof usage.size === 'number'
                ) {
                    this.latestContextUsage = {
                        used: usage.used,
                        size: usage.size,
                        ...(usage.cost &&
                        typeof usage.cost.amount === 'number'
                            ? {
                                  cost: {
                                      amount: usage.cost.amount,
                                      currency: String(
                                          usage.cost.currency ?? 'USD',
                                      ),
                                  },
                              }
                            : {}),
                    };
                }

                return;
            }

            if (
                update.sessionUpdate ===
                    'agent_message_chunk' &&
                update.content.type === 'text'
            ) {
                const text = update.content.text;

                this.currentResponse += text;
                this.onChunk?.(text);

                return;
            }

            if (
                update.sessionUpdate === 'tool_call' ||
                update.sessionUpdate ===
                    'tool_call_update'
            ) {
                
                    const tool = update as any;

                    const activity: ToolActivity = {
                        toolCallId: tool.toolCallId,

                        ...(tool.title !== undefined
                            ? { title: tool.title }
                            : {}),

                        ...(tool.kind !== undefined
                            ? { kind: tool.kind }
                            : {}),

                        ...(tool.status !== undefined
                            ? { status: tool.status }
                            : {}),

                        ...(Array.isArray(tool.locations)
                            ? {
                                locations: tool.locations
                                    .map(
                                        (location: any) =>
                                            location.path,
                                    )
                                    .filter(Boolean),
                            }
                            : {}),

                        ...(tool.rawInput !== undefined
                            ? { rawInput: tool.rawInput }
                            : {}),

                        ...(tool.rawOutput !== undefined
                            ? { rawOutput: tool.rawOutput }
                            : {}),
                    };

                    this.onToolActivity?.(activity);

                    return;
            }
        },

        /*
         * Harness-specific notifications (for example
         * Kiro's "_kiro.dev/*") are optional extras.
         * Only Kiro's per-turn metadata is used, as
         * it is Kiro's only source of usage figures.
         */
        extNotification: async (method, params) => {
            if (
                method.replace(/^_/, '') !==
                    'kiro.dev/metadata' ||
                !this.busy ||
                (params as any)?.sessionId !== this.sessionId
            ) {
                return;
            }

            const metered = toMeteredUsage(params);

            if (metered) {
                this.latestMeteredUsage = {
                    ...this.latestMeteredUsage,
                    ...metered,
                };
            }
        },
            
        };
        

        const connection =
            new acp.ClientSideConnection(
                (_agent) => client,
                stream,
            );

        this.connection = connection;

        let session: acp.NewSessionResponse;

        try {
            session = await Promise.race([
                spawnFailed,
                (async () => {
                    await connection.initialize({
                        protocolVersion: acp.PROTOCOL_VERSION,
                        clientCapabilities: {},
                    });

                    return await connection.newSession({
                        cwd: this.workspacePath,
                        mcpServers:
                            await this.sessionMcpServers(),
                    });
                })(),
            ]);
        } catch (error) {
            if (this.process === copilotProcess) {
                this.process = null;
                this.connection = null;
                this.sessionId = null;
            }

            if (copilotProcess.exitCode === null) {
                copilotProcess.kill('SIGTERM');
            }

            if ((error as { code?: unknown })?.code === -32000) {
                throw new Error(
                    `${this.harness.label} is not signed in. ${this.harness.signInHint}`,
                );
            }

            /*
             * Let the remaining stderr arrive so the
             * harness's own reason can be reported.
             */
            await new Promise<void>((resolve) => {
                if (copilotProcess.stderr.readableEnded) {
                    resolve();
                    return;
                }

                copilotProcess.stderr.once('end', resolve);
                setTimeout(resolve, 1000).unref();
            });

            const reason = startupStderr.trim();

            if (/not (logged|signed) in/i.test(reason)) {
                throw new Error(
                    `${this.harness.label} is not signed in. ${this.harness.signInHint}`,
                );
            }

            if (reason && error instanceof Error) {
                const lastLines = reason
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .slice(-3)
                    .join(' ');

                throw new Error(
                    `${error.message}: ${lastLines}`,
                );
            }

            throw error;
        }

        if (this.process !== copilotProcess) {
            throw new Error(
                `${this.workspaceName} agent was stopped during startup`,
            );
        }

        this.sessionId = session.sessionId;

        this.applySessionState(session);

    };

        resolvePermission(
            requestId: string,
            optionId: string,
        ): boolean {
            const resolver =
                this.pendingPermissions.get(requestId);

            if (!resolver) {
                return false;
            }

            this.pendingPermissions.delete(requestId);

            resolver({
                outcome: {
                    outcome: 'selected',
                    optionId,
                },
            });

            return true;
        };

        async getMcpStatusText(): Promise<string> {
    await this.start();

    if (
        !this.connection ||
        !this.sessionId
    ) {
        throw new Error(
            'ACP session is not available',
        );
    }

    if (this.busy) {
        throw new Error(
            `${this.workspaceName} is currently busy`,
        );
    }

    this.busy = true;

    const previousResponse =
        this.currentResponse;

    this.currentResponse = '';

    try {
        await this.connection.prompt({
            sessionId: this.sessionId,
            prompt: [
                {
                    type: 'text',
                    text: '/mcp list',
                },
            ],
        });

        return this.currentResponse.trim();
    } finally {
        this.currentResponse =
            previousResponse;

        this.busy = false;
    }
};

async resetSession(): Promise<void> {
    await this.start();

    if (!this.connection) {
        throw new Error(
            'ACP connection is not available',
        );
    }

    if (this.busy) {
        throw new Error(
            `${this.workspaceName} is currently busy`,
        );
    }

    const previousModelId =
        this.currentModelId;

    const followedDefault =
        this.harness.offersDefaultModel &&
        previousModelId ===
            this.defaultModelId;

    this.currentResponse = '';
    this.onChunk = null;
    this.onPermission = null;
    this.onToolActivity = null;

    const session =
        await this.connection.newSession({
            cwd: this.workspacePath,
            mcpServers:
                await this.sessionMcpServers(),
        });

    this.sessionId =
        session.sessionId;

    this.applySessionState(session);

    /*
     * Keep the currently selected model
     * after starting the new chat, unless it
     * was the harness default.
     */
    if (
        !followedDefault &&
        previousModelId &&
        previousModelId !==
            this.currentModelId &&
        this.modelApi &&
        this.modelOptions.some(
            (model) =>
                model.value ===
                previousModelId,
        )
    ) {
        await this.applyModel(
            previousModelId,
        );
    }
}

async getMcpServerStatusText(
    serverName: string,
): Promise<string> {
    await this.start();

    if (
        !this.connection ||
        !this.sessionId
    ) {
        throw new Error(
            'ACP session is not available',
        );
    }

    if (this.busy) {
        throw new Error(
            `${this.workspaceName} is currently busy`,
        );
    }

    this.busy = true;

    const previousResponse =
        this.currentResponse;

    this.currentResponse = '';

    try {
        await this.connection.prompt({
            sessionId: this.sessionId,
            prompt: [
                {
                    type: 'text',
                    text: `/mcp show ${serverName}`,
                },
            ],
        });

        return this.currentResponse.trim();
    } finally {
        this.currentResponse =
            previousResponse;

        this.busy = false;
    }
}

        async prompt(
            text: string,
            callbacks?: {
                onChunk?: (text: string) => void;

                onPermission?: (
                    permission: PermissionRequest,
                ) => void;

                onToolActivity?: (
                    activity: ToolActivity,
                ) => void;
            },
        ): Promise<PromptResult> {

        await this.start();

        if (!this.connection || !this.sessionId) {
            throw new Error(
                `ACP session unavailable for ${this.workspaceName}`,
            );
        }

        if (this.busy) {
            throw new Error(
                `${this.workspaceName} is already processing a prompt`,
            );
        }

        this.busy = true;
        this.currentResponse = '';
        this.latestContextUsage = null;
        this.latestMeteredUsage = null;

        const startedAt = Date.now();

        this.onChunk =
            callbacks?.onChunk ?? null;

        this.onPermission =
            callbacks?.onPermission ?? null;
        
        this.onToolActivity =
            callbacks?.onToolActivity ?? null;
        
        try {
            const result =
                await this.connection.prompt({
                    sessionId: this.sessionId,
                    prompt: [
                        {
                            type: 'text',
                            text,
                        },
                    ],
                });

            const tokens = toTokenUsage(result.usage);

            return {
                response: this.currentResponse,
                stopReason: result.stopReason,
                sessionId: this.sessionId,
                usage: {
                    durationMs: Date.now() - startedAt,
                    ...(tokens ? { tokens } : {}),
                    ...(this.latestContextUsage
                        ? { context: this.latestContextUsage }
                        : {}),
                    ...(this.latestMeteredUsage
                        ? { metered: this.latestMeteredUsage }
                        : {}),
                },
            };
        } finally {
            this.onChunk = null;
            this.onPermission = null;
            this.onToolActivity = null;
            this.busy = false;
        }
    }
}

function toMeteredUsage(
    params: unknown,
): MeteredUsage | undefined {
    const raw = params as any;
    const result: MeteredUsage = {};

    if (typeof raw?.contextUsagePercentage === 'number') {
        result.contextPercent = raw.contextUsagePercentage;
    }

    if (Array.isArray(raw?.meteringUsage)) {
        const metering = raw.meteringUsage
            .filter(
                (entry: any) =>
                    typeof entry?.value === 'number',
            )
            .map((entry: any) => ({
                value: entry.value,
                unit: String(
                    entry.value === 1
                        ? entry.unit ?? ''
                        : entry.unitPlural ?? entry.unit ?? '',
                ),
            }));

        if (metering.length > 0) {
            result.metering = metering;
        }
    }

    return Object.keys(result).length > 0
        ? result
        : undefined;
}

/*
 * ACP reports per-turn token usage on the prompt
 * response (unstable in the spec, but both Copilot
 * and codex-acp send it). Optional counts are dropped
 * when the harness omits them.
 */
function toTokenUsage(
    usage: acp.Usage | null | undefined,
): TokenUsage | undefined {
    if (
        !usage ||
        typeof usage.totalTokens !== 'number'
    ) {
        return undefined;
    }

    const result: TokenUsage = {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens,
    };

    for (const key of [
        'thoughtTokens',
        'cachedReadTokens',
        'cachedWriteTokens',
    ] as const) {
        const value = usage[key];

        if (typeof value === 'number') {
            result[key] = value;
        }
    }

    return result;
}
