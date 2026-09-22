#!/usr/bin/env node

import {
    spawn,
    spawnSync,
} from 'node:child_process';

import {
    chmod,
    copyFile,
    mkdir,
    readdir,
    writeFile,
} from 'node:fs/promises';

import {
    existsSync,
    readFileSync,
} from 'node:fs';

import path from 'node:path';

import {
    fileURLToPath,
} from 'node:url';

import {
    createInterface,
} from 'node:readline/promises';

import {
    stdin as input,
    stdout as output,
} from 'node:process';


/*
 * --------------------------------------------------------------------------
 * Package information
 * --------------------------------------------------------------------------
 */

const __filename =
    fileURLToPath(
        import.meta.url,
    );

const __dirname =
    path.dirname(
        __filename,
    );

const packageRoot =
    path.resolve(
        __dirname,
        '..',
    );

const packageJsonPath =
    path.join(
        packageRoot,
        'package.json',
    );

const packageJson =
    JSON.parse(
        readFileSync(
            packageJsonPath,
            'utf8',
        ),
    );

const VERSION =
    packageJson.version ??
    'unknown';

const SHARED_TEMPLATE_DIR =
    path.join(
        packageRoot,
        'templates',
        'shared',
    );


/*
 * --------------------------------------------------------------------------
 * Templates
 * --------------------------------------------------------------------------
 */

const AGENTS_TEMPLATE =
`# Agent Instructions

## Purpose

Describe what this workspace contains and what the agent is responsible for.

## Repositories

Document the repositories in this workspace and their roles.

## Development Guidelines

Add any build, test, coding, deployment, or architectural rules the agent must follow.

## Important Constraints

Add anything the agent must not do without explicit approval.
`;

const WORKSPACE_MCP_TEMPLATE =
`{
  "mcpServers": {}
}
`;

const AGENT_KITTY_CONFIG_TEMPLATE =
JSON.stringify(
    {
        version: 1,
    },
    null,
    2,
) + '\n';

const START_TEMPLATE =
`#!/bin/zsh

WORKSPACE_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_ROOT="$(cd "$WORKSPACE_DIR/.." && pwd)"

cd "$WORKSPACE_DIR"

exec copilot \\
    --additional-mcp-config="@$AGENT_ROOT/.agent-kitty/shared/mcp.json" \\
    --additional-mcp-config="@$WORKSPACE_DIR/mcp.json" \\
    "$@"
`;


/*
 * --------------------------------------------------------------------------
 * Help
 * --------------------------------------------------------------------------
 */

function showHelp() {
    console.log(`
Agent Kitty 🐱

Local browser workspace for coding agents.

Usage:
  agent-kitty <command>

Commands:
  init        Initialise the current folder for Agent Kitty
  start       Start Agent Kitty in the current folder
  doctor      Check Agent Kitty prerequisites and configuration
  add-agent   Initialise a folder as an Agent Kitty agent

Options:
  -h, --help       Show this help
  -v, --version    Show the version
`);
}


/*
 * --------------------------------------------------------------------------
 * File helpers
 * --------------------------------------------------------------------------
 */

async function createFileIfMissing(
    filePath,
    content,
) {
    if (
        existsSync(
            filePath,
        )
    ) {
        return false;
    }

    await writeFile(
        filePath,
        content,
        'utf8',
    );

    return true;
}

async function copyDirectoryMissing(
    sourceDir,
    destinationDir,
) {
    await mkdir(
        destinationDir,
        {
            recursive: true,
        },
    );

    const entries =
        await readdir(
            sourceDir,
            {
                withFileTypes: true,
            },
        );

    let created = 0;
    let skipped = 0;

    for (const entry of entries) {
        const sourcePath =
            path.join(
                sourceDir,
                entry.name,
            );

        const destinationPath =
            path.join(
                destinationDir,
                entry.name,
            );

        if (
            entry.isDirectory()
        ) {
            const result =
                await copyDirectoryMissing(
                    sourcePath,
                    destinationPath,
                );

            created +=
                result.created;

            skipped +=
                result.skipped;

            continue;
        }

        if (
            !entry.isFile()
        ) {
            continue;
        }

        if (
            existsSync(
                destinationPath,
            )
        ) {
            skipped += 1;

            continue;
        }

        await copyFile(
            sourcePath,
            destinationPath,
        );

        created += 1;
    }

    return {
        created,
        skipped,
    };
}


