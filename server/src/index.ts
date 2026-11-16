import express, {
    type NextFunction,
    type Request,
    type Response,
} from 'express';

import multer from 'multer';

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { WorkspaceAgent } from './WorkspaceAgent.js';
import {
    configureHarnessRoot,
    getHarness,
    isHarnessId,
    listHarnesses,
    loadDisabledMcpServers,
    loadHarnessId,
    saveHarnessId,
    toAcpMcpServers,
    type HarnessId,
} from './harness.js';
import {
    cancelCodexLogin,
    getCodexLogin,
    logoutCodex,
    readCodexAccount,
    startCodexLogin,
} from './codexAuth.js';
import {
    cancelKiroLogin,
    getKiroLogin,
    kiroIdentityCenterDefaults,
    logoutKiro,
    readKiroAccount,
    startKiroLogin,
    validateIdentityCenter,
} from './kiroAuth.js';
import {
    buildHandoff,
    clearConversation,
    configureHandoffStore,
    hasPendingSummary,
    loadConversation,
    recordTurn,
    requestSummary,
    seedConversation,
    waitForPendingSummary,
} from './handoff.js';


/*
 * --------------------------------------------------------------------------
 * Application setup
 * --------------------------------------------------------------------------
 */

const app = express();

app.use(express.json());

const PORT =
    Number(process.env.PORT ?? 8787);

const COPILOT_ROOT =
    process.env.COPILOT_ROOT ??
    path.resolve(
        process.cwd(),
        '..',
    );

const agents =
    new Map<
        string,
        WorkspaceAgent
    >();

/*
 * The active harness is global: every agent runs on
 * the same one, and the choice persists in
 * .agent-kitty/config.json.
 */
configureHarnessRoot(
    COPILOT_ROOT,
);

configureHandoffStore(
    COPILOT_ROOT,
);

let activeHarnessId: HarnessId =
    await loadHarnessId(
        COPILOT_ROOT,
    );

/*
 * Agents from inactive harnesses stay parked so that
 * switching back resumes their session. They are
 * stopped after AGENT_KITTY_PARK_MINUTES idle (0
 * stops them as soon as any handoff summary is done).
 */
const parkedAgents =
    new Map<
        HarnessId,
        Map<string, WorkspaceAgent>
    >();

const parkTimers =
    new Map<
        WorkspaceAgent,
        NodeJS.Timeout
    >();

const PARK_MS =
    Math.max(
        0,
        Number(
            process.env
                .AGENT_KITTY_PARK_MINUTES ??
                30,
        ) || 0,
    ) * 60_000;

function scheduleParkedStop(
    harnessId: HarnessId,
    workspaceId: string,
    agent: WorkspaceAgent,
    delayMs: number,
) {
    const timer =
        setTimeout(() => {
            parkTimers.delete(agent);

            const parked =
                parkedAgents.get(
                    harnessId,
                );

            if (
                parked?.get(
                    workspaceId,
                ) !== agent
            ) {
                return;
            }

            /*
             * Still writing a handoff summary.
             */
            if (agent.isBusy()) {
                scheduleParkedStop(
                    harnessId,
                    workspaceId,
                    agent,
                    15_000,
                );

                return;
            }

            agent.stop();
            parked.delete(workspaceId);

            console.log(
                `Stopped parked ${harnessId} agent for ${workspaceId}`,
            );
        }, delayMs);

    timer.unref();

    parkTimers.set(
        agent,
        timer,
    );
}

function unparkTimer(
    agent: WorkspaceAgent,
) {
    clearTimeout(
        parkTimers.get(agent),
    );

    parkTimers.delete(agent);
}

function stopParkedAgents(
    filter: (
        harnessId: HarnessId,
        workspaceId: string,
        agent: WorkspaceAgent,
    ) => boolean,
) {
    for (
        const [harnessId, parked] of
        parkedAgents
    ) {
        for (
            const [workspaceId, agent] of
            parked
        ) {
            if (
                filter(
                    harnessId,
                    workspaceId,
                    agent,
                )
            ) {
                unparkTimer(agent);
                agent.stop();
                parked.delete(workspaceId);
            }
        }
    }
}

const execFileAsync =
    promisify(execFile);


/*
 * --------------------------------------------------------------------------
 * Frontend paths
 * --------------------------------------------------------------------------
 */

const __filename =
    fileURLToPath(
        import.meta.url,
    );

const __dirname =
    path.dirname(__filename);

const WEB_DIST =
    path.resolve(
        __dirname,
        '../../web/dist',
    );


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

type Repository = {
    name: string;
    path: string;
    branch: string;
    hasAgentsFile: boolean;
};

type McpSource =
    | 'shared'
    | 'workspace'
    | 'builtin'
    | 'unknown';

