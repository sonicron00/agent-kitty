import { randomUUID } from 'node:crypto';
import {
    execFile,
    spawn,
    type ChildProcess,
} from 'node:child_process';
import { promisify } from 'node:util';

import { invalidateKiroAuthCache, kiroCli } from './harness.js';

/*
 * Sign-in for the Kiro harness, driving the user's own
 * "kiro-cli login" so the terminal is never needed.
 */

export type KiroAccount = {
    signedIn: boolean;
    accountType?: string;
    email?: string;
    startUrl?: string;
    region?: string;
};

/*
 * "browser" opens Kiro's sign-in page (Google, GitHub,
 * Builder ID) or the Identity Center portal. "device"
 * shows a one-time code for use in any browser profile.
 */
export type KiroLoginMode = 'browser' | 'device';

export type KiroIdentityCenter = {
    startUrl: string;
    region: string;
};

export type KiroLoginStatus =
    | 'pending'
    | 'succeeded'
    | 'failed'
    | 'cancelled';

export type KiroLoginSummary = {
    id: string;
    mode: KiroLoginMode;
    identityCenter: boolean;
    status: KiroLoginStatus;
    url?: string;
    code?: string;
    error?: string;
};

type KiroLogin = KiroLoginSummary & {
    process: ChildProcess;
    output: string;
};

const execFileAsync = promisify(execFile);

const BUILDER_ID_START_URL = 'https://view.awsapps.com/start';

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;

const DEVICE_CODE_PATTERN = /Code:\s*([A-Z0-9]{4}-[A-Z0-9]{4,5})/;

function kiroEnv(): NodeJS.ProcessEnv {
    return { ...process.env, NO_COLOR: '1' };
}

function cleanOutput(text: string): string {
    return text
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\r/g, '\n');
}

function stringField(
    source: Record<string, unknown>,
    ...keys: string[]
): string | undefined {
    for (const key of keys) {
        const value = source[key];

        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return undefined;
}

/*
 * Identity Center defaults for teams, so nobody has to
 * type the start URL.
 */
export function kiroIdentityCenterDefaults(): Partial<KiroIdentityCenter> {
    return {
        ...(process.env.AGENT_KITTY_KIRO_START_URL
            ? { startUrl: process.env.AGENT_KITTY_KIRO_START_URL }
            : {}),
        ...(process.env.AGENT_KITTY_KIRO_REGION
            ? { region: process.env.AGENT_KITTY_KIRO_REGION }
            : {}),
    };
}

export function validateIdentityCenter(
    value: unknown,
): KiroIdentityCenter | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const { startUrl, region } = value as Record<string, unknown>;

    if (typeof startUrl !== 'string' || !startUrl.trim()) {
        return null;
    }

    let url: URL;

    try {
        url = new URL(startUrl.trim());
    } catch {
        throw new Error('Identity Center start URL is not a valid URL');
    }

    if (url.protocol !== 'https:') {
        throw new Error('Identity Center start URL must use https');
    }

    const trimmedRegion =
        typeof region === 'string' ? region.trim() : '';

    if (!REGION_PATTERN.test(trimmedRegion)) {
        throw new Error(
            'Identity Center region must look like "eu-west-2"',
        );
    }

    return {
        startUrl: url.toString().replace(/\/+$/, ''),
        region: trimmedRegion,
    };
}

export async function readKiroAccount(): Promise<KiroAccount> {
    let stdout: string;

    try {
        ({ stdout } = await execFileAsync(
            kiroCli(),
            ['whoami', '--format', 'json'],
            { env: kiroEnv(), timeout: 10_000 },
        ));
    } catch {
        return { signedIn: false };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout);
    } catch {
        return { signedIn: Boolean(stdout.trim()) };
    }

    if (!parsed || typeof parsed !== 'object') {
        return { signedIn: false };
    }

    const root = parsed as Record<string, unknown>;

    const account =
        'account' in root ? root.account : root;

    if (!account) {
        return { signedIn: false };
    }

    if (typeof account !== 'object') {
        return { signedIn: true };
    }

    const details = account as Record<string, unknown>;

    const accountType = stringField(
        details,
        'accountType',
        'account_type',
        'type',
        'provider',
    );
    const email = stringField(details, 'email', 'username', 'name');
    const startUrl = stringField(details, 'startUrl', 'start_url');
    const region = stringField(details, 'region');

    return {
        signedIn: true,
        ...(accountType ? { accountType } : {}),
        ...(email ? { email } : {}),
        ...(startUrl ? { startUrl } : {}),
        ...(region ? { region } : {}),
    };
}

