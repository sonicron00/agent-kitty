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

async function getMcpSources(
    workspace: Workspace,
): Promise<
    Map<string, McpSource>
> {
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

    const output =
        await agent.getMcpStatusText();

    return parseMcpStatus(
        output,
        sourceByName,
    );
}


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

            const result =
                await agent.prompt(
                    agentPrompt,
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

            send({
                type: 'done',

                stopReason:
                    result.stopReason,

                sessionId:
                    result.sessionId,
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