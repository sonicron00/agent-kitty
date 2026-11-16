import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type FormEvent,
    type PointerEvent as ReactPointerEvent,
} from 'react';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

import 'highlight.js/styles/github.css';
import './App.css';
import { CodexAccountPanel } from './CodexAccount';
import { KiroAccountPanel } from './KiroAccount';


/*
 * --------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------
 */

type Workspace = {
    id: string;
    name: string;
    path: string;
    hasAgentsFile: boolean;
    hasMcpConfig: boolean;
    hasStartScript: boolean;
};

type WorkspaceView =
    | 'chat'
    | 'overview'
    | 'code'
    | 'mcps';

type MessageUsage = {
    durationMs?: number;
    tokens?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        thoughtTokens?: number;
        cachedReadTokens?: number;
        cachedWriteTokens?: number;
    };
    context?: {
        used: number;
        size: number;
        cost?: {
            amount: number;
            currency: string;
        };
    };
    metered?: {
        contextPercent?: number;
        metering?: {
            value: number;
            unit: string;
        }[];
    };
};

type Message = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    usage?: MessageUsage;

    /*
     * Set when the server carried context over
     * from another harness, or from before a
     * restart, for this response.
     */
    handoff?: {
        from: string[];
        mode: 'summary' | 'transcript';
        reason?: 'switch' | 'restart';
    };
};

type Repository = {
    name: string;
    path: string;
    branch: string;
    hasAgentsFile: boolean;
};

type PermissionOption = {
    optionId: string;
    name: string;
    kind: string;
};

type PermissionRequest = {
    requestId: string;
    title: string;
    options: PermissionOption[];
};

type ToolActivity = {
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: string;
    locations?: string[];
    rawInput?: unknown;
    rawOutput?: unknown;
};

type McpServer = {
    name: string;
    status: string;
    source:
        | 'shared'
        | 'workspace'
        | 'builtin'
        | 'unknown';
};

type ModelOption = {
    value: string;
    name: string;
    description?: string;
};

type ModelState = {
    currentModelId: string | null;
    defaultModelId?: string | null;
    options: ModelOption[];
};

/*
 * Picker value for "follow the harness's recommended
 * model" (Codex). Never sent to the server.
 */
const DEFAULT_MODEL_VALUE = '__default__';

type ReasoningOption = {
    value: string;
    name: string;
    description?: string;
};

type ReasoningState = {
    currentReasoningEffort: string | null;
    options: ReasoningOption[];
};

type WorkspaceActivities =
    Record<string, ToolActivity[]>;

type HarnessSummary = {
    id: string;
    label: string;
    description: string;
    available: boolean;
    detail?: string;
};

type HarnessState = {
    current: string;
    harnesses: HarnessSummary[];
};

type Conversations =
    Record<string, Message[]>;


/*
 * --------------------------------------------------------------------------
 * Local storage
 * --------------------------------------------------------------------------
 */

const CONVERSATIONS_STORAGE_KEY =
    'agent-kitty-conversations';

const MODELS_STORAGE_KEY =
    'agent-kitty-models';

const COMPOSER_HEIGHT_STORAGE_KEY =
    'agent-kitty-composer-height';

const ACCOUNTS_OPEN_STORAGE_KEY =
    'agent-kitty-accounts-open';

const COMPOSER_MIN_HEIGHT = 50;

function composerMaxHeight(): number {
    return Math.max(
        COMPOSER_MIN_HEIGHT,
        Math.round(window.innerHeight * 0.7),
    );
}

function clampComposerHeight(
    height: number,
): number {
    return Math.min(
        composerMaxHeight(),
        Math.max(COMPOSER_MIN_HEIGHT, height),
    );
}

function loadComposerHeight(): number | null {
    const stored = Number(
        localStorage.getItem(
            COMPOSER_HEIGHT_STORAGE_KEY,
        ),
    );

    return Number.isFinite(stored) && stored > 0
        ? clampComposerHeight(stored)
        : null;
}

function formatTokens(count: number): string {
    if (count >= 1_000_000) {
        return `${(count / 1_000_000).toFixed(1)}M`;
    }

    if (count >= 1_000) {
        return `${(count / 1_000).toFixed(1)}k`;
    }

    return String(count);
}

function formatDuration(ms: number): string {
    const seconds = ms / 1000;

    if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
    }

    const minutes = Math.floor(seconds / 60);

    return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function usageParts(
    usage: MessageUsage,
): string[] {
    const parts: string[] = [];
    const { tokens, context } = usage;

    if (tokens) {
        parts.push(
            `${formatTokens(tokens.inputTokens)} in`,
            `${formatTokens(tokens.outputTokens)} out`,
        );

        if (tokens.thoughtTokens) {
            parts.push(
                `${formatTokens(tokens.thoughtTokens)} reasoning`,
            );
        }

        if (tokens.cachedReadTokens) {
            parts.push(
                `${formatTokens(tokens.cachedReadTokens)} cache read`,
            );
        }

        if (tokens.cachedWriteTokens) {
            parts.push(
                `${formatTokens(tokens.cachedWriteTokens)} cache write`,
            );
        }

        parts.push(
            `${formatTokens(tokens.totalTokens)} total`,
        );
    }

    if (context && context.size > 0) {
        const percent = Math.round(
            (context.used / context.size) * 100,
        );

        parts.push(
            `context ${percent}% (${formatTokens(context.used)}/${formatTokens(context.size)})`,
        );
    }

    if (context?.cost) {
        parts.push(
            `${context.cost.amount.toFixed(4)} ${context.cost.currency}`,
        );
    }

    const metered = usage.metered;

    if (
        !(context && context.size > 0) &&
        typeof metered?.contextPercent === 'number'
    ) {
        parts.push(
            `context ${Math.round(metered.contextPercent)}%`,
        );
    }

    for (const entry of metered?.metering ?? []) {
        parts.push(
            `${entry.value.toFixed(entry.value < 1 ? 4 : 2)} ${entry.unit}`.trim(),
        );
    }

    if (typeof usage.durationMs === 'number') {
        parts.push(formatDuration(usage.durationMs));
    }

    return parts;
}

const HISTORY_TURN_LIMIT = 12;
const HISTORY_TEXT_LIMIT = 4_000;

/*
 * Pair up the visible chat so the server can replay it
 * to a new agent session if it has no saved transcript
 * of its own (for example a chat from an older build).
 */
function historyForServer(
    messages: Message[],
): { user: string; assistant: string }[] {
    const turns: {
        user: string;
        assistant: string;
    }[] = [];

    for (
        let index = 0;
        index < messages.length;
        index += 1
    ) {
        const message = messages[index];

        if (message.role !== 'user') {
            continue;
        }

        const next = messages[index + 1];

        turns.push({
            user: message.content.slice(
                0,
                HISTORY_TEXT_LIMIT,
            ),
            assistant:
                next?.role === 'assistant'
                    ? next.content.slice(
                          0,
                          HISTORY_TEXT_LIMIT,
                      )
                    : '',
        });
    }

    return turns.slice(-HISTORY_TURN_LIMIT);
}

function loadStoredConversations():
    Conversations {
    try {
        const stored =
            localStorage.getItem(
                CONVERSATIONS_STORAGE_KEY,
            );

        if (!stored) {
            return {};
        }

        return JSON.parse(
            stored,
        ) as Conversations;
    } catch {
        return {};
    }
}

/*
 * Model ids differ per harness, so each harness keeps
 * its own map. Copilot keeps the original key.
 */
function modelsStorageKey(
    harnessId: string,
): string {
    return harnessId === 'copilot'
        ? MODELS_STORAGE_KEY
        : `${MODELS_STORAGE_KEY}-${harnessId}`;
}

function getStoredModels(
    harnessId: string,
):
    Record<string, string> {
    try {
        const stored =
            localStorage.getItem(
                modelsStorageKey(
                    harnessId,
                ),
            );

        return stored
            ? JSON.parse(stored)
            : {};
    } catch {
        return {};
    }
}

function clearStoredModel(
    harnessId: string,
    workspaceId: string,
): void {
    try {
        const stored =
            getStoredModels(
                harnessId,
            );

        delete stored[workspaceId];

        localStorage.setItem(
            modelsStorageKey(
                harnessId,
            ),
            JSON.stringify(stored),
        );
    } catch (error) {
        console.error(
            'Unable to clear persisted model',
            error,
        );
    }
}

