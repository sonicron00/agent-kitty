import { useCallback, useEffect, useState } from 'react';

type KiroAccount = {
    signedIn: boolean;
    accountType?: string;
    email?: string;
    startUrl?: string;
    region?: string;
};

type KiroLogin = {
    id: string;
    mode: 'browser' | 'device';
    identityCenter: boolean;
    status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
    url?: string;
    code?: string;
    error?: string;
};

type IdentityCenter = {
    startUrl: string;
    region: string;
};

type KiroAuthState = {
    account: KiroAccount;
    login: KiroLogin | null;
    identityCenterDefaults: Partial<IdentityCenter>;
};

const STORAGE_KEY = 'agent-kitty.kiro.identityCenter';

function loadSavedIdentityCenter(): {
    enabled: boolean;
    startUrl: string;
    region: string;
} | null {
    try {
        const saved = JSON.parse(
            localStorage.getItem(STORAGE_KEY) ?? 'null',
        );

        return saved && typeof saved === 'object' ? saved : null;
    } catch {
        return null;
    }
}

async function request(
    url: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
): Promise<KiroAuthState> {
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
        throw new Error(data.error ?? 'Kiro request failed');
    }

    return data as KiroAuthState;
}

function accountLabel(account: KiroAccount): string {
    const who = account.email ?? 'Signed in';

    return account.accountType
        ? `${who} (${account.accountType})`
        : who;
}

/*
 * Kiro sign-in using the normal kiro-cli login, so the
 * terminal is never needed.
 */
export function KiroAccountPanel({
    disabled,
    onChanged,
}: {
    disabled: boolean;
    onChanged: () => void;
}) {
    const [state, setState] = useState<KiroAuthState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const saved = loadSavedIdentityCenter();

    const [useIdentityCenter, setUseIdentityCenter] = useState(
        saved?.enabled ?? false,
    );
    const [startUrl, setStartUrl] = useState(saved?.startUrl ?? '');
    const [region, setRegion] = useState(saved?.region ?? '');

    const run = useCallback(
        async (action: () => Promise<KiroAuthState>) => {
            setBusy(true);
            setError(null);

            try {
                setState(await action());
            } catch (caught) {
                setError(
                    caught instanceof Error
                        ? caught.message
                        : 'Kiro request failed',
                );
            } finally {
                setBusy(false);
            }
        },
        [],
    );

    useEffect(() => {
        run(async () => {
            const next = await request('/api/harness/kiro/auth');
            const defaults = next.identityCenterDefaults ?? {};

            /*
             * Team defaults from the server enable Identity
             * Center unless the user has chosen otherwise.
             */
            if (!loadSavedIdentityCenter() && defaults.startUrl) {
                setUseIdentityCenter(true);
            }

            setStartUrl((current) => current || defaults.startUrl || '');
            setRegion((current) => current || defaults.region || '');

            return next;
        });
    }, [run]);

    useEffect(() => {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                enabled: useIdentityCenter,
                startUrl,
                region,
            }),
        );
    }, [useIdentityCenter, startUrl, region]);

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
                const next = await request('/api/harness/kiro/auth');

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
                <span className="codex-account-error">{error}</span>
            </div>
        ) : null;
    }

    const { account, login } = state;

    const identityCenterReady =
        !useIdentityCenter ||
        (startUrl.trim() !== '' && region.trim() !== '');

    const signIn = (mode: 'browser' | 'device') => {
        if (
            account.signedIn &&
            !window.confirm(
                'Switching signs kiro-cli out first. This also affects Kiro in your terminal and IDE. Continue?',
            )
        ) {
            return;
        }

        run(() =>
            request('/api/harness/kiro/login', 'POST', {
                mode,
                ...(useIdentityCenter
                    ? {
                          identityCenter: {
                              startUrl: startUrl.trim(),
                              region: region.trim(),
                          },
                      }
                    : {}),
            }),
        );
    };

    const signOut = () => {
        if (
            !window.confirm(
                'Sign out of Kiro? This is your normal kiro-cli login, so Kiro in your terminal is signed out too.',
            )
        ) {
            return;
        }

        run(async () => {
            const next = await request(
                '/api/harness/kiro/logout',
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
                title={
                    account.startUrl
                        ? `${account.startUrl} (${account.region ?? ''})`
                        : 'Shared with kiro-cli'
                }
            >
                <span className="codex-account-heading">
                    Kiro account
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
                                Confirm this code in the browser
                                page that opened, or open the link
                                in another profile:
                            </span>
                            {login.code ? (
                                <code className="codex-account-code">
                                    {login.code}
                                </code>
                            ) : null}
                        </>
                    ) : (
                        <span>
                            {login.identityCenter
                                ? 'Finish signing in through your Identity Center portal in the browser.'
                                : 'Choose Google, GitHub or Builder ID in the browser page that opened.'}
                        </span>
                    )}

                    {login.url ? (
                        <a
                            href={login.url}
                            target="_blank"
                            rel="noreferrer"
                        >
                            Open sign-in page
                        </a>
                    ) : null}

                    <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                            run(() =>
                                request(
                                    '/api/harness/kiro/login/cancel',
                                    'POST',
                                ),
                            )
                        }
                    >
                        Cancel
                    </button>
                </div>
            ) : (
                <>
                    <div className="codex-account-actions">
                        <button
                            type="button"
                            disabled={
                                controlsDisabled ||
                                !identityCenterReady
                            }
                            title={
                                useIdentityCenter
                                    ? 'Sign in through your Identity Center portal'
                                    : 'Sign in with Google, GitHub or Builder ID in your default browser'
                            }
                            onClick={() => signIn('browser')}
                        >
                            {account.signedIn
                                ? 'Switch account'
                                : 'Sign in'}
                        </button>
                        <button
                            type="button"
                            disabled={
                                controlsDisabled ||
                                !identityCenterReady
                            }
                            title={
                                useIdentityCenter
                                    ? 'Sign in with a one-time code, in any browser profile'
                                    : 'Builder ID with a one-time code, in any browser profile'
                            }
                            onClick={() => signIn('device')}
                        >
                            Code
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

                    <label className="kiro-identity-center-toggle">
                        <input
                            type="checkbox"
                            checked={useIdentityCenter}
                            disabled={controlsDisabled}
                            onChange={(event) =>
                                setUseIdentityCenter(
                                    event.target.checked,
                                )
                            }
                        />
                        Identity Center (Kiro Pro)
                    </label>

                    {useIdentityCenter ? (
                        <div className="kiro-identity-center">
                            <input
                                type="url"
                                placeholder="https://d-xxxxxxxxxx.awsapps.com/start"
                                value={startUrl}
                                disabled={controlsDisabled}
                                onChange={(event) =>
                                    setStartUrl(event.target.value)
                                }
                            />
                            <input
                                type="text"
                                placeholder="Region, e.g. eu-west-2"
                                value={region}
                                disabled={controlsDisabled}
                                onChange={(event) =>
                                    setRegion(event.target.value)
                                }
                            />
                        </div>
                    ) : null}
                </>
            )}

            {login?.status === 'failed' && !pending ? (
                <span className="codex-account-error">
                    Sign-in failed: {login.error}
                </span>
            ) : null}

            {error ? (
                <span className="codex-account-error">{error}</span>
            ) : null}
        </div>
    );
}