/*
 * --------------------------------------------------------------------------
 * Agent setup
 * --------------------------------------------------------------------------
 */

async function initialiseAgent(
    agentPath,
) {
    const agentName =
        path.basename(
            agentPath,
        );

    const agentsPath =
        path.join(
            agentPath,
            'AGENTS.md',
        );

    const mcpPath =
        path.join(
            agentPath,
            'mcp.json',
        );

    const startPath =
        path.join(
            agentPath,
            'start',
        );

    const createdAgents =
        await createFileIfMissing(
            agentsPath,
            AGENTS_TEMPLATE,
        );

    const createdMcp =
        await createFileIfMissing(
            mcpPath,
            WORKSPACE_MCP_TEMPLATE,
        );

    const createdStart =
        await createFileIfMissing(
            startPath,
            START_TEMPLATE,
        );

    /*
     * Ensure start is executable, even if
     * it already existed.
     */
    try {
        await chmod(
            startPath,
            0o755,
        );
    } catch {
        // Ignore chmod failures on platforms
        // where it is unavailable.
    }

    console.log(
        `\n${agentName}`,
    );

    console.log(
        createdAgents
            ? '  + created AGENTS.md'
            : '  ✓ AGENTS.md already exists',
    );

    console.log(
        createdMcp
            ? '  + created mcp.json'
            : '  ✓ mcp.json already exists',
    );

    console.log(
        createdStart
            ? '  + created start'
            : '  ✓ start already exists',
    );
}


/*
 * --------------------------------------------------------------------------
 * Init
 * --------------------------------------------------------------------------
 */

async function initAgentKitty() {
    const workspaceRoot =
        process.cwd();

    const agentKittyDir =
        path.join(
            workspaceRoot,
            '.agent-kitty',
        );

    const sharedDir =
        path.join(
            agentKittyDir,
            'shared',
        );

    console.log(`
Agent Kitty 🐱

Initialising:
  ${workspaceRoot}
`);

    await mkdir(
        sharedDir,
        {
            recursive: true,
        },
    );

    const createdConfig =
        await createFileIfMissing(
            path.join(
                agentKittyDir,
                'config.json',
            ),
            AGENT_KITTY_CONFIG_TEMPLATE,
        );

    console.log(
        createdConfig
            ? '+ created .agent-kitty/config.json'
            : '✓ .agent-kitty/config.json already exists',
    );

    /*
     * Install shared MCP assets.
     *
     * Existing files are never overwritten.
     */
    if (
        !existsSync(
            SHARED_TEMPLATE_DIR,
        )
    ) {
        throw new Error(
            `Agent Kitty shared templates were not found: ${SHARED_TEMPLATE_DIR}`,
        );
    }

    const sharedResult =
        await copyDirectoryMissing(
            SHARED_TEMPLATE_DIR,
            sharedDir,
        );

    console.log(
        `Shared MCP assets: ${sharedResult.created} created, ${sharedResult.skipped} already existed`,
    );

    /*
     * Ensure shipped MCP wrappers are executable.
     */
    const sharedBinDir =
        path.join(
            sharedDir,
            'bin',
        );

    for (
        const wrapper of
        [
            'atlassian-mcp',
            'lenses-mcp',
        ]
    ) {
        const wrapperPath =
            path.join(
                sharedBinDir,
                wrapper,
            );

        if (
            existsSync(
                wrapperPath,
            )
        ) {
            try {
                await chmod(
                    wrapperPath,
                    0o755,
                );
            } catch {
                // Ignore chmod failures.
            }
        }
    }

    /*
     * Scan immediate child directories.
     */
    const entries =
        await readdir(
            workspaceRoot,
            {
                withFileTypes:
                    true,
            },
        );

    const ignoredNames =
        new Set([
            '.agent-kitty',
            '.git',
            'node_modules',
            'agent-kitty',
            'shared',
        ]);

    const candidates =
        entries
            .filter(
                (entry) =>
                    entry.isDirectory() &&
                    !entry.name.startsWith(
                        '.',
                    ) &&
                    !ignoredNames.has(
                        entry.name,
                    ),
            )
            .sort(
                (a, b) =>
                    a.name.localeCompare(
                        b.name,
                    ),
            );

    if (
        candidates.length === 0
    ) {
        console.log(`
No candidate agent folders were found.

Create a folder and then run:

  agent-kitty add-agent <folder>
`);

        return;
    }

    console.log(`
Found ${candidates.length} candidate folder${
        candidates.length === 1
            ? ''
            : 's'
    }.
`);

    const readline =
        createInterface({
            input,
            output,
        });

    try {
        for (
            const entry of
            candidates
        ) {
            const agentPath =
                path.join(
                    workspaceRoot,
                    entry.name,
                );

            /*
             * An existing standard workspace is
             * already an Agent Kitty agent.
             */
            const alreadyAgent =
                existsSync(
                    path.join(
                        agentPath,
                        'AGENTS.md',
                    ),
                ) &&
                existsSync(
                    path.join(
                        agentPath,
                        'start',
                    ),
                );

            if (
                alreadyAgent
            ) {
                console.log(
                    `✓ ${entry.name} is already an agent`,
                );

                continue;
            }

            const answer =
                await readline.question(
                    `Set up ${entry.name} as an agent? [Y/n] `,
                );

            const normalised =
                answer
                    .trim()
                    .toLowerCase();

            if (
                normalised ===
                    'n' ||
                normalised ===
                    'no'
            ) {
                console.log(
                    `  skipped ${entry.name}`,
                );

                continue;
            }

            await initialiseAgent(
                agentPath,
            );
        }
    } finally {
        readline.close();
    }

    console.log(`
Agent Kitty initialisation complete.

Start it from this directory with:

  agent-kitty start
`);
}