function storeModel(
    harnessId: string,
    workspaceId: string,
    modelId: string,
): void {
    try {
        const stored =
            getStoredModels(
                harnessId,
            );

        stored[workspaceId] =
            modelId;

        localStorage.setItem(
            modelsStorageKey(
                harnessId,
            ),
            JSON.stringify(stored),
        );
    } catch (error) {
        console.error(
            'Unable to persist model',
            error,
        );
    }
}

    type Theme = 'light' | 'dark';

    function getInitialTheme(): Theme {
    const stored = localStorage.getItem('agent-kitty-theme');

    if (stored === 'light' || stored === 'dark') {
        return stored;
    }

    return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }

/*
 * --------------------------------------------------------------------------
 * Display helpers
 * --------------------------------------------------------------------------
 */

function prettyName(
    name: string,
): string {
    return name
        .split('-')
        .map(
            (part) =>
                part.charAt(0)
                    .toUpperCase() +
                part.slice(1),
        )
        .join(' ');
}

function toolIcon(
    kind: string,
    status: string,
): string {
    if (status === 'completed') {
        return '✓';
    }

    if (status === 'failed') {
        return '✕';
    }

    switch (kind) {
        case 'read':
            return '▤';

        case 'search':
            return '⌕';

        case 'execute':
            return '›_';

        case 'fetch':
            return '↗';

        case 'edit':
            return '✎';

        case 'delete':
            return '−';

        case 'think':
            return '◌';

        default:
            return '•';
    }
}


/*
 * --------------------------------------------------------------------------
 * MCP group
 * --------------------------------------------------------------------------
 */

function McpGroup({
    title,
    description,
    servers,
    refreshingMcp,
    onRefresh,
}: {
    title: string;
    description: string;
    servers: McpServer[];
    refreshingMcp: string | null;
    onRefresh: (
        name: string,
    ) => void;
}) {
    if (servers.length === 0) {
        return null;
    }

    return (
        <section className="mcp-group">
            <div className="mcp-group-header">
                <div>
                    <h2>
                        {title}
                    </h2>

                    <p>
                        {description}
                    </p>
                </div>

                <span>
                    {servers.length}
                </span>
            </div>

            <div className="mcp-grid">
                {servers.map(
                    (server) => (
                        <div
                            className="mcp-card"
                            key={`${server.source}-${server.name}`}
                        >
                            <div
                                className={`mcp-status-icon ${server.status}`}
                            >
                                ●
                            </div>

                            <div className="mcp-details">
                                <div className="mcp-name">
                                    {prettyName(
                                        server.name,
                                    )}
                                </div>

                                <div className="mcp-meta">
                                    <span
                                        className={`mcp-source ${server.source}`}
                                    >
                                        {prettyName(
                                            server.source,
                                        )}
                                    </span>

                                    <span
                                        className={`mcp-state ${server.status}`}
                                    >
                                        {prettyName(
                                            server.status,
                                        )}
                                    </span>
                                </div>
                            </div>

                            <button
                                type="button"
                                className="mcp-refresh-button"
                                onClick={() =>
                                    onRefresh(
                                        server.name,
                                    )
                                }
                                disabled={
                                    refreshingMcp !==
                                    null
                                }
                            >
                                {refreshingMcp ===
                                server.name
                                    ? 'Refreshing…'
                                    : 'Refresh'}
                            </button>
                        </div>
                    ),
                )}
            </div>
        </section>
    );
}


/*
 * --------------------------------------------------------------------------
 * Application
 * --------------------------------------------------------------------------
 */