type McpServerStatus = {
    name: string;
    status: string;
    source: McpSource;
};

type McpConfig = {
    mcpServers?: Record<
        string,
        unknown
    >;
};


/*
 * --------------------------------------------------------------------------
 * General helpers
 * --------------------------------------------------------------------------
 */

function routeParam(
    value:
        | string
        | string[]
        | undefined,
    name: string,
): string {
    const result =
        Array.isArray(value)
            ? value[0]
            : value;

    if (!result) {
        throw new Error(
            `Missing route parameter: ${name}`,
        );
    }

    return result;
}

function errorMessage(
    error: unknown,
    fallback: string,
): string {
    return error instanceof Error
        ? error.message
        : fallback;
}

async function exists(
    filePath: string,
): Promise<boolean> {
    try {
        await fs.access(filePath);

        return true;
    } catch {
        return false;
    }
}


/*
 * --------------------------------------------------------------------------
 * Workspace discovery
 * --------------------------------------------------------------------------
 */

async function discoverWorkspaces():
    Promise<Workspace[]> {
    const entries =
        await fs.readdir(
            COPILOT_ROOT,
            {
                withFileTypes: true,
            },
        );

    const workspaces:
        Workspace[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        if (
            [
                'shared',
                'agent-kitty',
            ].includes(
                entry.name,
            )
        ) {
            continue;
        }

        const workspacePath =
            path.join(
                COPILOT_ROOT,
                entry.name,
            );

        const [
            hasAgentsFile,
            hasStartScript,
            hasMcpConfig,
        ] = await Promise.all([
            exists(
                path.join(
                    workspacePath,
                    'AGENTS.md',
                ),
            ),

            exists(
                path.join(
                    workspacePath,
                    'start',
                ),
            ),

            exists(
                path.join(
                    workspacePath,
                    'mcp.json',
                ),
            ),
        ]);

        /*
         * Only directories matching our
         * Agent Kitty workspace convention
         * become agents.
         */
        if (
            !hasAgentsFile ||
            !hasStartScript
        ) {
            continue;
        }

        workspaces.push({
            id: entry.name,
            name: entry.name,
            path: workspacePath,
            hasAgentsFile,
            hasMcpConfig,
            hasStartScript,
        });
    }

    return workspaces.sort(
        (a, b) =>
            a.name.localeCompare(
                b.name,
            ),
    );
}

async function findWorkspace(
    id: string,
): Promise<
    Workspace | undefined
> {
    const workspaces =
        await discoverWorkspaces();

    return workspaces.find(
        (workspace) =>
            workspace.id === id,
    );
}

function getOrCreateAgent(
    workspace: Workspace,
): WorkspaceAgent {
    const existing =
        agents.get(
            workspace.id,
        );

    if (existing) {
        return existing;
    }

    const agent =
        new WorkspaceAgent(
            workspace.path,
            workspace.name,
            getHarness(
                activeHarnessId,
            ),
            () =>
                getAcpMcpServers(
                    workspace,
                ),
        );

    agents.set(
        workspace.id,
        agent,
    );

    return agent;
}


/*
 * --------------------------------------------------------------------------
 * Git helpers
 * --------------------------------------------------------------------------
 */

async function getGitBranch(
    repoPath: string,
): Promise<string> {
    try {
        const { stdout } =
            await execFileAsync(
                'git',
                [
                    '-C',
                    repoPath,
                    'branch',
                    '--show-current',
                ],
            );

        const branch =
            stdout.trim();

        if (branch) {
            return branch;
        }

        /*
         * Detached HEAD.
         */
        const {
            stdout: commit,
        } =
            await execFileAsync(
                'git',
                [
                    '-C',
                    repoPath,
                    'rev-parse',
                    '--short',
                    'HEAD',
                ],
            );

        return (
            `detached @ ${commit.trim()}`
        );
    } catch {
        return 'unknown';
    }
}

async function discoverRepositories(
    workspace: Workspace,
): Promise<Repository[]> {
    const entries =
        await fs.readdir(
            workspace.path,
            {
                withFileTypes: true,
            },
        );

    const repos:
        Repository[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const repoPath =
            path.join(
                workspace.path,
                entry.name,
            );

        const gitPath =
            path.join(
                repoPath,
                '.git',
            );

        if (
            !(await exists(gitPath))
        ) {
            continue;
        }

        const [
            branch,
            hasAgentsFile,
        ] = await Promise.all([
            getGitBranch(
                repoPath,
            ),

            exists(
                path.join(
                    repoPath,
                    'AGENTS.md',
                ),
            ),
        ]);

        repos.push({
            name: entry.name,
            path: repoPath,
            branch,
            hasAgentsFile,
        });
    }

    return repos.sort(
        (a, b) =>
            a.name.localeCompare(
                b.name,
            ),
    );
}