/*
 * --------------------------------------------------------------------------
 * Start
 * --------------------------------------------------------------------------
 */

function startAgentKitty() {
    const workspaceRoot =
        process.cwd();

    const serverPath =
        path.join(
            packageRoot,
            'server',
            'dist',
            'index.js',
        );

    if (
        !existsSync(
            serverPath,
        )
    ) {
        console.error(`
Agent Kitty has not been built.

Expected server:
  ${serverPath}

From the Agent Kitty source repository, run:

  npm run build
`);

        process.exitCode = 1;

        return;
    }

    console.log(`
Agent Kitty 🐱

Workspace root:
  ${workspaceRoot}

Starting...
`);

    const child =
        spawn(
            process.execPath,
            [
                serverPath,
            ],
            {
                cwd:
                    packageRoot,

                stdio:
                    'inherit',

                env: {
                    ...process.env,

                    /*
                     * The backend currently uses
                     * COPILOT_ROOT for this concept.
                     *
                     * We can rename this internally
                     * when multi-provider support
                     * is introduced.
                     */
                    COPILOT_ROOT:
                        workspaceRoot,
                },
            },
        );

    child.on(
        'error',
        (error) => {
            console.error(
                `Unable to start Agent Kitty: ${error.message}`,
            );

            process.exitCode = 1;
        },
    );

    child.on(
        'exit',
        (
            code,
            signal,
        ) => {
            if (signal) {
                process.kill(
                    process.pid,
                    signal,
                );

                return;
            }

            process.exitCode =
                code ?? 0;
        },
    );
}


/*
 * --------------------------------------------------------------------------
 * Doctor helpers
 * --------------------------------------------------------------------------
 */

function commandExists(
    command,
    args = ['--version'],
) {
    const result =
        spawnSync(
            command,
            args,
            {
                encoding:
                    'utf8',

                stdio: [
                    'ignore',
                    'pipe',
                    'pipe',
                ],
            },
        );

    return {
        available:
            result.status === 0,

        output:
            (
                result.stdout ||
                result.stderr ||
                ''
            )
                .trim()
                .split('\n')[0] ??
            '',
    };
}

