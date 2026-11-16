import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export type HarnessId = 'copilot' | 'codex' | 'kiro';

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

    /*
     * Codex picks a recommended model for each new
     * session. The UI offers that as a "Default" choice
     * instead of pinning a concrete model.
     */
    offersDefaultModel: boolean;

    /*
     * Shown when the harness rejects a session because
     * nobody is signed in.
     */
    signInHint: string;

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

/*
 * Agent Kitty keeps its own Codex credentials so the
 * account it uses is independent of a personal
 * ~/.codex login. AGENT_KITTY_CODEX_HOME overrides the
 * location (set it to ~/.codex to share that login).
 */
let kittyRoot: string = process.cwd();

export function configureHarnessRoot(
    root: string,
): void {
    kittyRoot = root;
}

export function codexHome(): string {
    return (
        process.env.AGENT_KITTY_CODEX_HOME ??
        path.join(
            kittyRoot,
            '.agent-kitty',
            'codex',
        )
    );
}

export function ensureCodexHome(): string {
    const home = codexHome();

    mkdirSync(home, {
        recursive: true,
        mode: 0o700,
    });

    return home;
}

function hasCodexCredentials(): boolean {
    if (
        process.env.CODEX_API_KEY ||
        process.env.OPENAI_API_KEY
    ) {
        return true;
    }

    return existsSync(
        path.join(codexHome(), 'auth.json'),
    );
}

/*
 * Kiro CLI keeps its own login (kiro-cli login).
 * AGENT_KITTY_KIRO_CLI overrides the executable.
 */
export function kiroCli(): string {
    return (
        process.env.AGENT_KITTY_KIRO_CLI ??
        'kiro-cli'
    );
}

const KIRO_ENGINES = ['v1', 'v2', 'v3'];

/*
 * "kiro-cli whoami" takes over a second, so the
 * result is cached briefly. Signing in is picked up
 * within the cache window.
 */
const KIRO_AUTH_CACHE_MS = 15_000;

let kiroAuthCache: {
    checkedAt: number;
    signedIn: boolean;
} | null = null;

export function invalidateKiroAuthCache(): void {
    kiroAuthCache = null;
}

function kiroSignedIn(): boolean {
    const now = Date.now();

    if (
        kiroAuthCache &&
        now - kiroAuthCache.checkedAt <
            KIRO_AUTH_CACHE_MS
    ) {
        return kiroAuthCache.signedIn;
    }

    const result = spawnSync(
        kiroCli(),
        ['whoami', '--format', 'json'],
        {
            encoding: 'utf8',
            timeout: 10_000,
        },
    );

    let signedIn = false;

    if (result.status === 0) {
        try {
            const parsed = JSON.parse(
                result.stdout,
            );

            signedIn = Boolean(
                parsed && parsed.account !== null,
            );
        } catch {
            signedIn = true;
        }
    }

    kiroAuthCache = { checkedAt: now, signedIn };

    return signedIn;
}

const HARNESSES: Record<HarnessId, HarnessDefinition> = {
    copilot: {
        id: 'copilot',
        label: 'GitHub Copilot',
        description: 'GitHub Copilot CLI via the workspace start script.',
        mcpViaAcp: false,
        supportsMcpListCommand: true,
        offersDefaultModel: false,
        signInHint: 'Sign in to the GitHub Copilot CLI in a terminal, then retry.',

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
        offersDefaultModel: true,
        signInHint: 'Use "Sign in" under the harness picker, then retry.',

        launch() {
            const override =
                process.env.AGENT_KITTY_CODEX_ACP;

            if (override) {
                return {
                    command: override,
                    args: [],
                    env: {
                        CODEX_HOME: ensureCodexHome(),
                    },
                };
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
                env: {
                    CODEX_HOME: ensureCodexHome(),
                },
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
                    detail: 'Not signed in. Use "Sign in" under the harness picker',
                };
            }

            return { available: true };
        },
    },

    kiro: {
        id: 'kiro',
        label: 'Kiro',
        description: 'Kiro CLI via "kiro-cli acp".',
        mcpViaAcp: true,
        supportsMcpListCommand: false,
        offersDefaultModel: false,
        signInHint: 'Use "Sign in" under the harness picker, then retry.',

        launch() {
            const engine =
                process.env.AGENT_KITTY_KIRO_ENGINE;

            if (
                engine &&
                !KIRO_ENGINES.includes(engine)
            ) {
                throw new Error(
                    `AGENT_KITTY_KIRO_ENGINE must be one of ${KIRO_ENGINES.join(', ')}`,
                );
            }

            return {
                command: kiroCli(),
                args: [
                    'acp',
                    ...(engine
                        ? ['--agent-engine', engine]
                        : []),
                ],
            };
        },

        availability() {
            if (
                !process.env.AGENT_KITTY_KIRO_CLI &&
                !commandOnPath('kiro-cli')
            ) {
                return {
                    available: false,
                    detail: 'kiro-cli not found on PATH',
                };
            }

            if (!kiroSignedIn()) {
                return {
                    available: false,
                    detail: 'Not signed in. Use "Sign in" under the harness picker',
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