/*
 * --------------------------------------------------------------------------
 * Attachment handling
 * --------------------------------------------------------------------------
 */

const TEXT_ATTACHMENT_EXTENSIONS =
    new Set([
        '.log',
        '.txt',
        '.json',
        '.xml',
        '.csv',
        '.md',
        '.yaml',
        '.yml',
        '.js',
        '.jsx',
        '.ts',
        '.tsx',
        '.php',
        '.py',
        '.java',
        '.sql',
        '.sh',
        '.zsh',
        '.html',
        '.css',
    ]);

const upload =
    multer({
        storage:
            multer.memoryStorage(),

        limits: {
            fileSize:
                5 * 1024 * 1024,

            files: 5,
        },

        fileFilter: (
            _req,
            file,
            callback,
        ) => {
            const extension =
                path.extname(
                    file.originalname,
                )
                    .toLowerCase();

            if (
                TEXT_ATTACHMENT_EXTENSIONS.has(
                    extension,
                )
            ) {
                callback(
                    null,
                    true,
                );

                return;
            }

            callback(
                new Error(
                    `Unsupported attachment type: ${
                        extension ||
                        file.originalname
                    }`,
                ),
            );
        },
    });

function buildAgentPrompt(
    prompt: string,
    attachments:
        Express.Multer.File[],
): string {
    let agentPrompt =
        prompt.trim();

    if (
        attachments.length === 0
    ) {
        return agentPrompt;
    }

    if (!agentPrompt) {
        agentPrompt =
            'Please review the attached file(s).';
    }

    const attachmentText =
        attachments
            .map(
                (file) => {
                    const content =
                        file.buffer.toString(
                            'utf8',
                        );

                    return [
                        '',
                        `--- Attached file: ${file.originalname} ---`,
                        content,
                        `--- End attached file: ${file.originalname} ---`,
                    ].join('\n');
                },
            )
            .join('\n');

    return (
        `${agentPrompt}\n\n` +
        'The user attached the following files for context. ' +
        'Read and use them when answering.' +
        attachmentText
    );
}


/*
 * --------------------------------------------------------------------------
 * MCP helpers
 * --------------------------------------------------------------------------
 */

async function readMcpConfig(
    filePath: string,
): Promise<
    Record<string, unknown>
> {
    try {
        const raw =
            await fs.readFile(
                filePath,
                'utf8',
            );

        const parsed =
            JSON.parse(
                raw,
            ) as McpConfig;

        return (
            parsed.mcpServers ??
            {}
        );
    } catch {
        return {};
    }
}

async function readWorkspaceMcpConfigs(
    workspace: Workspace,
): Promise<{
    sharedServers: Record<string, unknown>;
    workspaceServers: Record<string, unknown>;
}> {
    const sharedConfigPath =
        path.join(
            COPILOT_ROOT,
            '.agent-kitty',
            'shared',
            'mcp.json',
        );

    const workspaceConfigPath =
        path.join(
            workspace.path,
            'mcp.json',
        );

    const [
        sharedServers,
        workspaceServers,
    ] = await Promise.all([
        readMcpConfig(
            sharedConfigPath,
        ),

        readMcpConfig(
            workspaceConfigPath,
        ),
    ]);

    return {
        sharedServers,
        workspaceServers,
    };
}

/*
 * Shared plus workspace servers in ACP form, for
 * harnesses that receive MCP servers over ACP.
 * Workspace entries win on a name clash.
 */
async function getAcpMcpServers(
    workspace: Workspace,
): Promise<any[]> {
    const {
        sharedServers,
        workspaceServers,
    } = await readWorkspaceMcpConfigs(
        workspace,
    );

    const disabled =
        await loadDisabledMcpServers(
            COPILOT_ROOT,
            activeHarnessId,
        );

    const enabled =
        Object.fromEntries(
            Object.entries({
                ...sharedServers,
                ...workspaceServers,
            }).filter(
                ([name]) =>
                    !disabled.has(
                        name,
                    ),
            ),
        );

    return toAcpMcpServers(
        enabled,
        workspace.path,
    );
}

async function getMcpSources(
    workspace: Workspace,
): Promise<
    Map<string, McpSource>
> {
    const {
        sharedServers,
        workspaceServers,
    } = await readWorkspaceMcpConfigs(
        workspace,
    );

    const sourceByName =
        new Map<
            string,
            McpSource
        >();

    for (
        const name of
        Object.keys(
            sharedServers,
        )
    ) {
        sourceByName.set(
            name,
            'shared',
        );
    }

    for (
        const name of
        Object.keys(
            workspaceServers,
        )
    ) {
        sourceByName.set(
            name,
            'workspace',
        );
    }

    return sourceByName;
}