function printCheck(
    ok,
    label,
    detail = '',
) {
    const symbol =
        ok
            ? '✓'
            : '✕';

    const suffix =
        detail
            ? `  ${detail}`
            : '';

    console.log(
        `${symbol} ${label}${suffix}`,
    );
}

function printWarning(
    label,
    detail = '',
) {
    const suffix =
        detail
            ? `  ${detail}`
            : '';

    console.log(
        `⚠ ${label}${suffix}`,
    );
}


/*
 * --------------------------------------------------------------------------
 * Doctor
 * --------------------------------------------------------------------------
 */

async function doctorAgentKitty() {
    const workspaceRoot =
        process.cwd();

    console.log(`
Agent Kitty Doctor 🐱

Workspace root:
  ${workspaceRoot}

Prerequisites
`);

    /*
     * Node
     */
    const nodeMajor =
        Number(
            process.versions.node
                .split('.')[0],
        );

    printCheck(
        nodeMajor >= 22,
        `Node ${process.versions.node}`,
        nodeMajor >= 22
            ? ''
            : 'Node 22 or newer recommended',
    );

    /*
     * External commands
     */
    const commands = [
        {
            command:
                'copilot',

            label:
                'GitHub Copilot CLI',
        },

        {
            command:
                'git',

            label:
                'Git',
        },

        {
            command:
                'zsh',

            label:
                'zsh',

            args: [
                '--version',
            ],
        },

        {
            command:
                'npx',

            label:
                'npx',
        },

        {
            command:
                'uv',

            label:
                'uv',
        },
    ];

    for (
        const item of
        commands
    ) {
        const result =
            commandExists(
                item.command,
                item.args ??
                    ['--version'],
            );

        printCheck(
            result.available,
            item.label,
            result.output,
        );
    }

    /*
     * Agent Kitty root
     */
    console.log(
        '\nAgent Kitty setup\n',
    );

    const agentKittyDir =
        path.join(
            workspaceRoot,
            '.agent-kitty',
        );

    const configPath =
        path.join(
            agentKittyDir,
            'config.json',
        );

    const sharedDir =
        path.join(
            agentKittyDir,
            'shared',
        );

    const sharedMcpPath =
        path.join(
            sharedDir,
            'mcp.json',
        );

    const atlassianWrapper =
        path.join(
            sharedDir,
            'bin',
            'atlassian-mcp',
        );

    const lensesWrapper =
        path.join(
            sharedDir,
            'bin',
            'lenses-mcp',
        );

    const lensesProject =
        path.join(
            sharedDir,
            'tools',
            'lenses-mcp',
            'pyproject.toml',
        );

    const initialised =
        existsSync(
            agentKittyDir,
        );

    printCheck(
        initialised,
        '.agent-kitty',
        initialised
            ? ''
            : 'Run "agent-kitty init"',
    );

    printCheck(
        existsSync(
            configPath,
        ),
        'Agent Kitty config',
    );

    printCheck(
        existsSync(
            sharedMcpPath,
        ),
        'Shared MCP config',
    );

    printCheck(
        existsSync(
            atlassianWrapper,
        ),
        'Atlassian MCP wrapper',
    );

    printCheck(
        existsSync(
            lensesWrapper,
        ),
        'Lenses MCP wrapper',
    );

    printCheck(
        existsSync(
            lensesProject,
        ),
        'Lenses MCP project',
    );

    /*
     * Lenses configuration
     */
    const lensesEnv =
        path.join(
            sharedDir,
            'tools',
            'lenses-mcp',
            '.env',
        );

    if (
        existsSync(
            lensesEnv,
        )
    ) {
        printCheck(
            true,
            'Lenses local environment',
        );
    } else {
        printWarning(
            'Lenses local environment',
            '.env not configured',
        );
    }

    /*
     * Discover agents
     */
    console.log(
        '\nAgents\n',
    );

    const entries =
        await readdir(
            workspaceRoot,
            {
                withFileTypes:
                    true,
            },
        );

    const agentDirectories =
        entries
            .filter(
                (entry) =>
                    entry.isDirectory() &&
                    !entry.name.startsWith(
                        '.',
                    ),
            )
            .sort(
                (a, b) =>
                    a.name.localeCompare(
                        b.name,
                    ),
            );

    let agentCount = 0;

    for (
        const entry of
        agentDirectories
    ) {
        const agentPath =
            path.join(
                workspaceRoot,
                entry.name,
            );

        const hasAgents =
            existsSync(
                path.join(
                    agentPath,
                    'AGENTS.md',
                ),
            );

        const hasStart =
            existsSync(
                path.join(
                    agentPath,
                    'start',
                ),
            );

        if (
            !hasAgents &&
            !hasStart
        ) {
            continue;
        }

        agentCount += 1;

        if (
            hasAgents &&
            hasStart
        ) {
            printCheck(
                true,
                entry.name,
            );
        } else {
            printWarning(
                entry.name,
                'incomplete agent setup',
            );
        }
    }

    if (
        agentCount === 0
    ) {
        printWarning(
            'No agents found',
            'Run "agent-kitty init" or "agent-kitty add-agent"',
        );
    }

    console.log('');
}


