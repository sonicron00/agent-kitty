import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export type HarnessId = 'copilot' | 'codex';

export type HarnessLaunch = {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
};

export type HarnessDefinition = {
    id: HarnessId;
    label: string;
    description: string;

    /*
     * Copilot loads MCP servers itself through the
     * workspace start script. Other harnesses receive
     * them through ACP session/new.
     */
    mcpViaAcp: boolean;

    /*
     * Copilot answers "/mcp list" with a parseable
     * status list. Other harnesses fall back to the
     * configured server list.
     */
    supportsMcpListCommand: boolean;

    launch(workspacePath: string): HarnessLaunch;

    availability(): HarnessAvailability;
};

export type HarnessAvailability = {
    available: boolean;
    detail?: string;
};

export type HarnessSummary = {
    id: HarnessId;
    label: string;
    description: string;
    available: boolean;
    detail?: string;
};

const require = createRequire(import.meta.url);

function commandOnPath(
    command: string,
): boolean {
    const result = spawnSync(
        'which',
        [command],
        { encoding: 'utf8' },
    );

    return result.status === 0;
}

function resolveCodexAcpEntry(): string | null {
    try {
        const packageJsonPath = require.resolve(
            '@agentclientprotocol/codex-acp/package.json',
        );

        const entry = path.join(
            path.dirname(packageJsonPath),
            'dist',
            'index.js',
        );

        return existsSync(entry) ? entry : null;
    } catch {
        return null;
    }
}

function hasCodexCredentials(): boolean {
    if (
        process.env.CODEX_API_KEY ||
        process.env.OPENAI_API_KEY
    ) {
        return true;
    }

    const codexHome =
        process.env.CODEX_HOME ??
        path.join(os.homedir(), '.codex');

    return existsSync(
        path.join(codexHome, 'auth.json'),
    );
}

const HARNESSES: Record<HarnessId, HarnessDefinition> = {
    copilot: {
        id: 'copilot',
        label: 'GitHub Copilot',
        description: 'GitHub Copilot CLI via the workspace start script.',
        mcpViaAcp: false,
        supportsMcpListCommand: true,

        launch(workspacePath) {
            return {
                command: path.join(workspacePath, 'start'),
                args: ['--acp', '--stdio'],
            };
        },

        availability() {
            return commandOnPath('copilot')
                ? { available: true }
                : {
                      available: false,
                      detail: 'copilot CLI not found on PATH',
                  };
        },
    },

    codex: {
        id: 'codex',
        label: 'OpenAI Codex',
        description: 'OpenAI Codex via the codex-acp adapter.',
        mcpViaAcp: true,
        supportsMcpListCommand: false,

        launch() {
            const override =
                process.env.AGENT_KITTY_CODEX_ACP;

            if (override) {
                return { command: override, args: [] };
            }

            const entry = resolveCodexAcpEntry();

            if (!entry) {
                throw new Error(
                    'Codex ACP adapter is not installed. Run "npm install" in agent-kitty.',
                );
            }

            return {
                command: process.execPath,
                args: [entry],
            };
        },

        availability() {
            if (
                !process.env.AGENT_KITTY_CODEX_ACP &&
                !resolveCodexAcpEntry()
            ) {
                return {
                    available: false,
                    detail: '@agentclientprotocol/codex-acp is not installed',
                };
            }

            if (!hasCodexCredentials()) {
                return {
                    available: false,
                    detail: 'Not signed in. Run "npx codex login" or set OPENAI_API_KEY',
                };
            }

            return { available: true };
        },
    },
};

export const DEFAULT_HARNESS: HarnessId = 'copilot';

export function isHarnessId(
    value: unknown,
): value is HarnessId {
    return (
        typeof value === 'string' &&
        Object.hasOwn(HARNESSES, value)
    );
}

export function getHarness(
    id: HarnessId,
): HarnessDefinition {
    return HARNESSES[id];
}

export function listHarnesses(): HarnessSummary[] {
    return Object.values(HARNESSES).map(
        (harness) => {
            const availability =
                harness.availability();

            return {
                id: harness.id,
                label: harness.label,
                description: harness.description,
                available: availability.available,
                ...(availability.detail
                    ? { detail: availability.detail }
                    : {}),
            };
        },
    );
}