/*
 * Current Copilot CLI examples:
 *
 * - atlassian (connected): 17.0k
 * - github-mcp-server (connected, builtin): 7.8k
 * - lenses (pending)
 */
const MCP_STATUS_PATTERN =
    /^- (.+?) \((.+?)\)(?::\s*(.+))?$/;

function parseMcpStatus(
    output: string,
    sourceByName:
        Map<string, McpSource>,
): McpServerStatus[] {
    return output
        .split('\n')
        .map(
            (line) =>
                line.trim(),
        )
        .filter(
            (line) =>
                line.startsWith(
                    '- ',
                ),
        )
        .map(
            (
                line,
            ):
                | McpServerStatus
                | null => {
                const match =
                    line.match(
                        MCP_STATUS_PATTERN,
                    );

                if (!match) {
                    return null;
                }

                const name =
                    match[1];

                const stateParts =
                    match[2]
                        .split(',')
                        .map(
                            (part) =>
                                part.trim(),
                        );

                const status =
                    stateParts[0];

                const builtin =
                    stateParts.includes(
                        'builtin',
                    );

                return {
                    name,
                    status,

                    source:
                        builtin
                            ? 'builtin'
                            : sourceByName.get(
                                  name,
                              ) ??
                              'unknown',
                };
            },
        )
        .filter(
            (
                server,
            ): server is
                McpServerStatus =>
                server !== null,
        );
}

async function getWorkspaceMcpStatus(
    workspace: Workspace,
): Promise<
    McpServerStatus[]
> {
    const sourceByName =
        await getMcpSources(
            workspace,
        );

    const agent =
        getOrCreateAgent(
            workspace,
        );

    /*
     * Harnesses without a parseable "/mcp list"
     * report the servers agent-kitty hands them.
     */
    if (
        !agent.supportsMcpListCommand
    ) {
        const disabled =
            await loadDisabledMcpServers(
                COPILOT_ROOT,
                activeHarnessId,
            );

        return [
            ...sourceByName.entries(),
        ].map(
            ([name, source]) => ({
                name,
                status:
                    disabled.has(
                        name,
                    )
                        ? 'disabled'
                        : 'configured',
                source,
            }),
        );
    }

    const output =
        await agent.getMcpStatusText();

    return parseMcpStatus(
        output,
        sourceByName,
    );
}


/*
 * --------------------------------------------------------------------------
 * Harness
 * --------------------------------------------------------------------------
 */

function harnessResponse() {
    return {
        current:
            activeHarnessId,
        harnesses:
            listHarnesses(),
    };
}

app.get(
    '/api/harness',
    (_req, res) => {
        res.json(
            harnessResponse(),
        );
    },
);

app.post(
    '/api/harness',
    async (req, res) => {
        try {
            const requested =
                req.body?.harness;

            if (
                !isHarnessId(
                    requested,
                )
            ) {
                res.status(
                    400,
                ).json({
                    error:
                        `Unknown harness: ${String(requested)}`,
                });

                return;
            }

            if (
                requested ===
                activeHarnessId
            ) {
                res.json(
                    harnessResponse(),
                );

                return;
            }

            const availability =
                getHarness(
                    requested,
                ).availability();

            if (
                !availability.available
            ) {
                res.status(
                    400,
                ).json({
                    error:
                        `${getHarness(requested).label} is not available: ${availability.detail ?? 'unknown reason'}`,
                });

                return;
            }

            /*
             * An agent writing a handoff summary is
             * busy internally, not with user work.
             */
            const busy =
                [
                    ...agents,
                ].some(
                    ([workspaceId, agent]) =>
                        agent.isBusy() &&
                        !hasPendingSummary(
                            workspaceId,
                        ),
                );

            if (busy) {
                res.status(
                    409,
                ).json({
                    error:
                        'An agent is still working. Wait for it to finish before switching harness.',
                });

                return;
            }

            await saveHarnessId(
                COPILOT_ROOT,
                requested,
            );

            const previousHarnessId =
                activeHarnessId;

            const previousLabel =
                getHarness(
                    previousHarnessId,
                ).label;

            activeHarnessId =
                requested;

            /*
             * Park the outgoing agents (after asking
             * each for a handoff summary) and resume
             * any agents parked on the new harness.
             */
            const outgoing =
                parkedAgents.get(
                    previousHarnessId,
                ) ??
                new Map<
                    string,
                    WorkspaceAgent
                >();

            for (
                const [workspaceId, agent] of
                agents
            ) {
                requestSummary(
                    workspaceId,
                    agent,
                    previousLabel,
                );

                outgoing.set(
                    workspaceId,
                    agent,
                );

                scheduleParkedStop(
                    previousHarnessId,
                    workspaceId,
                    agent,
                    PARK_MS,
                );
            }

            parkedAgents.set(
                previousHarnessId,
                outgoing,
            );

            agents.clear();

            const resumed =
                parkedAgents.get(
                    requested,
                );

            if (resumed) {
                for (
                    const [workspaceId, agent] of
                    resumed
                ) {
                    unparkTimer(agent);

                    agents.set(
                        workspaceId,
                        agent,
                    );
                }

                parkedAgents.delete(
                    requested,
                );
            }

            console.log(
                `Harness switched to ${requested}`,
            );

            res.json(
                harnessResponse(),
            );
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to switch harness',
                    ),
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * Codex account (Agent Kitty's own CODEX_HOME)
 * --------------------------------------------------------------------------
 */

/*
 * Idle agents on a harness restart so their next
 * session uses the new credentials.
 */
function restartIdleAgents(target: HarnessId) {
    stopParkedAgents(
        (harnessId, _workspaceId, agent) =>
            harnessId === target &&
            !agent.isBusy(),
    );

    if (activeHarnessId !== target) {
        return;
    }

    for (const [id, agent] of agents) {
        if (!agent.isBusy()) {
            agent.stop();
            agents.delete(id);
        }
    }
}

async function codexAuthResponse() {
    return {
        account:
            await readCodexAccount(),
        login:
            getCodexLogin(),
    };
}

app.get(
    '/api/harness/codex/auth',
    async (_req, res) => {
        try {
            res.json(
                await codexAuthResponse(),
            );
        } catch (error) {
            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to read Codex account',
                    ),
            });
        }
    },
);

