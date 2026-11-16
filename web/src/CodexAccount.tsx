import { useCallback, useEffect, useState } from 'react';

type CodexAccount = {
    signedIn: boolean;
    method?: 'chatgpt' | 'apiKey';
    email?: string;
    name?: string;
    plan?: string;
    workspace?: string;
    codexHome: string;
};

type CodexLogin = {
    id: string;
    mode: 'device' | 'browser';
    status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
    url?: string;
    code?: string;
    error?: string;
};

type CodexAuthState = {
    account: CodexAccount;
    login: CodexLogin | null;
};

async function request(
    url: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
): Promise<CodexAuthState> {
    const response = await fetch(url, {
        method,
        ...(body
            ? {
                  headers: {
                      'Content-Type': 'application/json',
                  },
                  body: JSON.stringify(body),
              }
            : {}),
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error ?? 'Codex request failed');
    }

    return data as CodexAuthState;
}

function accountLabel(account: CodexAccount): string {
    if (account.method === 'apiKey') {
        return 'API key';
    }

    const who = account.email ?? account.name ?? 'ChatGPT';

    const details = [account.plan, account.workspace]
        .filter(Boolean)
        .join(', ');

    return details ? `${who} (${details})` : who;
}

/*
 * Codex sign-in for Agent Kitty's own CODEX_HOME, so the
 * account can differ from a personal ~/.codex login.
 */
export function CodexAccountPanel({
    disabled,
    onChanged,
}: {
    disabled: boolean;
    onChanged: () => void;
}) {
    const [state, setState] = useState<CodexAuthState | null>(
        null,
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = useCallback(
        async (action: () => Promise<CodexAuthState>) => {
            setBusy(true);
            setError(null);

            try {
                setState(await action());
            } catch (caught) {
                setError(
                    caught instanceof Error
                        ? caught.message
                        : 'Codex request failed',
                );
            } finally {
                setBusy(false);
            }
        },
        [],
    );

    useEffect(() => {
        run(() => request('/api/harness/codex/auth'));
    }, [run]);

    const pending = state?.login?.status === 'pending';

    /*
     * Poll while a sign-in is in progress.
     */
    useEffect(() => {
        if (!pending) {
            return;
        }

        const timer = setInterval(async () => {
            try {
                const next = await request(
                    '/api/harness/codex/auth',
                );

                setState(next);

                if (next.login?.status !== 'pending') {
                    onChanged();
                }
            } catch {
                /* retry on next tick */
            }
        }, 2000);

        return () => clearInterval(timer);
    }, [pending, onChanged]);

    if (!state) {
        return error ? (
            <div className="codex-account">
                <span className="codex-account-error">
                    {error}
                </span>
            </div>
        ) : null;
    }

    const { account, login } = state;

    const signIn = (mode: 'device' | 'browser') =>
        run(() =>
            request('/api/harness/codex/login', 'POST', {
                mode,
            }),
        );

    const signOut = () => {
        if (
            !window.confirm(
                'Sign Agent Kitty out of Codex? Your personal ~/.codex login is not affected.',
            )
        ) {
            return;
        }

        run(async () => {
            const next = await request(
                '/api/harness/codex/logout',
                'POST',
            );

            onChanged();

            return next;
        });
    };

    const controlsDisabled = disabled || busy;

    return (
        <div className="codex-account">
            <div
                className="codex-account-status"
                title={`Credentials stored in ${account.codexHome}`}
            >
                <span className="codex-account-heading">
                    Codex account
                </span>
                <span>
                    {account.signedIn
                        ? accountLabel(account)
                        : 'Not signed in'}
                </span>
            </div>

            {pending && login ? (
                <div className="codex-account-login">
                    {login.mode === 'device' ? (
                        <>
                            <span>
                                Open the link in the browser
                                profile for the account you want,
                                then enter:
                            </span>
                            {login.code ? (
                                <code className="codex-account-code">
                                    {login.code}
                                </code>
                            ) : null}
                        </>
                    ) : (
                        <span>
                            Finish signing in in your browser, or
                            open the link in another profile.
                        </span>
                    )}

                    {login.url ? (
                        <a
                            href={login.url}
                            target="_blank"
                            rel="noreferrer"
                        >
                            {login.mode === 'device'
                                ? login.url
                                : 'Open sign-in page'}
                        </a>
                    ) : (
                        <span>Waiting for sign-in link…</span>
                    )}

                    <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                            run(() =>
                                request(
                                    '/api/harness/codex/login/cancel',
                                    'POST',
                                ),
                            )
                        }
                    >
                        Cancel
                    </button>
                </div>
            ) : (
                <div className="codex-account-actions">
                    <button
                        type="button"
                        disabled={controlsDisabled}
                        title="Sign in with a one-time code, in any browser profile"
                        onClick={() => signIn('device')}
                    >
                        {account.signedIn
                            ? 'Switch account'
                            : 'Sign in'}
                    </button>
                    <button
                        type="button"
                        disabled={controlsDisabled}
                        title="Sign in through your default browser"
                        onClick={() => signIn('browser')}
                    >
                        Browser
                    </button>
                    {account.signedIn ? (
                        <button
                            type="button"
                            disabled={controlsDisabled}
                            onClick={signOut}
                        >
                            Sign out
                        </button>
                    ) : null}
                </div>
            )}

            {login?.status === 'failed' && !pending ? (
                <span className="codex-account-error">
                    Sign-in failed: {login.error}
                </span>
            ) : null}

            {error ? (
                <span className="codex-account-error">
                    {error}
                </span>
            ) : null}
        </div>
    );
}
