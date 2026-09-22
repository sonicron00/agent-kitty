import * as acp from '@agentclientprotocol/sdk';
import {
    spawn,
    type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type PromptResult = {
    response: string;
    stopReason: string;
    sessionId: string;
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
    private onChunk: ((text: string) => void) | null = null;

    private onPermission:
    ((permission: PermissionRequest) => void) | null = null;

    private pendingPermissions = new Map<
        string,
        (response: any) => void
    >();

    private modelConfigId: string | null = null;
    private currentModelId: string | null = null;
    private modelOptions: ModelOption[] = [];

    private reasoningConfigId: string | null = null;
    private currentReasoningEffort: string | null = null;
    private reasoningOptions: ReasoningOption[] = [];

    private startPromise: Promise<void> | null = null;

    private busy = false;

    constructor(
        private readonly workspacePath: string,
        private readonly workspaceName: string,
    ) {}

    private updateReasoningState(
    configOptions: any[] | undefined,
): void {
    if (!Array.isArray(configOptions)) {
        return;
    }

    const reasoningConfig = configOptions.find(
        (option) =>
            option.id === 'reasoning_effort' ||
            option.category === 'reasoning_effort' ||
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

    private modelState(): ModelState {
        return {
            currentModelId:
                this.currentModelId,
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
            'This Copilot session does not expose configurable reasoning',
        );
    }

    if (this.busy) {
        throw new Error(
            'Cannot change reasoning while Copilot is working',
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

    if (!this.modelConfigId) {
        throw new Error(
            'Copilot did not advertise a model selector',
        );
    }

    if (this.busy) {
        throw new Error(
            'Cannot change model while Copilot is working',
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

    const result =
        await this.connection.setSessionConfigOption({
            sessionId: this.sessionId,
            configId:
                this.modelConfigId,
            value: modelId,
        });
        this.updateModelState(
            (result as any).configOptions,
        );

        this.currentModelId = modelId;

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

        const startScript = path.join(
            this.workspacePath,
            'start',
        );

        const copilotProcess = spawn(
            startScript,
            ['--acp', '--stdio'],
            {
                cwd: this.workspacePath,
                env: process.env,
                stdio: ['pipe', 'pipe', 'pipe'],
            },
        );

        this.process = copilotProcess;

        copilotProcess.stderr.on('data', (data) => {
            const text = data.toString().trim();

            if (text) {
                console.error(
                    `[${this.workspaceName}] ${text}`,
                );
            }
        });

        copilotProcess.on('exit', (code, signal) => {
            console.log(
                `[${this.workspaceName}] Copilot exited`,
                { code, signal },
            );

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
            
        };
        

        const connection =
            new acp.ClientSideConnection(
                (_agent) => client,
                stream,
            );

        this.connection = connection;

        await connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
        });

        const session =
            await connection.newSession({
                cwd: this.workspacePath,
                mcpServers: [],
            });

        this.sessionId = session.sessionId;

        const configOptions =
            (session as any).configOptions;

        this.updateModelState(configOptions);
        this.updateReasoningState(configOptions);

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

    this.currentResponse = '';
    this.onChunk = null;
    this.onPermission = null;
    this.onToolActivity = null;

    const session =
        await this.connection.newSession({
            cwd: this.workspacePath,
            mcpServers: [],
        });

    this.sessionId =
        session.sessionId;

    const configOptions =
        (session as any).configOptions;

    this.updateModelState(
        configOptions,
    );

    this.updateReasoningState(
        configOptions,
    );

    /*
     * Keep the currently selected model
     * after starting the new chat.
     */
    if (
        previousModelId &&
        this.modelConfigId &&
        this.modelOptions.some(
            (model) =>
                model.value ===
                previousModelId,
        )
    ) {
        const result =
            await this.connection.setSessionConfigOption({
                sessionId:
                    this.sessionId,
                configId:
                    this.modelConfigId,
                value:
                    previousModelId,
            });

        this.updateModelState(
            (result as any)
                .configOptions,
        );

        this.currentModelId =
            previousModelId;
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

            return {
                response: this.currentResponse,
                stopReason: result.stopReason,
                sessionId: this.sessionId,
            };
        } finally {
            this.onChunk = null;
            this.onPermission = null;
            this.onToolActivity = null;
            this.busy = false;
        }
    }
}