app.post(
    '/api/harness/codex/login',
    async (req, res) => {
        try {
            const mode =
                req.body?.mode === 'browser'
                    ? 'browser'
                    : 'device';

            await startCodexLogin(
                mode,
                (login) => {
                    console.log(
                        `Codex sign-in ${login.status}`,
                    );

                    if (
                        login.status ===
                        'succeeded'
                    ) {
                        restartIdleAgents('codex');
                    }
                },
            );

            res.json(
                await codexAuthResponse(),
            );
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to start Codex sign-in',
                    ),
            });
        }
    },
);

app.post(
    '/api/harness/codex/login/cancel',
    async (_req, res) => {
        cancelCodexLogin();

        res.json(
            await codexAuthResponse(),
        );
    },
);

app.post(
    '/api/harness/codex/logout',
    async (_req, res) => {
        try {
            if (
                activeHarnessId ===
                    'codex' &&
                [
                    ...agents.values(),
                ].some(
                    (agent) =>
                        agent.isBusy(),
                )
            ) {
                res.status(
                    409,
                ).json({
                    error:
                        'An agent is still working. Wait for it to finish before signing out.',
                });

                return;
            }

            await logoutCodex();

            restartIdleAgents('codex');

            console.log(
                'Codex signed out',
            );

            res.json(
                await codexAuthResponse(),
            );
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to sign out of Codex',
                    ),
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * Kiro account (the user's kiro-cli login)
 * --------------------------------------------------------------------------
 */

async function kiroAuthResponse() {
    return {
        account:
            await readKiroAccount(),
        login:
            getKiroLogin(),
        identityCenterDefaults:
            kiroIdentityCenterDefaults(),
    };
}

function kiroAgentBusy(): boolean {
    return (
        activeHarnessId === 'kiro' &&
        [
            ...agents.values(),
        ].some(
            (agent) =>
                agent.isBusy(),
        )
    );
}

app.get(
    '/api/harness/kiro/auth',
    async (_req, res) => {
        try {
            res.json(
                await kiroAuthResponse(),
            );
        } catch (error) {
            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to read Kiro account',
                    ),
            });
        }
    },
);

app.post(
    '/api/harness/kiro/login',
    async (req, res) => {
        try {
            if (
                kiroAgentBusy()
            ) {
                res.status(
                    409,
                ).json({
                    error:
                        'An agent is still working. Wait for it to finish before signing in.',
                });

                return;
            }

            const mode =
                req.body?.mode === 'device'
                    ? 'device'
                    : 'browser';

            const identityCenter =
                validateIdentityCenter(
                    req.body
                        ?.identityCenter,
                );

            await startKiroLogin(
                mode,
                identityCenter,
                (login) => {
                    console.log(
                        `Kiro sign-in ${login.status}`,
                    );

                    if (
                        login.status ===
                        'succeeded'
                    ) {
                        restartIdleAgents('kiro');
                    }
                },
            );

            res.json(
                await kiroAuthResponse(),
            );
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                400,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to start Kiro sign-in',
                    ),
            });
        }
    },
);

app.post(
    '/api/harness/kiro/login/cancel',
    async (_req, res) => {
        cancelKiroLogin();

        res.json(
            await kiroAuthResponse(),
        );
    },
);

