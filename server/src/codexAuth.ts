import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
    execFile,
    spawn,
    type ChildProcess,
} from 'node:child_process';
import { promisify } from 'node:util';

import { codexHome, ensureCodexHome } from './harness.js';

/*
 * Sign-in for the Codex harness, using the Codex CLI
 * bundled with codex-acp against Agent Kitty's own
 * CODEX_HOME.
 */

export type CodexAccount = {
    signedIn: boolean;
    method?: 'chatgpt' | 'apiKey';
    email?: string;
    name?: string;
    plan?: string;
    workspace?: string;
    codexHome: string;
};

export type CodexLoginMode = 'device' | 'browser';

export type CodexLoginStatus =
    | 'pending'
    | 'succeeded'
    | 'failed'
    | 'cancelled';

export type CodexLoginSummary = {
    id: string;
    mode: CodexLoginMode;
    status: CodexLoginStatus;
    url?: string;
    code?: string;
    error?: string;
};

type CodexLogin = CodexLoginSummary & {
    process: ChildProcess;
    output: string;
};

const require = createRequire(import.meta.url);

const execFileAsync = promisify(execFile);

function codexCli(): { command: string; args: string[] } {
    try {
        return {
            command: process.execPath,
            args: [
                require.resolve('@openai/codex/bin/codex.js'),
            ],
        };
    } catch {
        return { command: 'codex', args: [] };
    }
}

function codexEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        CODEX_HOME: ensureCodexHome(),
        NO_COLOR: '1',
    };
}

function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/*
 * The ID token is only decoded for display. Codex
 * itself validates and refreshes it.
 */
function decodeJwtPayload(
    token: unknown,
): Record<string, any> | null {
    if (typeof token !== 'string') {
        return null;
    }

    const payload = token.split('.')[1];

    if (!payload) {
        return null;
    }

    try {
        return JSON.parse(
            Buffer.from(payload, 'base64url').toString('utf8'),
        );
    } catch {
        return null;
    }
}

export async function readCodexAccount(): Promise<CodexAccount> {
    const home = codexHome();

    let auth: Record<string, any>;

    try {
        auth = JSON.parse(
            await fs.readFile(
                path.join(home, 'auth.json'),
                'utf8',
            ),
        );
    } catch {
        return { signedIn: false, codexHome: home };
    }

    const claims = decodeJwtPayload(auth?.tokens?.id_token);

    if (claims) {
        const openai =
            claims['https://api.openai.com/auth'] ?? {};

        const organizations: any[] = Array.isArray(
            openai.organizations,
        )
            ? openai.organizations
            : [];

        const workspace =
            organizations.find((org) => org?.is_default)
                ?.title ?? organizations[0]?.title;

        return {
            signedIn: true,
            method: 'chatgpt',
            codexHome: home,
            ...(claims.email ? { email: claims.email } : {}),
            ...(claims.name ? { name: claims.name } : {}),
            ...(openai.chatgpt_plan_type
                ? { plan: openai.chatgpt_plan_type }
                : {}),
            ...(workspace ? { workspace } : {}),
        };
    }

    if (auth?.OPENAI_API_KEY) {
        return {
            signedIn: true,
            method: 'apiKey',
            codexHome: home,
        };
    }

    return { signedIn: false, codexHome: home };
}

let currentLogin: CodexLogin | null = null;

function summarize(
    login: CodexLogin,
): CodexLoginSummary {
    const { process: _process, output: _output, ...summary } =
        login;

    return summary;
}

export function getCodexLogin(): CodexLoginSummary | null {
    return currentLogin ? summarize(currentLogin) : null;
}

const URL_PATTERN = /https:\/\/\S+/;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/;

/*
 * Starts "codex login". Resolves once the sign-in link
 * (and device code) is known, or the process ends.
 */
export async function startCodexLogin(
    mode: CodexLoginMode,
    onComplete: (login: CodexLoginSummary) => void,
): Promise<CodexLoginSummary> {
    if (currentLogin?.status === 'pending') {
        cancelCodexLogin();
    }

    const cli = codexCli();

    const child = spawn(
        cli.command,
        [
            ...cli.args,
            'login',
            ...(mode === 'device' ? ['--device-auth'] : []),
        ],
        {
            env: codexEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );

    const login: CodexLogin = {
        id: randomUUID(),
        mode,
        status: 'pending',
        process: child,
        output: '',
    };

    currentLogin = login;

    return await new Promise<CodexLoginSummary>((resolve) => {
        let settled = false;

        const settle = () => {
            if (!settled) {
                settled = true;
                resolve(summarize(login));
            }
        };

        const ready = () =>
            Boolean(
                login.url &&
                    (mode === 'browser' || login.code),
            );

        const onData = (data: Buffer) => {
            login.output += stripAnsi(data.toString());

            login.url ??= login.output.match(URL_PATTERN)?.[0];

            if (mode === 'device') {
                login.code ??= login.output.match(
                    DEVICE_CODE_PATTERN,
                )?.[0];
            }

            if (ready()) {
                settle();
            }
        };

        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        child.once('error', (error) => {
            login.status = 'failed';
            login.error = `Unable to run Codex CLI: ${error.message}`;
            settle();
        });

        child.once('exit', (code) => {
            if (login.status === 'pending') {
                if (code === 0) {
                    login.status = 'succeeded';
                } else {
                    login.status = 'failed';
                    login.error =
                        login.output
                            .trim()
                            .split('\n')
                            .filter(Boolean)
                            .slice(-3)
                            .join(' ') ||
                        `codex login exited with code ${code}`;
                }
            }

            settle();

            if (currentLogin === login) {
                onComplete(summarize(login));
            }
        });

        setTimeout(settle, 15_000);
    });
}

export function cancelCodexLogin(): CodexLoginSummary | null {
    const login = currentLogin;

    if (!login) {
        return null;
    }

    if (login.status === 'pending') {
        login.status = 'cancelled';

        if (login.process.exitCode === null) {
            login.process.kill('SIGTERM');
        }
    }

    return summarize(login);
}

export async function logoutCodex(): Promise<void> {
    cancelCodexLogin();

    currentLogin = null;

    const cli = codexCli();

    try {
        await execFileAsync(
            cli.command,
            [...cli.args, 'logout'],
            { env: codexEnv() },
        );
    } catch {
        /*
         * "codex logout" exits non-zero when nobody is
         * signed in. Make sure the credentials are gone.
         */
    }

    await fs.rm(path.join(codexHome(), 'auth.json'), {
        force: true,
    });
}