/*
 * --------------------------------------------------------------------------
 * Persistence in <root>/.agent-kitty/config.json
 * --------------------------------------------------------------------------
 */

function configPath(root: string): string {
    return path.join(
        root,
        '.agent-kitty',
        'config.json',
    );
}

async function readConfig(
    root: string,
): Promise<Record<string, unknown>> {
    try {
        const raw = await fs.readFile(
            configPath(root),
            'utf8',
        );

        const parsed = JSON.parse(raw);

        return parsed && typeof parsed === 'object'
            ? parsed
            : {};
    } catch {
        return {};
    }
}

export async function loadHarnessId(
    root: string,
): Promise<HarnessId> {
    const override = process.env.AGENT_KITTY_HARNESS;

    if (isHarnessId(override)) {
        return override;
    }

    const config = await readConfig(root);

    return isHarnessId(config.harness)
        ? config.harness
        : DEFAULT_HARNESS;
}

/*
 * MCP server names to withhold from a harness, from
 * config.json "disabledMcpServers": { "<harness>": ["name"] }.
 * Only applies to harnesses that receive MCP servers over ACP.
 */
export async function loadDisabledMcpServers(
    root: string,
    id: HarnessId,
): Promise<Set<string>> {
    const config = await readConfig(root);

    const byHarness = config.disabledMcpServers;

    if (!byHarness || typeof byHarness !== 'object') {
        return new Set();
    }

    const names = (byHarness as Record<string, unknown>)[id];

    return new Set(
        Array.isArray(names)
            ? names.filter(
                  (name): name is string =>
                      typeof name === 'string',
              )
            : [],
    );
}

export async function saveHarnessId(
    root: string,
    id: HarnessId,
): Promise<void> {
    const config = await readConfig(root);

    const next = {
        version: 1,
        ...config,
        harness: id,
    };

    await fs.mkdir(
        path.dirname(configPath(root)),
        { recursive: true },
    );

    await fs.writeFile(
        configPath(root),
        `${JSON.stringify(next, null, 2)}\n`,
        'utf8',
    );
}

/*
 * --------------------------------------------------------------------------
 * MCP config conversion for harnesses that take servers over ACP
 * --------------------------------------------------------------------------
 */

type RawMcpServer = {
    type?: string;
    command?: string;
    args?: unknown[];
    env?: Record<string, unknown>;
    cwd?: string;
    url?: string;
    headers?: Record<string, unknown>;
};

function toNameValueList(
    record: Record<string, unknown> | undefined,
): { name: string; value: string }[] {
    return Object.entries(record ?? {}).map(
        ([name, value]) => ({
            name,
            value: String(value),
        }),
    );
}

/*
 * Relative commands in mcp.json are written relative
 * to the workspace directory (Copilot runs there).
 */
function resolveCommand(
    command: string,
    workspacePath: string,
): string {
    if (
        command.startsWith('./') ||
        command.startsWith('../')
    ) {
        return path.resolve(workspacePath, command);
    }

    return command;
}

export function toAcpMcpServers(
    servers: Record<string, unknown>,
    workspacePath: string,
): any[] {
    const result: any[] = [];

    for (const [name, value] of Object.entries(servers)) {
        const server = (value ?? {}) as RawMcpServer;

        const type = server.type?.toLowerCase();

        if (
            server.url &&
            (type === 'http' ||
                type === 'streamable-http' ||
                type === 'sse' ||
                !server.command)
        ) {
            result.push({
                type: type === 'sse' ? 'sse' : 'http',
                name,
                url: server.url,
                headers: toNameValueList(server.headers),
            });

            continue;
        }

        if (!server.command) {
            console.warn(
                `Skipping MCP server "${name}": no command or url`,
            );

            continue;
        }

        result.push({
            name,
            command: resolveCommand(
                server.command,
                workspacePath,
            ),
            args: (server.args ?? []).map(String),
            env: toNameValueList(server.env),
        });
    }

    return result;
}