app.post(
    '/api/harness/kiro/logout',
    async (_req, res) => {
        try {
            if (
                kiroAgentBusy()
            ) {
                res.status(
                    409,
                ).json({
                    error:
                        'An agent is still working. Wait for it to finish before signing out.',
                });

                return;
            }

            await logoutKiro();

            restartIdleAgents('kiro');

            console.log(
                'Kiro signed out',
            );

            res.json(
                await kiroAuthResponse(),
            );
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to sign out of Kiro',
                    ),
            });
        }
    },
);

/*
 * --------------------------------------------------------------------------
 * Health
 * --------------------------------------------------------------------------
 */

app.get(
    '/api/health',
    (_req, res) => {
        res.json({
            status: 'ok',
            copilotRoot:
                COPILOT_ROOT,
            harness:
                activeHarnessId,
        });
    },
);


/*
 * --------------------------------------------------------------------------
 * Workspaces
 * --------------------------------------------------------------------------
 */

app.get(
    '/api/workspaces',
    async (_req, res) => {
        try {
            const workspaces =
                await discoverWorkspaces();

            res.json(
                workspaces,
            );
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to discover Copilot workspaces',
                    ),
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * Prompt
 * --------------------------------------------------------------------------
 */

/*
 * Browser-held chat history, sent as a JSON form
 * field so a conversation that predates the saved
 * transcript can still be replayed after a restart.
 */
const HISTORY_TURN_LIMIT = 12;
const HISTORY_TEXT_LIMIT = 4_000;

function parseHistory(
    raw: unknown,
): { user: string; assistant: string }[] {
    if (typeof raw !== 'string' || !raw) {
        return [];
    }

    try {
        const parsed: unknown = JSON.parse(raw);

        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .filter(
                (turn): turn is {
                    user: string;
                    assistant: string;
                } =>
                    Boolean(turn) &&
                    typeof turn.user === 'string' &&
                    typeof turn.assistant ===
                        'string',
            )
            .slice(-HISTORY_TURN_LIMIT)
            .map((turn) => ({
                user: turn.user.slice(
                    0,
                    HISTORY_TEXT_LIMIT,
                ),
                assistant: turn.assistant.slice(
                    0,
                    HISTORY_TEXT_LIMIT,
                ),
            }));
    } catch {
        return [];
    }
}

app.post(
    '/api/workspaces/:id/prompt',

    upload.array(
        'attachments',
        5,
    ),

    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const prompt =
                typeof req.body
                    ?.prompt ===
                'string'
                    ? req.body.prompt
                    : '';

            const attachments =
                Array.isArray(
                    req.files,
                )
                    ? (
                          req.files as
                              Express.Multer.File[]
                      )
                    : [];

            /*
             * Either text or at least one
             * attachment is required.
             */
            if (
                !prompt.trim() &&
                attachments.length ===
                    0
            ) {
                res.status(
                    400,
                ).json({
                    error:
                        'A prompt or attachment is required',
                });

                return;
            }

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const agent =
                getOrCreateAgent(
                    workspace,
                );

            const agentPrompt =
                buildAgentPrompt(
                    prompt,
                    attachments,
                );

            res.status(200);

            res.setHeader(
                'Content-Type',
                'application/x-ndjson; charset=utf-8',
            );

            res.setHeader(
                'Cache-Control',
                'no-cache',
            );

            res.setHeader(
                'Connection',
                'keep-alive',
            );

            res.flushHeaders();

            const send = (
                data: unknown,
            ) => {
                if (
                    res.writableEnded
                ) {
                    return;
                }

                res.write(
                    `${JSON.stringify(
                        data,
                    )}\n`,
                );
            };

            /*
             * After a restart the transcript is only
             * on disk; load it so the new session is
             * given the conversation the user can see.
             */
            await loadConversation(
                id,
            );

            seedConversation(
                id,
                agent.harnessLabel,
                parseHistory(
                    req.body?.history,
                ),
            );

            /*
             * A handoff summary may still be running,
             * possibly on this very agent if the user
             * switched straight back.
             */
            await waitForPendingSummary(
                id,
            );

            const handoff =
                buildHandoff(
                    id,
                    agent,
                );

            if (handoff) {
                console.log(
                    `[handoff] ${workspace.name}: ${handoff.mode} from ${handoff.from.join(', ')}`,
                );

                send({
                    type:
                        'handoff',

                    from:
                        handoff.from,

                    mode:
                        handoff.mode,

                    reason:
                        handoff.reason,
                });
            }

            const result =
                await agent.prompt(
                    handoff
                        ? `${handoff.text}\n\n## New user message\n${agentPrompt}`
                        : agentPrompt,
                    {
                        onChunk:
                            (
                                chunk,
                            ) => {
                                send({
                                    type:
                                        'chunk',

                                    text:
                                        chunk,
                                });
                            },

                        onPermission:
                            (
                                permission,
                            ) => {
                                send({
                                    type:
                                        'permission',

                                    ...permission,
                                });
                            },

                        onToolActivity:
                            (
                                activity,
                            ) => {
                                send({
                                    type:
                                        'tool',

                                    activity,
                                });
                            },
                    },
                );

                recordTurn(
                    id,
                    agent,
                    {
                        harnessLabel:
                            agent.harnessLabel,

                        user:
                            attachments.length > 0
                                ? `${prompt.trim()}\n[Attached: ${attachments.map((file) => file.originalname).join(', ')}]`
                                : prompt.trim(),

                        assistant:
                            result.response,
                    },
                );

                send({
                    type: 'done',

                stopReason:
                    result.stopReason,

                sessionId:
                    result.sessionId,

                usage:
                    result.usage,
            });

            res.end();
        } catch (error) {
            console.error(
                error,
            );

            const message =
                errorMessage(
                    error,
                    'Unable to run prompt',
                );

            if (
                res.headersSent
            ) {
                if (
                    !res.writableEnded
                ) {
                    res.write(
                        `${JSON.stringify(
                            {
                                type:
                                    'error',

                                error:
                                    message,
                            },
                        )}\n`,
                    );

                    res.end();
                }

                return;
            }

            res.status(
                500,
            ).json({
                error: message,
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * Models
 * --------------------------------------------------------------------------
 */

app.get(
    '/api/workspaces/:id/models',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const agent =
                getOrCreateAgent(
                    workspace,
                );

            const models =
                await agent.getModels();

            res.json(models);
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to load models',
                    ),
            });
        }
    },
);