function App() {
    const [
        workspaces,
        setWorkspaces,
    ] = useState<Workspace[]>([]);

    const [
        selectedId,
        setSelectedId,
    ] = useState<string | null>(
        null,
    );

    const [
        workspaceView,
        setWorkspaceView,
    ] = useState<WorkspaceView>(
        'chat',
    );

    const [
        conversations,
        setConversations,
    ] = useState<Conversations>(
        loadStoredConversations,
    );

    const [
        reposByWorkspace,
        setReposByWorkspace,
    ] = useState<
        Record<string, Repository[]>
    >({});

    const [
        mcpsByWorkspace,
        setMcpsByWorkspace,
    ] = useState<
        Record<string, McpServer[]>
    >({});

    const [
        refreshingMcp,
        setRefreshingMcp,
    ] = useState<string | null>(
        null,
    );

    const [
        selectedFiles,
        setSelectedFiles,
    ] = useState<File[]>([]);

    const [
        prompt,
        setPrompt,
    ] = useState('');

    const [
        sendingByWorkspace,
        setSendingByWorkspace,
    ] = useState<
        Record<string, boolean>
    >({});

    const [
        error,
        setError,
    ] = useState<string | null>(
        null,
    );

    const [
        pendingPermissions,
        setPendingPermissions,
    ] = useState<
        Record<
            string,
            PermissionRequest | null
        >
    >({});

    const [
        activities,
        setActivities,
    ] = useState<
        WorkspaceActivities
    >({});

    const [
        modelsByWorkspace,
        setModelsByWorkspace,
    ] = useState<
        Record<string, ModelState>
    >({});

    const [
        changingModel,
        setChangingModel,
    ] = useState(false);

    const [
        reasoningByWorkspace,
        setReasoningByWorkspace,
    ] = useState<
        Record<
            string,
            ReasoningState
        >
    >({});

    const [
        changingReasoning,
        setChangingReasoning,
    ] = useState(false);

    const [
        overviewByWorkspace,
        setOverviewByWorkspace,
    ] = useState<
        Record<string, string>
    >({});

    const conversationEndRef =
        useRef<HTMLDivElement | null>(
            null,
        );

    const fileInputRef =
        useRef<HTMLInputElement | null>(
            null,
        );

    /*
     * Tracks whether a tool event occurred
     * between assistant text chunks.
     */
    const toolSinceLastChunkRef =
        useRef<
            Record<string, boolean>
        >({});

    const [theme, setTheme] = useState<Theme>(getInitialTheme);

    const [accountsOpen, setAccountsOpen] =
        useState<boolean>(
            () =>
                localStorage.getItem(
                    ACCOUNTS_OPEN_STORAGE_KEY,
                ) === 'true',
        );

    const [
        harnessState,
        setHarnessState,
    ] = useState<HarnessState | null>(
        null,
    );

    const [
        switchingHarness,
        setSwitchingHarness,
    ] = useState(false);

    const harnessId =
        harnessState?.current ??
        null;

    const [composerHeight, setComposerHeight] =
        useState<number | null>(
            loadComposerHeight,
        );

    const composerTextareaRef =
        useRef<HTMLTextAreaElement | null>(
            null,
        );

    /*
     * The handle sits on the top edge of the composer,
     * so dragging up grows the textarea.
     */
    function startComposerResize(
        event: ReactPointerEvent<HTMLDivElement>,
    ) {
        const textarea =
            composerTextareaRef.current;

        if (!textarea) {
            return;
        }

        event.preventDefault();

        const handle = event.currentTarget;
        const pointerId = event.pointerId;
        const startY = event.clientY;
        const startHeight =
            textarea.getBoundingClientRect().height;

        handle.setPointerCapture(pointerId);
        document.body.classList.add(
            'resizing-composer',
        );

        let latest = startHeight;

        const onMove = (move: PointerEvent) => {
            latest = clampComposerHeight(
                startHeight + (startY - move.clientY),
            );

            setComposerHeight(latest);
        };

        const onEnd = () => {
            handle.removeEventListener(
                'pointermove',
                onMove,
            );
            handle.removeEventListener(
                'pointerup',
                onEnd,
            );
            handle.removeEventListener(
                'pointercancel',
                onEnd,
            );

            if (handle.hasPointerCapture(pointerId)) {
                handle.releasePointerCapture(pointerId);
            }

            document.body.classList.remove(
                'resizing-composer',
            );

            localStorage.setItem(
                COMPOSER_HEIGHT_STORAGE_KEY,
                String(Math.round(latest)),
            );
        };

        handle.addEventListener(
            'pointermove',
            onMove,
        );
        handle.addEventListener(
            'pointerup',
            onEnd,
        );
        handle.addEventListener(
            'pointercancel',
            onEnd,
        );
    }

    function resetComposerHeight() {
        setComposerHeight(null);

        localStorage.removeItem(
            COMPOSER_HEIGHT_STORAGE_KEY,
        );
    }

    const harnessLabel =
        harnessState?.harnesses.find(
            (harness) =>
                harness.id ===
                harnessState.current,
        )?.label ?? 'Agent';

    const anySending =
        Object.values(
            sendingByWorkspace,
        ).some(Boolean);

    const showCodexAccount =
        harnessState?.harnesses.some(
            (harness) =>
                harness.id === 'codex',
        ) ?? false;

    const showKiroAccount =
        harnessState?.harnesses.some(
            (harness) =>
                harness.id === 'kiro' &&
                (harness.available ||
                    harness.detail?.startsWith(
                        'Not signed in',
                    )),
        ) ?? false;

    /*
     * ----------------------------------------------------------------------
     * Derived state
     * ----------------------------------------------------------------------
     */

    const selectedWorkspace =
        useMemo(
            () =>
                workspaces.find(
                    (workspace) =>
                        workspace.id ===
                        selectedId,
                ) ?? null,
            [
                workspaces,
                selectedId,
            ],
        );

    const messages =
        selectedId
            ? conversations[
                  selectedId
              ] ?? []
            : [];

    const currentActivities =
        selectedId
            ? activities[
                  selectedId
              ] ?? []
            : [];

    const pendingPermission =
        selectedId
            ? pendingPermissions[
                  selectedId
              ] ?? null
            : null;

    const modelState =
        selectedId
            ? modelsByWorkspace[
                  selectedId
              ]
            : undefined;

    /*
     * Without a saved model the session runs on the
     * harness's recommended model.
     */
    const storedModelOverride =
        selectedId && harnessId
            ? getStoredModels(
                  harnessId,
              )[selectedId]
            : undefined;

    const followsDefaultModel =
        Boolean(
            modelState?.defaultModelId,
        ) &&
        !modelState?.options.some(
            (model) =>
                model.value ===
                storedModelOverride,
        );

    const reasoningState =
        selectedId
            ? reasoningByWorkspace[
                  selectedId
              ]
            : undefined;

    const sending =
        selectedId
            ? sendingByWorkspace[
                  selectedId
              ] ?? false
            : false;


    /*
     * ----------------------------------------------------------------------
     * Persist conversations and theme
     * ----------------------------------------------------------------------
     */

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('agent-kitty-theme', theme);
        }, [theme]);

    useEffect(() => {
        try {
            localStorage.setItem(
                CONVERSATIONS_STORAGE_KEY,
                JSON.stringify(
                    conversations,
                ),
            );
        } catch (error) {
            console.error(
                'Unable to persist conversations',
                error,
            );
        }
    }, [conversations]);


    /*
     * ----------------------------------------------------------------------
     * Load workspaces
     * ----------------------------------------------------------------------
     */

    useEffect(() => {
        async function loadWorkspaces() {
            try {
                const response =
                    await fetch(
                        '/api/workspaces',
                    );

                if (!response.ok) {
                    throw new Error(
                        `Request failed: ${response.status}`,
                    );
                }

                const data =
                    (await response.json()) as
                        Workspace[];

                setWorkspaces(data);

                if (
                    data.length > 0
                ) {
                    setSelectedId(
                        data[0].id,
                    );
                }
            } catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Unable to load workspaces',
                );
            }
        }

        loadWorkspaces();
    }, []);


    /*
     * ----------------------------------------------------------------------
     * Harness (global across all agents)
     * ----------------------------------------------------------------------
     */

    const loadHarness = useCallback(
        async () => {
            try {
                const response =
                    await fetch(
                        '/api/harness',
                    );

                const data =
                    await response.json();

                if (!response.ok) {
                    throw new Error(
                        data.error ??
                            'Unable to load harness',
                    );
                }

                setHarnessState(
                    data as HarnessState,
                );
            } catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Unable to load harness',
                );
            }
        },
        [],
    );

    useEffect(() => {
        loadHarness();
    }, [loadHarness]);

    async function changeHarness(
        nextHarnessId: string,
    ) {
        if (
            !harnessState ||
            nextHarnessId ===
                harnessState.current
        ) {
            return;
        }

        setSwitchingHarness(true);
        setError(null);

        try {
            const response =
                await fetch(
                    '/api/harness',
                    {
                        method:
                            'POST',

                        headers: {
                            'Content-Type':
                                'application/json',
                        },

                        body:
                            JSON.stringify({
                                harness:
                                    nextHarnessId,
                            }),
                    },
                );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error ??
                        'Unable to switch harness',
                );
            }

            /*
             * The server parks the old agents and
             * resumes any on the new harness, so
             * refetch per-session state. The chat
             * itself is kept and handed over.
             */
            setModelsByWorkspace({});
            setReasoningByWorkspace({});
            setMcpsByWorkspace({});
            setPendingPermissions({});
            setActivities({});

            setHarnessState(
                data as HarnessState,
            );
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Unable to switch harness',
            );
        } finally {
            setSwitchingHarness(false);
        }
    }


    /*
     * ----------------------------------------------------------------------
     * Load model options and restore persisted model
     * ----------------------------------------------------------------------
     */

    useEffect(() => {
        if (
            !selectedId ||
            !harnessId
        ) {
            return;
        }

        const workspaceId =
            selectedId;

        const activeHarnessId =
            harnessId;

        async function loadModels() {
            try {
                const response =
                    await fetch(
                        `/api/workspaces/${workspaceId}/models`,
                    );

                const data =
                    (await response.json()) as
                        ModelState & {
                            error?: string;
                        };

                if (!response.ok) {
                    throw new Error(
                        data.error ??
                            'Unable to load models',
                    );
                }

                const storedModels =
                    getStoredModels(
                        activeHarnessId,
                    );

                const storedModel =
                    storedModels[
                        workspaceId
                    ];

                const storedModelExists =
                    Boolean(
                        storedModel &&
                            data.options.some(
                                (
                                    option,
                                ) =>
                                    option.value ===
                                    storedModel,
                            ),
                    );

                if (
                    storedModelExists &&
                    storedModel !==
                        data.currentModelId
                ) {
                    const restoreResponse =
                        await fetch(
                            `/api/workspaces/${workspaceId}/model`,
                            {
                                method:
                                    'POST',

                                headers: {
                                    'Content-Type':
                                        'application/json',
                                },

                                body:
                                    JSON.stringify(
                                        {
                                            modelId:
                                                storedModel,
                                        },
                                    ),
                            },
                        );

                    const restoredData =
                        (await restoreResponse.json()) as
                            ModelState & {
                                error?: string;
                            };

                    if (
                        !restoreResponse.ok
                    ) {
                        throw new Error(
                            restoredData.error ??
                                'Unable to restore model',
                        );
                    }

                    setModelsByWorkspace(
                        (current) => ({
                            ...current,

                            [workspaceId]:
                                restoredData,
                        }),
                    );

                    return;
                }

                setModelsByWorkspace(
                    (current) => ({
                        ...current,

                        [workspaceId]:
                            data,
                    }),
                );
            } catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Unable to load models',
                );
            }
        }

        loadModels();
    }, [selectedId, harnessId]);


    /*
     * ----------------------------------------------------------------------
     * Load reasoning options
     * ----------------------------------------------------------------------
     */

    useEffect(() => {
        if (
            !selectedId ||
            !harnessId
        ) {
            return;
        }

        const workspaceId =
            selectedId;

        async function loadReasoning() {
            try {
                const response =
                    await fetch(
                        `/api/workspaces/${workspaceId}/reasoning`,
                    );

                const data =
                    (await response.json()) as
                        ReasoningState & {
                            error?: string;
                        };

                if (!response.ok) {
                    throw new Error(
                        data.error ??
                            'Unable to load reasoning options',
                    );
                }

                setReasoningByWorkspace(
                    (current) => ({
                        ...current,

                        [workspaceId]:
                            data,
                    }),
                );
            } catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Unable to load reasoning options',
                );
            }
        }

        loadReasoning();
    }, [selectedId, harnessId]);


    /*
     * ----------------------------------------------------------------------
     * Load Overview
     * ----------------------------------------------------------------------
     */

    useEffect(() => {
        if (
            workspaceView !==
                'overview' ||
            !selectedId ||
            overviewByWorkspace[
                selectedId
            ] !== undefined
        ) {
            return;
        }

        const workspaceId =
            selectedId;

        async function loadOverview() {
            try {
                const response =
                    await fetch(
                        `/api/workspaces/${workspaceId}/overview`,
                    );

                const data =
                    await response.json();

                if (!response.ok) {
                    throw new Error(
                        data.error ??
                            'Unable to load overview',
                    );
                }

                setOverviewByWorkspace(
                    (current) => ({
                        ...current,

                        [workspaceId]:
                            data.markdown,
                    }),
                );
            } catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Unable to load overview',
                );
            }
        }

        loadOverview();
    }, [
        workspaceView,
        selectedId,
        overviewByWorkspace,
    ]);


    /*
     * ----------------------------------------------------------------------
     * Load repositories
     * ----------------------------------------------------------------------
     */

    useEffect(() => {
        if (
            workspaceView !==
                'code' ||
            !selectedId ||
            reposByWorkspace[
                selectedId
            ] !== undefined
        ) {
            return;
        }

        const workspaceId =
            selectedId;

        async function loadRepos() {
            try {
                const response =
                    await fetch(
                        `/api/workspaces/${workspaceId}/repos`,
                    );

                const data =
                    await response.json();

                if (!response.ok) {
                    throw new Error(
                        data.error ??
                            'Unable to load repositories',
                    );
                }

                setReposByWorkspace(
                    (current) => ({
                        ...current,

                        [workspaceId]:
                            data,
                    }),
                );
            } catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Unable to load repositories',
                );
            }
        }

        loadRepos();
    }, [
        workspaceView,
        selectedId,
        reposByWorkspace,
    ]);


    /*
     * ----------------------------------------------------------------------
     * MCP loading
     * ----------------------------------------------------------------------
     */

    async function loadMcps(
        workspaceId: string,
    ) {
        try {
            const response =
                await fetch(
                    `/api/workspaces/${workspaceId}/mcps`,
                );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error ??
                        'Unable to load MCP servers',
                );
            }

            setMcpsByWorkspace(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        data,
                }),
            );
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Unable to load MCP servers',
            );
        }
    }

    useEffect(() => {
        if (
            workspaceView !==
                'mcps' ||
            !selectedId ||
            !harnessId ||
            mcpsByWorkspace[
                selectedId
            ] !== undefined
        ) {
            return;
        }

        loadMcps(
            selectedId,
        );
    }, [
        workspaceView,
        selectedId,
        harnessId,
        mcpsByWorkspace,
    ]);


    /*
     * ----------------------------------------------------------------------
     * Keep conversation scrolled to latest output
     * ----------------------------------------------------------------------
     */

    useEffect(() => {
        conversationEndRef.current
            ?.scrollIntoView({
                behavior:
                    'smooth',
            });
    }, [
        messages,
        currentActivities,
        pendingPermission,
    ]);

    /*
     * Opening an agent (or returning to its chat)
     * jumps straight to the latest message. This runs
     * after the smooth scroll above so it wins, and
     * again on the next frame once layout settles.
     */
    useEffect(() => {
        if (workspaceView !== 'chat') {
            return;
        }

        const jumpToBottom = () => {
            conversationEndRef.current
                ?.scrollIntoView({
                    behavior:
                        'auto',
                    block:
                        'end',
                });
        };

        jumpToBottom();

        const frame =
            requestAnimationFrame(
                jumpToBottom,
            );

        return () =>
            cancelAnimationFrame(
                frame,
            );
    }, [
        selectedId,
        workspaceView,
    ]);


    /*
     * ----------------------------------------------------------------------
     * Clear chat
     * ----------------------------------------------------------------------
     */

    async function clearChat() {
        if (
            !selectedId ||
            sending
        ) {
            return;
        }

        const workspaceId =
            selectedId;

        const confirmed =
            window.confirm(
                'Clear this conversation and start a new chat?',
            );

        if (!confirmed) {
            return;
        }

        setError(null);

        try {
            const response =
                await fetch(
                    `/api/workspaces/${workspaceId}/new-chat`,
                    {
                        method:
                            'POST',
                    },
                );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error ??
                        'Unable to start new chat',
                );
            }

            setConversations(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        [],
                }),
            );

            setActivities(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        [],
                }),
            );

            setPendingPermissions(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        null,
                }),
            );

            toolSinceLastChunkRef.current[
                workspaceId
            ] = false;

            /*
             * A fresh ACP session can have
             * refreshed MCP state. Make the
             * MCP tab load it again next time.
             */
            setMcpsByWorkspace(
                (current) => {
                    const next = {
                        ...current,
                    };

                    delete next[
                        workspaceId
                    ];

                    return next;
                },
            );
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Unable to start new chat',
            );
        }
    }


    /*
     * ----------------------------------------------------------------------
     * Refresh one MCP status
     * ----------------------------------------------------------------------
     */

    async function refreshMcp(
        serverName: string,
    ) {
        if (
            !selectedId ||
            refreshingMcp
        ) {
            return;
        }

        const workspaceId =
            selectedId;

        setRefreshingMcp(
            serverName,
        );

        setError(null);

        try {
            const response =
                await fetch(
                    `/api/workspaces/${workspaceId}/mcps/${encodeURIComponent(
                        serverName,
                    )}/status`,
                );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error ??
                        'Unable to refresh MCP status',
                );
            }

            setMcpsByWorkspace(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        (
                            current[
                                workspaceId
                            ] ?? []
                        ).map(
                            (server) =>
                                server.name ===
                                serverName
                                    ? {
                                          ...server,

                                          status:
                                              data.status,
                                      }
                                    : server,
                        ),
                }),
            );
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Unable to refresh MCP status',
            );
        } finally {
            setRefreshingMcp(
                null,
            );
        }
    }


    /*
     * ----------------------------------------------------------------------
     * Model
     * ----------------------------------------------------------------------
     */

    async function changeModel(
        modelId: string,
    ) {
        if (
            !selectedId ||
            sending ||
            changingModel
        ) {
            return;
        }

        const workspaceId =
            selectedId;

        const useDefault =
            modelId ===
            DEFAULT_MODEL_VALUE;

        const targetModelId =
            useDefault
                ? modelsByWorkspace[
                      workspaceId
                  ]?.defaultModelId
                : modelId;

        if (!targetModelId) {
            return;
        }

        setChangingModel(true);
        setError(null);

        try {
            const response =
                await fetch(
                    `/api/workspaces/${workspaceId}/model`,
                    {
                        method:
                            'POST',

                        headers: {
                            'Content-Type':
                                'application/json',
                        },

                        body:
                            JSON.stringify(
                                {
                                    modelId:
                                        targetModelId,
                                },
                            ),
                    },
                );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error ??
                        'Unable to change model',
                );
            }

            setModelsByWorkspace(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        data,
                }),
            );

            if (harnessId) {
                if (useDefault) {
                    clearStoredModel(
                        harnessId,
                        workspaceId,
                    );
                } else {
                    storeModel(
                        harnessId,
                        workspaceId,
                        modelId,
                    );
                }
            }
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Unable to change model',
            );
        } finally {
            setChangingModel(false);
        }
    }


    /*
     * ----------------------------------------------------------------------
     * Reasoning
     * ----------------------------------------------------------------------
     */

    async function changeReasoning(
        effort: string,
    ) {
        if (
            !selectedId ||
            sending ||
            changingReasoning
        ) {
            return;
        }

        const workspaceId =
            selectedId;

        setChangingReasoning(true);
        setError(null);

        try {
            const response =
                await fetch(
                    `/api/workspaces/${workspaceId}/reasoning`,
                    {
                        method:
                            'POST',

                        headers: {
                            'Content-Type':
                                'application/json',
                        },

                        body:
                            JSON.stringify(
                                {
                                    effort,
                                },
                            ),
                    },
                );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error ??
                        'Unable to change reasoning',
                );
            }

            setReasoningByWorkspace(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        data,
                }),
            );
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Unable to change reasoning',
            );
        } finally {
            setChangingReasoning(
                false,
            );
        }
    }


    /*
     * ----------------------------------------------------------------------
     * Permission handling
     * ----------------------------------------------------------------------
     */

    async function answerPermission(
        optionId: string,
    ) {
        if (
            !selectedId ||
            !pendingPermission
        ) {
            return;
        }

        const workspaceId =
            selectedId;

        const response =
            await fetch(
                `/api/workspaces/${workspaceId}/permissions/${pendingPermission.requestId}`,
                {
                    method:
                        'POST',

                    headers: {
                        'Content-Type':
                            'application/json',
                    },

                    body:
                        JSON.stringify(
                            {
                                optionId,
                            },
                        ),
                },
            );

        if (!response.ok) {
            const text =
                await response.text();

            setError(
                text ||
                    'Unable to answer permission request',
            );

            return;
        }

        setPendingPermissions(
            (current) => ({
                ...current,

                [workspaceId]:
                    null,
            }),
        );
    }


    /*
     * ----------------------------------------------------------------------
     * Tool activity
     * ----------------------------------------------------------------------
     */

    function updateToolActivity(
        workspaceId: string,
        incoming: ToolActivity,
    ) {
        setActivities(
            (current) => {
                const existing =
                    current[
                        workspaceId
                    ] ?? [];

                const index =
                    existing.findIndex(
                        (activity) =>
                            activity.toolCallId ===
                            incoming.toolCallId,
                    );

                if (index === -1) {
                    return {
                        ...current,

                        [workspaceId]:
                            [
                                ...existing,
                                incoming,
                            ],
                    };
                }

                const updated =
                    [...existing];

                updated[index] = {
                    ...updated[
                        index
                    ],

                    ...incoming,

                    locations:
                        incoming.locations ??
                        updated[
                            index
                        ].locations,
                };

                return {
                    ...current,

                    [workspaceId]:
                        updated,
                };
            },
        );
    }


    /*
     * ----------------------------------------------------------------------
     * Streaming events
     * ----------------------------------------------------------------------
     */

    function processStreamEvent(
        workspaceId: string,
        assistantMessageId: string,
        event: any,
    ) {
        if (
            event.type ===
            'chunk'
        ) {
            const resumedAfterTool =
                toolSinceLastChunkRef
                    .current[
                    workspaceId
                ] ?? false;

            setConversations(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        (
                            current[
                                workspaceId
                            ] ?? []
                        ).map(
                            (message) => {
                                if (
                                    message.id !==
                                    assistantMessageId
                                ) {
                                    return message;
                                }

                                let text =
                                    event.text;

                                /*
                                 * The agent sometimes resumes
                                 * immediately after a tool call
                                 * without whitespace.
                                 */
                                if (
                                    resumedAfterTool &&
                                    message.content &&
                                    text &&
                                    !/^\s/.test(
                                        text,
                                    )
                                ) {
                                    text =
                                        `\n\n${text}`;
                                }

                                return {
                                    ...message,

                                    content:
                                        message.content +
                                        text,
                                };
                            },
                        ),
                }),
            );

            toolSinceLastChunkRef
                .current[
                workspaceId
            ] = false;

            return;
        }

        if (
            event.type ===
            'permission'
        ) {
            setPendingPermissions(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        {
                            requestId:
                                event.requestId,

                            title:
                                event.title,

                            options:
                                event.options,
                        },
                }),
            );

            return;
        }

        if (
            event.type ===
                'tool' &&
            event.activity
        ) {
            toolSinceLastChunkRef
                .current[
                workspaceId
            ] = true;

            updateToolActivity(
                workspaceId,
                event.activity as
                    ToolActivity,
            );

            return;
        }

        if (
            event.type ===
                'handoff' &&
            Array.isArray(event.from)
        ) {
            setConversations(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        (
                            current[
                                workspaceId
                            ] ?? []
                        ).map(
                            (message) =>
                                message.id ===
                                assistantMessageId
                                    ? {
                                          ...message,
                                          handoff: {
                                              from:
                                                  event.from as string[],
                                              mode:
                                                  event.mode === 'summary'
                                                      ? 'summary'
                                                      : 'transcript',
                                              reason:
                                                  event.reason === 'restart'
                                                      ? 'restart'
                                                      : 'switch',
                                          },
                                      }
                                    : message,
                        ),
                }),
            );

            return;
        }

        if (
            event.type ===
                'done' &&
            event.usage
        ) {
            setConversations(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        (
                            current[
                                workspaceId
                            ] ?? []
                        ).map(
                            (message) =>
                                message.id ===
                                assistantMessageId
                                    ? {
                                          ...message,
                                          usage:
                                              event.usage as MessageUsage,
                                      }
                                    : message,
                        ),
                }),
            );

            return;
        }

        if (
            event.type ===
            'error'
        ) {
            throw new Error(
                event.error ??
                    `${harnessLabel} returned an error`,
            );
        }
    }


    /*
     * ----------------------------------------------------------------------
     * Send prompt
     * ----------------------------------------------------------------------
     */

    async function sendPrompt(
        event: FormEvent,
    ) {
        event.preventDefault();

        if (
            !selectedId ||
            (
                !prompt.trim() &&
                selectedFiles.length ===
                    0
            ) ||
            sendingByWorkspace[
                selectedId
            ]
        ) {
            return;
        }

        const workspaceId =
            selectedId;

        const text =
            prompt.trim();

        /*
         * Capture the selected files before
         * clearing the composer.
         */
        const filesToSend =
            [...selectedFiles];

        const attachmentSummary =
            filesToSend.length > 0
                ? `📎 ${filesToSend
                      .map(
                          (file) =>
                              file.name,
                      )
                      .join(', ')}`
                : '';

        const visibleUserMessage =
            [
                text,
                attachmentSummary,
            ]
                .filter(Boolean)
                .join('  ');

        const userMessageId =
            crypto.randomUUID();

        const assistantMessageId =
            crypto.randomUUID();

        setPrompt('');
        setSelectedFiles([]);

        setSendingByWorkspace(
            (current) => ({
                ...current,

                [workspaceId]:
                    true,
            }),
        );

        setError(null);

        setActivities(
            (current) => ({
                ...current,

                [workspaceId]:
                    [],
            }),
        );

        toolSinceLastChunkRef.current[
            workspaceId
        ] = false;

        setConversations(
            (current) => ({
                ...current,

                [workspaceId]: [
                    ...(
                        current[
                            workspaceId
                        ] ?? []
                    ),

                    {
                        id:
                            userMessageId,

                        role:
                            'user',

                        content:
                            visibleUserMessage,
                    },

                    {
                        id:
                            assistantMessageId,

                        role:
                            'assistant',

                        content:
                            '',
                    },
                ],
            }),
        );

        try {
            const formData =
                new FormData();

            formData.append(
                'prompt',
                text ||
                    'Please review the attached file(s).',
            );

            const history =
                historyForServer(
                    conversations[
                        workspaceId
                    ] ?? [],
                );

            if (history.length > 0) {
                formData.append(
                    'history',
                    JSON.stringify(history),
                );
            }

            for (
                const file of
                filesToSend
            ) {
                formData.append(
                    'attachments',
                    file,
                );
            }

            const response =
                await fetch(
                    `/api/workspaces/${workspaceId}/prompt`,
                    {
                        method:
                            'POST',

                        body:
                            formData,
                    },
                );

            if (!response.ok) {
                const message =
                    await response.text();

                throw new Error(
                    message ||
                        `Prompt failed: ${response.status}`,
                );
            }

            if (!response.body) {
                throw new Error(
                    'Prompt response did not contain a stream',
                );
            }

            const reader =
                response.body
                    .getReader();

            const decoder =
                new TextDecoder();

            let buffer = '';

            while (true) {
                const {
                    value,
                    done,
                } =
                    await reader.read();

                if (done) {
                    break;
                }

                buffer +=
                    decoder.decode(
                        value,
                        {
                            stream:
                                true,
                        },
                    );

                const lines =
                    buffer.split(
                        '\n',
                    );

                buffer =
                    lines.pop() ??
                    '';

                for (
                    const line of
                    lines
                ) {
                    if (
                        !line.trim()
                    ) {
                        continue;
                    }

                    const streamEvent =
                        JSON.parse(
                            line,
                        );

                    processStreamEvent(
                        workspaceId,
                        assistantMessageId,
                        streamEvent,
                    );
                }
            }

            if (
                buffer.trim()
            ) {
                const streamEvent =
                    JSON.parse(
                        buffer,
                    );

                processStreamEvent(
                    workspaceId,
                    assistantMessageId,
                    streamEvent,
                );
            }
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : 'Prompt failed';

            setError(message);

            setConversations(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        (
                            current[
                                workspaceId
                            ] ?? []
                        ).map(
                            (
                                conversationMessage,
                            ) =>
                                conversationMessage.id ===
                                assistantMessageId
                                    ? {
                                          ...conversationMessage,

                                          content:
                                              `Error: ${message}`,
                                      }
                                    : conversationMessage,
                        ),
                }),
            );
        } finally {
            setSendingByWorkspace(
                (current) => ({
                    ...current,

                    [workspaceId]:
                        false,
                }),
            );
        }
    }


    /*
     * ----------------------------------------------------------------------
     * Render
     * ----------------------------------------------------------------------
     */

    return (
        <div className="app-shell">
            <aside className="sidebar">
                <div className="brand">
                    <img
                        className="brand-wordmark"
                        src="/agent-kitty-logo.png"
                        alt="Agent Kitty"
                    />
                </div>

                <div className="harness-picker">
                    <label htmlFor="harness">
                        Harness
                    </label>

                    {harnessState ? (
                        <select
                            id="harness"
                            value={
                                harnessState.current
                            }
                            disabled={
                                anySending ||
                                switchingHarness
                            }
                            title={
                                anySending
                                    ? 'Wait for agents to finish before switching'
                                    : 'Applies to every agent'
                            }
                            onChange={(
                                event,
                            ) =>
                                changeHarness(
                                    event
                                        .target
                                        .value,
                                )
                            }
                        >
                            {harnessState.harnesses.map(
                                (
                                    harness,
                                ) => (
                                    <option
                                        key={
                                            harness.id
                                        }
                                        value={
                                            harness.id
                                        }
                                        disabled={
                                            !harness.available &&
                                            harness.id !==
                                                harnessState.current
                                        }
                                    >
                                        {harness.label}
                                        {harness.available
                                            ? ''
                                            : ` (${harness.detail ?? 'unavailable'})`}
                                    </option>
                                ),
                            )}
                        </select>
                    ) : (
                        <span className="model-loading">
                            Loading…
                        </span>
                    )}

                    {showCodexAccount ||
                    showKiroAccount ? (
                        /*
                         * Closed <details> keep their children
                         * mounted, so an in-progress sign-in
                         * survives collapsing the section.
                         */
                        <details
                            className="account-group"
                            open={accountsOpen}
                            onToggle={(event) => {
                                const open =
                                    event.currentTarget
                                        .open;

                                setAccountsOpen(open);

                                localStorage.setItem(
                                    ACCOUNTS_OPEN_STORAGE_KEY,
                                    String(open),
                                );
                            }}
                        >
                            <summary>
                                Sign-ins
                            </summary>

                            <div className="account-group-body">
                                {showCodexAccount ? (
                                    <CodexAccountPanel
                                        disabled={
                                            anySending ||
                                            switchingHarness
                                        }
                                        onChanged={
                                            loadHarness
                                        }
                                    />
                                ) : null}

                                {showKiroAccount ? (
                                    <KiroAccountPanel
                                        disabled={
                                            anySending ||
                                            switchingHarness
                                        }
                                        onChanged={
                                            loadHarness
                                        }
                                    />
                                ) : null}
                            </div>
                        </details>
                    ) : null}
                </div>

                <div className="sidebar-heading">
                    Agents
                </div>

                <nav className="workspace-list">
                    {workspaces.map(
                        (workspace) => {
                            const isWorking =
                                sendingByWorkspace[
                                    workspace.id
                                ] ?? false;

                            const needsPermission =
                                pendingPermissions[
                                    workspace.id
                                ] !==
                                    undefined &&
                                pendingPermissions[
                                    workspace.id
                                ] !== null;

                            return (
                                <button
                                    type="button"
                                    key={
                                        workspace.id
                                    }
                                    className={
                                        workspace.id ===
                                        selectedId
                                            ? 'workspace active'
                                            : 'workspace'
                                    }
                                    onClick={() => {
                                        setSelectedId(
                                            workspace.id,
                                        );

                                        setWorkspaceView(
                                            'chat',
                                        );

                                        setError(
                                            null,
                                        );

                                        setPrompt(
                                            '',
                                        );

                                        setSelectedFiles(
                                            [],
                                        );
                                    }}
                                >
                                    <span
                                        className={`status-dot ${
                                            needsPermission
                                                ? 'attention'
                                                : isWorking
                                                  ? 'working'
                                                  : 'ready'
                                        }`}
                                    />

                                    <span className="workspace-sidebar-name">
                                        {prettyName(
                                            workspace.name,
                                        )}
                                    </span>

                                    <span
                                        className={`workspace-sidebar-status ${
                                            needsPermission
                                                ? 'attention'
                                                : isWorking
                                                  ? 'working'
                                                  : ''
                                        }`}
                                    >
                                        {needsPermission
                                            ? 'Needs input'
                                            : isWorking
                                              ? 'Working…'
                                              : 'Ready'}
                                    </span>
                                </button>
                            );
                        },
                    )}
                </nav>
            </aside>

            <main className="main">
                {selectedWorkspace && (
                    <>
                        <header className="topbar">
                            <div className="topbar-left">
                                <h2>
                                    {prettyName(
                                        selectedWorkspace.name,
                                    )}
                                </h2>

                                <span className="connected">
                                    ●{' '}
                                    {sending
                                        ? 'Working'
                                        : 'Ready'}
                                    {harnessState
                                        ? ` · ${harnessLabel}`
                                        : ''}
                                </span>
                            </div>

                            <div className="session-controls">
                                <div className="model-picker">
                                    <label htmlFor="model">
                                        Model
                                    </label>

                                    {modelState ? (
                                        <select
                                            id="model"
                                            value={
                                                followsDefaultModel
                                                    ? DEFAULT_MODEL_VALUE
                                                    : modelState.currentModelId ??
                                                      ''
                                            }
                                            disabled={
                                                sending ||
                                                changingModel
                                            }
                                            onChange={(
                                                event,
                                            ) =>
                                                changeModel(
                                                    event
                                                        .target
                                                        .value,
                                                )
                                            }
                                        >
                                            {modelState.defaultModelId ? (
                                                <option
                                                    value={
                                                        DEFAULT_MODEL_VALUE
                                                    }
                                                >
                                                    {`Default (${harnessLabel} recommended: ${
                                                        modelState.options.find(
                                                            (
                                                                model,
                                                            ) =>
                                                                model.value ===
                                                                modelState.defaultModelId,
                                                        )?.name ??
                                                        modelState.defaultModelId
                                                    })`}
                                                </option>
                                            ) : null}
                                            {modelState.options.map(
                                                (
                                                    model,
                                                ) => (
                                                    <option
                                                        key={
                                                            model.value
                                                        }
                                                        value={
                                                            model.value
                                                        }
                                                    >
                                                        {
                                                            model.name
                                                        }
                                                    </option>
                                                ),
                                            )}
                                        </select>
                                    ) : (
                                        <span className="model-loading">
                                            Loading…
                                        </span>
                                    )}
                                </div>

                                <div className="reasoning-picker">
                                    <label htmlFor="reasoning">
                                        Reasoning
                                    </label>

                                    {reasoningState &&
                                    reasoningState
                                        .options
                                        .length >
                                        0 ? (
                                        <select
                                            id="reasoning"
                                            value={
                                                reasoningState.currentReasoningEffort ??
                                                ''
                                            }
                                            disabled={
                                                sending ||
                                                changingReasoning
                                            }
                                            onChange={(
                                                event,
                                            ) =>
                                                changeReasoning(
                                                    event
                                                        .target
                                                        .value,
                                                )
                                            }
                                        >
                                            {reasoningState.options.map(
                                                (
                                                    option,
                                                ) => (
                                                    <option
                                                        key={
                                                            option.value
                                                        }
                                                        value={
                                                            option.value
                                                        }
                                                    >
                                                        {
                                                            option.name
                                                        }
                                                    </option>
                                                ),
                                            )}
                                        </select>
                                    ) : (
                                        <span className="reasoning-unavailable">
                                            Default
                                        </span>
                                    )}
                                </div>
                                <div className="topbar-actions">
                                    <button
                                        type="button"
                                        className="theme-toggle"
                                        onClick={() =>
                                        setTheme(current => (current === 'dark' ? 'light' : 'dark'))
                                        }
                                        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                                        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                                    >
                                        {theme === 'dark' ? '☀️' : '🌙'}
                                    </button>
                                </div>
                            </div>
                        </header>

                        <nav className="workspace-nav">
                            <button
                                type="button"
                                className={
                                    workspaceView ===
                                    'chat'
                                        ? 'active'
                                        : ''
                                }
                                onClick={() =>
                                    setWorkspaceView(
                                        'chat',
                                    )
                                }
                            >
                                Chat
                            </button>

                            <button
                                type="button"
                                className={
                                    workspaceView ===
                                    'overview'
                                        ? 'active'
                                        : ''
                                }
                                onClick={() =>
                                    setWorkspaceView(
                                        'overview',
                                    )
                                }
                            >
                                Overview
                            </button>

                            <button
                                type="button"
                                className={
                                    workspaceView ===
                                    'code'
                                        ? 'active'
                                        : ''
                                }
                                onClick={() =>
                                    setWorkspaceView(
                                        'code',
                                    )
                                }
                            >
                                Code Base
                            </button>

                            <button
                                type="button"
                                className={
                                    workspaceView ===
                                    'mcps'
                                        ? 'active'
                                        : ''
                                }
                                onClick={() =>
                                    setWorkspaceView(
                                        'mcps',
                                    )
                                }
                            >
                                MCPs
                            </button>

                            {workspaceView ===
                                'chat' && (
                                <button
                                    type="button"
                                    className="new-chat-button"
                                    onClick={
                                        clearChat
                                    }
                                    disabled={
                                        sending ||
                                        messages.length ===
                                            0
                                    }
                                >
                                    + Clear chat
                                </button>
                            )}
                        </nav>

                        {error && (
                            <div className="error">
                                {error}
                            </div>
                        )}


                        {/* --------------------------------------------------
                            Chat
                        -------------------------------------------------- */}

                        {workspaceView ===
                            'chat' && (
                            <>
                                <section className="conversation">
                                    {messages.length ===
                                    0 ? (
                                        <div className="welcome">
                                            <div className="agent-avatar">
                                                <img
                                                    src="/agent-kitty-icon.png"
                                                    alt="Agent Kitty"
                                                />
                                            </div>

                                            <h1>
                                                {prettyName(
                                                    selectedWorkspace.name,
                                                )}
                                            </h1>

                                            <p>
                                                Agent ready
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="messages">
                                            {messages.map(
                                                (
                                                    message,
                                                ) => (
                                                    <div
                                                        key={
                                                            message.id
                                                        }
                                                        className={`message ${message.role}`}
                                                    >
                                                        <div className="message-role">
                                                            {message.role ===
                                                            'user'
                                                                ? 'You'
                                                                : prettyName(
                                                                      selectedWorkspace.name,
                                                                  )}
                                                        </div>

                                                        {message.handoff && (
                                                            <div
                                                                className="message-handoff"
                                                                title={
                                                                    message.handoff.mode ===
                                                                    'summary'
                                                                        ? 'Sent a handoff summary and recent turns to this agent'
                                                                        : 'Sent the recent transcript to this agent'
                                                                }
                                                            >
                                                                {message.handoff.reason ===
                                                                'restart'
                                                                    ? 'Earlier conversation restored after restart'
                                                                    : `Context carried over from ${message.handoff.from.join(
                                                                          ', ',
                                                                      )}`}
                                                            </div>
                                                        )}

                                                        <div className="message-content">
                                                            {message.role ===
                                                            'assistant' ? (
                                                                message.content ? (
                                                                    <ReactMarkdown
                                                                        remarkPlugins={[
                                                                            remarkGfm,
                                                                        ]}
                                                                        rehypePlugins={[
                                                                            rehypeHighlight,
                                                                        ]}
                                                                    >
                                                                        {
                                                                            message.content
                                                                        }
                                                                    </ReactMarkdown>
                                                                ) : sending ? (
                                                                    <span className="thinking">
                                                                        Thinking…
                                                                    </span>
                                                                ) : null
                                                            ) : (
                                                                message.content
                                                            )}
                                                        </div>

                                                        {message.role ===
                                                            'assistant' &&
                                                            message.usage && (
                                                                <div
                                                                    className="message-usage"
                                                                    title="Usage reported by the harness for this response"
                                                                >
                                                                    {usageParts(
                                                                        message.usage,
                                                                    ).join(
                                                                        ' · ',
                                                                    )}
                                                                </div>
                                                            )}
                                                    </div>
                                                ),
                                            )}

                                            {currentActivities.length >
                                                0 && (
                                                <details
                                                    className="activity-panel"
                                                    open={
                                                        sending
                                                    }
                                                >
                                                    <summary>
                                                        <span>
                                                            {sending
                                                                ? 'Working'
                                                                : 'Activity'}
                                                        </span>

                                                        <span className="activity-count">
                                                            {
                                                                currentActivities.length
                                                            }
                                                        </span>
                                                    </summary>

                                                    <div className="activity-list">
                                                        {currentActivities.map(
                                                            (
                                                                activity,
                                                            ) => (
                                                                <div
                                                                    className={`activity-item ${activity.status ?? ''}`}
                                                                    key={
                                                                        activity.toolCallId
                                                                    }
                                                                >
                                                                    <span className="activity-icon">
                                                                        {toolIcon(
                                                                            activity.kind ??
                                                                                'other',
                                                                            activity.status ??
                                                                                'in_progress',
                                                                        )}
                                                                    </span>

                                                                    <div className="activity-body">
                                                                        <div className="activity-title">
                                                                            {activity.title ??
                                                                                'Using tool'}
                                                                        </div>

                                                                        {activity.locations &&
                                                                            activity
                                                                                .locations
                                                                                .length >
                                                                                0 && (
                                                                                <div className="activity-location">
                                                                                    {
                                                                                        activity
                                                                                            .locations[0]
                                                                                    }
                                                                                </div>
                                                                            )}
                                                                    </div>

                                                                    <span className="activity-status">
                                                                        {activity.status ??
                                                                            ''}
                                                                    </span>
                                                                </div>
                                                            ),
                                                        )}
                                                    </div>
                                                </details>
                                            )}

                                            {pendingPermission && (
                                                <div className="permission-card">
                                                    <div className="permission-title">
                                                        Permission required
                                                    </div>

                                                    <div className="permission-description">
                                                        {
                                                            pendingPermission.title
                                                        }
                                                    </div>

                                                    <div className="permission-actions">
                                                        {pendingPermission.options.map(
                                                            (
                                                                option,
                                                            ) => (
                                                                <button
                                                                    type="button"
                                                                    key={
                                                                        option.optionId
                                                                    }
                                                                    onClick={() =>
                                                                        answerPermission(
                                                                            option.optionId,
                                                                        )
                                                                    }
                                                                    className={`permission-option ${option.kind}`}
                                                                >
                                                                    {
                                                                        option.name
                                                                    }
                                                                </button>
                                                            ),
                                                        )}
                                                    </div>
                                                </div>
                                            )}

                                            <div
                                                ref={
                                                    conversationEndRef
                                                }
                                            />
                                        </div>
                                    )}
                                </section>

                                <form
                                    className="composer"
                                    onSubmit={
                                        sendPrompt
                                    }
                                >
                                    <div
                                        className="composer-resize-handle"
                                        role="separator"
                                        aria-orientation="horizontal"
                                        aria-label="Drag to resize the message box"
                                        title="Drag to resize, double-click to reset"
                                        onPointerDown={
                                            startComposerResize
                                        }
                                        onDoubleClick={
                                            resetComposerHeight
                                        }
                                    />

                                    {sending && (
                                        <div
                                            className="kitty-thinking"
                                            title="Agent is working"
                                            aria-label="Agent is working"
                                        >
                                            🐾
                                        </div>
                                    )}

                                    <input
                                        ref={
                                            fileInputRef
                                        }
                                        type="file"
                                        multiple
                                        hidden
                                        accept=".log,.txt,.json,.xml,.csv,.md,.yaml,.yml,.js,.jsx,.ts,.tsx,.php,.py,.java,.sql,.sh,.zsh,.html,.css"
                                        onChange={(
                                            event,
                                        ) => {
                                            const files =
                                                Array.from(
                                                    event
                                                        .target
                                                        .files ??
                                                        [],
                                                );

                                            setSelectedFiles(
                                                files.slice(
                                                    0,
                                                    5,
                                                ),
                                            );

                                            event.target.value =
                                                '';
                                        }}
                                    />

                                    <button
                                        type="button"
                                        className="attachment-button"
                                        title="Attach files"
                                        aria-label="Attach files"
                                        onClick={() =>
                                            fileInputRef.current?.click()
                                        }
                                        disabled={
                                            sending
                                        }
                                    >
                                        📎
                                    </button>

                                    {selectedFiles.length >
                                        0 && (
                                        <div className="selected-attachments">
                                            {selectedFiles.map(
                                                (
                                                    file,
                                                    index,
                                                ) => (
                                                    <div
                                                        className="attachment-chip"
                                                        key={`${file.name}-${index}`}
                                                    >
                                                        <span>
                                                            📄{' '}
                                                            {
                                                                file.name
                                                            }
                                                        </span>

                                                        <button
                                                            type="button"
                                                            title="Remove attachment"
                                                            aria-label={`Remove ${file.name}`}
                                                            onClick={() =>
                                                                setSelectedFiles(
                                                                    (
                                                                        current,
                                                                    ) =>
                                                                        current.filter(
                                                                            (
                                                                                _,
                                                                                fileIndex,
                                                                            ) =>
                                                                                fileIndex !==
                                                                                index,
                                                                        ),
                                                                )
                                                            }
                                                        >
                                                            ×
                                                        </button>
                                                    </div>
                                                ),
                                            )}
                                        </div>
                                    )}

                                    <textarea
                                        ref={
                                            composerTextareaRef
                                        }
                                        style={
                                            composerHeight
                                                ? {
                                                      height: composerHeight,
                                                  }
                                                : undefined
                                        }
                                        value={
                                            prompt
                                        }
                                        onChange={(
                                            event,
                                        ) =>
                                            setPrompt(
                                                event
                                                    .target
                                                    .value,
                                            )
                                        }
                                        onKeyDown={(
                                            event,
                                        ) => {
                                            if (
                                                event.key ===
                                                    'Enter' &&
                                                !event.shiftKey
                                            ) {
                                                event.preventDefault();

                                                event.currentTarget.form
                                                    ?.requestSubmit();
                                            }
                                        }}
                                        placeholder={`Ask ${prettyName(
                                            selectedWorkspace.name,
                                        )}...`}
                                        disabled={
                                            sending
                                        }
                                    />

                                    <button
                                        type="submit"
                                        disabled={
                                            sending ||
                                            (
                                                !prompt.trim() &&
                                                selectedFiles.length ===
                                                    0
                                            )
                                        }
                                    >
                                        Send
                                    </button>
                                </form>
                            </>
                        )}


                        {/* --------------------------------------------------
                            Overview
                        -------------------------------------------------- */}

                        {workspaceView ===
                            'overview' && (
                            <section className="workspace-page">
                                <div className="workspace-page-header">
                                    <div>
                                        <h1>
                                            Overview
                                        </h1>

                                        <p>
                                            Workspace instructions and context.
                                        </p>
                                    </div>

                                    <span>
                                        AGENTS.md
                                    </span>
                                </div>

                                <article className="agents-document">
                                    {overviewByWorkspace[
                                        selectedWorkspace
                                            .id
                                    ] !==
                                    undefined ? (
                                        <ReactMarkdown
                                            remarkPlugins={[
                                                remarkGfm,
                                            ]}
                                            rehypePlugins={[
                                                rehypeHighlight,
                                            ]}
                                        >
                                            {
                                                overviewByWorkspace[
                                                    selectedWorkspace
                                                        .id
                                                ]
                                            }
                                        </ReactMarkdown>
                                    ) : (
                                        <p>
                                            Loading…
                                        </p>
                                    )}
                                </article>
                            </section>
                        )}


                        {/* --------------------------------------------------
                            Code Base
                        -------------------------------------------------- */}

                        {workspaceView ===
                            'code' && (
                            <section className="workspace-page">
                                <div className="workspace-page-header">
                                    <div>
                                        <h1>
                                            Code Base
                                        </h1>

                                        <p>
                                            Repositories available to this agent.
                                        </p>
                                    </div>

                                    {reposByWorkspace[
                                        selectedWorkspace
                                            .id
                                    ] && (
                                        <span>
                                            {
                                                reposByWorkspace[
                                                    selectedWorkspace
                                                        .id
                                                ].length
                                            }{' '}
                                            repositories
                                        </span>
                                    )}
                                </div>

                                {reposByWorkspace[
                                    selectedWorkspace
                                        .id
                                ] ? (
                                    <div className="repo-grid">
                                        {reposByWorkspace[
                                            selectedWorkspace
                                                .id
                                        ].map(
                                            (
                                                repo,
                                            ) => (
                                                <div
                                                    className="repo-card"
                                                    key={
                                                        repo.name
                                                    }
                                                >
                                                    <div className="repo-icon">
                                                        &lt;/&gt;
                                                    </div>

                                                    <div className="repo-details">
                                                        <div className="repo-name">
                                                            {
                                                                repo.name
                                                            }
                                                        </div>

                                                        <div className="repo-path">
                                                            {
                                                                repo.path
                                                            }
                                                        </div>

                                                        <div className="repo-badges">
                                                            <span
                                                                className={`repo-badge branch ${
                                                                    repo.branch !==
                                                                    'master'
                                                                        ? 'branch-warning'
                                                                        : ''
                                                                }`}
                                                            >
                                                                ⎇{' '}
                                                                {
                                                                    repo.branch
                                                                }
                                                            </span>

                                                            <span className="repo-badge">
                                                                Git repository
                                                            </span>

                                                            {repo.hasAgentsFile && (
                                                                <span className="repo-badge agent">
                                                                    AGENTS.md
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            ),
                                        )}
                                    </div>
                                ) : (
                                    <p>
                                        Loading repositories…
                                    </p>
                                )}
                            </section>
                        )}


                        {/* --------------------------------------------------
                            MCPs
                        -------------------------------------------------- */}

                        {workspaceView ===
                            'mcps' && (
                            <section className="workspace-page">
                                <div className="workspace-page-header">
                                    <div>
                                        <h1>
                                            MCPs
                                        </h1>

                                        <p>
                                            MCP servers available to this agent.
                                        </p>
                                    </div>

                                    <div className="mcp-header-actions">
                                        {mcpsByWorkspace[
                                            selectedWorkspace
                                                .id
                                        ] && (
                                            <span className="mcp-server-count">
                                                {
                                                    mcpsByWorkspace[
                                                        selectedWorkspace
                                                            .id
                                                    ]
                                                        .length
                                                }{' '}
                                                servers
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {mcpsByWorkspace[
                                    selectedWorkspace
                                        .id
                                ] ? (
                                    <div className="mcp-sections">
                                        <McpGroup
                                            title="Built-in"
                                            description={`Provided directly by ${harnessLabel}.`}
                                            servers={mcpsByWorkspace[
                                                selectedWorkspace
                                                    .id
                                            ].filter(
                                                (
                                                    server,
                                                ) =>
                                                    server.source ===
                                                    'builtin',
                                            )}
                                            refreshingMcp={
                                                refreshingMcp
                                            }
                                            onRefresh={
                                                refreshMcp
                                            }
                                        />

                                        <McpGroup
                                            title="Shared"
                                            description="Available across all agents."
                                            servers={mcpsByWorkspace[
                                                selectedWorkspace
                                                    .id
                                            ].filter(
                                                (
                                                    server,
                                                ) =>
                                                    server.source ===
                                                    'shared',
                                            )}
                                            refreshingMcp={
                                                refreshingMcp
                                            }
                                            onRefresh={
                                                refreshMcp
                                            }
                                        />

                                        <McpGroup
                                            title="Workspace"
                                            description={`Configured specifically for ${prettyName(
                                                selectedWorkspace.name,
                                            )}.`}
                                            servers={mcpsByWorkspace[
                                                selectedWorkspace
                                                    .id
                                            ].filter(
                                                (
                                                    server,
                                                ) =>
                                                    server.source ===
                                                    'workspace',
                                            )}
                                            refreshingMcp={
                                                refreshingMcp
                                            }
                                            onRefresh={
                                                refreshMcp
                                            }
                                        />
                                    </div>
                                ) : (
                                    <p>
                                        Loading MCP servers…
                                    </p>
                                )}
                            </section>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}

export default App;