let currentLogin: KiroLogin | null = null;

function summarize(login: KiroLogin): KiroLoginSummary {
    const { process: _process, output: _output, ...summary } =
        login;

    return summary;
}

export function getKiroLogin(): KiroLoginSummary | null {
    return currentLogin ? summarize(currentLogin) : null;
}

function failureDetail(output: string, code: number | null): string {
    return (
        output
            .split('\n')
            .map((line) => line.replace(/^[^\w"'(]+/, '').trim())
            .filter(
                (line) =>
                    line &&
                    !/^(Logging in|Opening browser)/.test(line),
            )
            .slice(-3)
            .join(' ') || `kiro-cli login exited with code ${code}`
    );
}

/*
 * kiro-cli opens the browser itself but never prints the
 * device link, so it is built from the start URL.
 */
function deviceLink(startUrl: string, code: string): string {
    return `${startUrl}/#/device?user_code=${encodeURIComponent(code)}`;
}

/*
 * Starts "kiro-cli login". Resolves once the device code
 * is known (device mode), shortly after the browser opens,
 * or when the process ends.
 */
export async function startKiroLogin(
    mode: KiroLoginMode,
    identityCenter: KiroIdentityCenter | null,
    onComplete: (login: KiroLoginSummary) => void,
): Promise<KiroLoginSummary> {
    if (currentLogin?.status === 'pending') {
        cancelKiroLogin();
    }

    /*
     * kiro-cli refuses to log in over an existing session,
     * so switching accounts signs out first.
     */
    if ((await readKiroAccount()).signedIn) {
        await runLogout();
    }

    const args = [
        'login',
        ...(identityCenter
            ? [
                  '--license',
                  'pro',
                  '--identity-provider',
                  identityCenter.startUrl,
                  '--region',
                  identityCenter.region,
              ]
            : ['--license', 'free']),
        ...(mode === 'device' ? ['--use-device-flow'] : []),
    ];

    const child = spawn(kiroCli(), args, {
        env: kiroEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const login: KiroLogin = {
        id: randomUUID(),
        mode,
        identityCenter: Boolean(identityCenter),
        status: 'pending',
        process: child,
        output: '',
    };

    currentLogin = login;

    return await new Promise<KiroLoginSummary>((resolve) => {
        let settled = false;

        const settle = () => {
            if (!settled) {
                settled = true;
                resolve(summarize(login));
            }
        };

        const onData = (data: Buffer) => {
            login.output += cleanOutput(data.toString());

            if (mode === 'device' && !login.code) {
                const code =
                    login.output.match(DEVICE_CODE_PATTERN)?.[1];

                if (code) {
                    login.code = code;
                    login.url = deviceLink(
                        identityCenter?.startUrl ??
                            BUILDER_ID_START_URL,
                        code,
                    );
                    settle();
                }
            }

            if (
                mode === 'browser' &&
                login.output.includes('Opening browser')
            ) {
                settle();
            }
        };

        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        child.once('error', (error) => {
            login.status = 'failed';
            login.error = `Unable to run kiro-cli: ${error.message}`;
            settle();
        });

        child.once('exit', (code) => {
            if (login.status === 'pending') {
                if (code === 0) {
                    login.status = 'succeeded';
                } else {
                    login.status = 'failed';
                    login.error = failureDetail(login.output, code);
                }
            }

            invalidateKiroAuthCache();

            settle();

            if (currentLogin === login) {
                onComplete(summarize(login));
            }
        });

        setTimeout(settle, 15_000);
    });
}

export function cancelKiroLogin(): KiroLoginSummary | null {
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

async function runLogout(): Promise<void> {
    try {
        await execFileAsync(kiroCli(), ['logout'], {
            env: kiroEnv(),
            timeout: 15_000,
        });
    } catch {
        /* "kiro-cli logout" fails when nobody is signed in. */
    }

    invalidateKiroAuthCache();
}

export async function logoutKiro(): Promise<void> {
    cancelKiroLogin();

    currentLogin = null;

    await runLogout();
}