app.post(
    '/api/workspaces/:id/model',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const modelId =
                req.body?.modelId;

            if (
                typeof modelId !==
                'string'
            ) {
                res.status(
                    400,
                ).json({
                    error:
                        'modelId is required',
                });

                return;
            }

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const agent =
                getOrCreateAgent(
                    workspace,
                );

            const models =
                await agent.setModel(
                    modelId,
                );

            res.json(models);
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to change model',
                    ),
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * Reasoning
 * --------------------------------------------------------------------------
 */

app.get(
    '/api/workspaces/:id/reasoning',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const agent =
                getOrCreateAgent(
                    workspace,
                );

            const reasoning =
                await agent.getReasoning();

            res.json(
                reasoning,
            );
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to load reasoning options',
                    ),
            });
        }
    },
);

app.post(
    '/api/workspaces/:id/reasoning',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const effort =
                req.body?.effort;

            if (
                typeof effort !==
                'string'
            ) {
                res.status(
                    400,
                ).json({
                    error:
                        'effort is required',
                });

                return;
            }

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const agent =
                getOrCreateAgent(
                    workspace,
                );

            const reasoning =
                await agent.setReasoning(
                    effort,
                );

            res.json(
                reasoning,
            );
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to change reasoning effort',
                    ),
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * Workspace overview
 * --------------------------------------------------------------------------
 */

app.get(
    '/api/workspaces/:id/overview',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const agentsPath =
                path.join(
                    workspace.path,
                    'AGENTS.md',
                );

            const markdown =
                await fs.readFile(
                    agentsPath,
                    'utf8',
                );

            res.json({
                markdown,
            });
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to load AGENTS.md',
                    ),
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * Repositories
 * --------------------------------------------------------------------------
 */

app.get(
    '/api/workspaces/:id/repos',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const repos =
                await discoverRepositories(
                    workspace,
                );

            res.json(repos);
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to discover repositories',
                    ),
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * Permissions
 * --------------------------------------------------------------------------
 */

app.post(
    '/api/workspaces/:id/permissions/:requestId',
    (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const requestId =
                routeParam(
                    req.params
                        .requestId,
                    'requestId',
                );

            const optionId =
                req.body?.optionId;

            if (
                typeof optionId !==
                'string'
            ) {
                res.status(
                    400,
                ).json({
                    error:
                        'optionId is required',
                });

                return;
            }

            const agent =
                agents.get(id);

            if (!agent) {
                res.status(
                    404,
                ).json({
                    error:
                        'Agent not found',
                });

                return;
            }

            const resolved =
                agent.resolvePermission(
                    requestId,
                    optionId,
                );

            if (!resolved) {
                res.status(
                    404,
                ).json({
                    error:
                        'Permission request no longer exists',
                });

                return;
            }

            res.json({
                status: 'ok',
            });
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to resolve permission request',
                    ),
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * MCP status
 * --------------------------------------------------------------------------
 */

app.get(
    '/api/workspaces/:id/mcps',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const servers =
                await getWorkspaceMcpStatus(
                    workspace,
                );

            res.json(
                servers,
            );
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to load MCP status',
                    ),
            });
        }
    },
);