/*
 * --------------------------------------------------------------------------
 * Command handling
 * --------------------------------------------------------------------------
 */

const args =
    process.argv.slice(2);

const command =
    args[0];

if (
    !command ||
    command === '--help' ||
    command === '-h'
) {
    showHelp();
    process.exit(0);
}

if (
    command === '--version' ||
    command === '-v'
) {
    console.log(
        `Agent Kitty ${VERSION}`,
    );

    process.exit(0);
}

switch (command) {
    case 'init':
        await initAgentKitty();
        break;

    case 'start':
        startAgentKitty();
        break;

    case 'doctor':
        await doctorAgentKitty();
        break;

case 'add-agent': {
    const folder =
        args[1];

    if (!folder) {
        console.error(
            'Usage: agent-kitty add-agent <folder>',
        );

        process.exitCode = 1;
        break;
    }

    const workspaceRoot =
        process.cwd();

    /*
     * Agent Kitty must already have been
     * initialised in this workspace root.
     */
    const agentKittyDir =
        path.join(
            workspaceRoot,
            '.agent-kitty',
        );

    if (
        !existsSync(
            agentKittyDir,
        )
    ) {
        console.error(`
This folder has not been initialised for Agent Kitty.

Run:

  agent-kitty init
`);

        process.exitCode = 1;
        break;
    }

    const agentPath =
        path.resolve(
            workspaceRoot,
            folder,
        );

    /*
     * Only allow agents inside the current
     * Agent Kitty workspace root.
     */
    const relativePath =
        path.relative(
            workspaceRoot,
            agentPath,
        );

    const outsideWorkspace =
        relativePath ===
            '..' ||
        relativePath.startsWith(
            `..${path.sep}`,
        ) ||
        path.isAbsolute(
            relativePath,
        );

    if (
        outsideWorkspace
    ) {
        console.error(`
Agent folders must be inside the current Agent Kitty workspace.

Workspace root:
  ${workspaceRoot}

Requested:
  ${agentPath}
`);

        process.exitCode = 1;
        break;
    }

    /*
     * Don't allow the workspace root itself
     * to accidentally become an agent.
     */
    if (
        relativePath === ''
    ) {
        console.error(
            'Please specify an agent folder inside the current workspace.',
        );

        process.exitCode = 1;
        break;
    }

    /*
     * Keep Agent Kitty's own internal folder
     * reserved.
     */
    if (
        relativePath ===
            '.agent-kitty' ||
        relativePath.startsWith(
            `.agent-kitty${path.sep}`,
        )
    ) {
        console.error(
            '.agent-kitty is reserved for Agent Kitty configuration.',
        );

        process.exitCode = 1;
        break;
    }

    await mkdir(
        agentPath,
        {
            recursive: true,
        },
    );

    await initialiseAgent(
        agentPath,
    );

    console.log(`
Agent added.

Path:
  ${agentPath}

Start Agent Kitty with:

  agent-kitty start
`);

    break;
}

    default:
        console.error(
            `Unknown command: ${command}`,
        );

        console.log(
            'Run "agent-kitty --help" for usage.',
        );

        process.exitCode = 1;
}