/*
 * Raw MCP list.
 *
 * Kept deliberately as a diagnostics endpoint
 * because it has already been useful when the
 * Copilot CLI output format changed.
 */
app.get(
    '/api/workspaces/:id/mcp-status-raw',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const agent =
                getOrCreateAgent(
                    workspace,
                );

            const output =
                await agent.getMcpStatusText();

            res.json({
                output,
            });
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to retrieve MCP status',
                    ),
            });
        }
    },
);


/*
 * Raw single-server endpoint.
 *
 * Current Copilot versions may still return
 * the complete MCP list for /mcp show.
 * Keeping this endpoint is useful for diagnostics.
 */
app.get(
    '/api/workspaces/:id/mcps/:name/raw',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const name =
                routeParam(
                    req.params.name,
                    'name',
                );

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const agent =
                getOrCreateAgent(
                    workspace,
                );

            const output =
                await agent
                    .getMcpServerStatusText(
                        name,
                    );

            res.json({
                name,
                output,
            });
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to retrieve MCP status',
                    ),
            });
        }
    },
);


/*
 * Refresh one displayed MCP status.
 *
 * Copilot currently gives us the complete live
 * MCP list, so we query it and return only the
 * requested server.
 */
app.get(
    '/api/workspaces/:id/mcps/:name/status',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const name =
                routeParam(
                    req.params.name,
                    'name',
                );

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            const servers =
                await getWorkspaceMcpStatus(
                    workspace,
                );

            const server =
                servers.find(
                    (item) =>
                        item.name === name,
                );

            if (!server) {
                res.status(
                    404,
                ).json({
                    error:
                        `MCP server not found: ${name}`,
                });

                return;
            }

            res.json({
                name:
                    server.name,

                status:
                    server.status,
            });
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to refresh MCP status',
                    ),
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * New chat
 * --------------------------------------------------------------------------
 */

app.post(
    '/api/workspaces/:id/new-chat',
    async (req, res) => {
        try {
            const id =
                routeParam(
                    req.params.id,
                    'id',
                );

            const workspace =
                await findWorkspace(
                    id,
                );

            if (!workspace) {
                res.status(
                    404,
                ).json({
                    error:
                        'Workspace not found',
                });

                return;
            }

            /*
             * If this workspace has not started an
             * ACP session yet, there is nothing to
             * reset. Its first prompt will naturally
             * create a fresh conversation.
             */
            await waitForPendingSummary(
                id,
            );

            clearConversation(id);

            stopParkedAgents(
                (_harnessId, workspaceId) =>
                    workspaceId === id,
            );

            const agent =
                agents.get(id);

            if (agent) {
                await agent.resetSession();
            }

            res.json({
                ok: true,
            });
        } catch (error) {
            console.error(
                error,
            );

            res.status(
                500,
            ).json({
                error:
                    errorMessage(
                        error,
                        'Unable to start new chat',
                    ),
            });
        }
    },
);


/*
 * --------------------------------------------------------------------------
 * Unknown API routes
 * --------------------------------------------------------------------------
 */

app.use(
    '/api',
    (
        _req,
        res,
    ) => {
        res.status(
            404,
        ).json({
            error:
                'API route not found',
        });
    },
);


/*
 * --------------------------------------------------------------------------
 * Production frontend
 * --------------------------------------------------------------------------
 */

app.use(
    express.static(
        WEB_DIST,
    ),
);

/*
 * React client-side routing fallback.
 */
app.use(
    (
        req,
        res,
        next,
    ) => {
        if (
            req.method !== 'GET'
        ) {
            next();

            return;
        }

        res.sendFile(
            path.join(
                WEB_DIST,
                'index.html',
            ),
        );
    },
);


/*
 * --------------------------------------------------------------------------
 * Final error handler
 * --------------------------------------------------------------------------
 */

app.use(
    (
        error: unknown,
        _req: Request,
        res: Response,
        _next: NextFunction,
    ) => {
        console.error(
            error,
        );

        if (
            error instanceof
            multer.MulterError
        ) {
            res.status(
                400,
            ).json({
                error:
                    error.message,
            });

            return;
        }

        res.status(
            500,
        ).json({
            error:
                errorMessage(
                    error,
                    'Unexpected server error',
                ),
        });
    },
);


/*
 * --------------------------------------------------------------------------
 * Start
 * --------------------------------------------------------------------------
 */

app.listen(
    PORT,
    '0.0.0.0',
    () => {
        console.log(
            'Agent Kitty backend',
        );

        console.log(
            `http://127.0.0.1:${PORT}`,
        );

        console.log(
            `Workspace root: ${COPILOT_ROOT}`,
        );
    },
);