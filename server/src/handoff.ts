import fs from 'node:fs/promises';
import path from 'node:path';

import type { WorkspaceAgent } from './WorkspaceAgent.js';

/*
 * Cross-harness and cross-restart context.
 *
 * Each harness keeps its session state inside its own
 * CLI, so nothing can be transferred directly. Instead
 * Agent Kitty keeps a plain transcript per workspace,
 * asks the outgoing agent for a handoff summary when
 * the harness changes, and gives the next agent a
 * hidden handoff block (summary plus the most recent
 * turns it has not seen) on its first prompt.
 *
 * The transcript and summary are saved to
 * <root>/.agent-kitty/conversations/<workspace>.json.
 * Agents always start a new ACP session, so after a
 * restart every agent has seen nothing and its first
 * prompt replays the saved conversation.
 */

export type Turn = {
    harnessLabel: string;
    user: string;
    assistant: string;
};

type Summary = {
    text: string;
    coversTurns: number;
    fromLabel: string;
};

type Conversation = {
    turns: Turn[];
    summary: Summary | null;
    pending: Promise<void> | null;

    /*
     * How many turns each agent has seen, either
     * because it answered them or because it was
     * given a handoff that covered them.
     */
    seen: WeakMap<WorkspaceAgent, number>;
};

export type Handoff = {
    text: string;
    from: string[];
    mode: 'summary' | 'transcript';
    reason: 'switch' | 'restart';
};

type StoredConversation = {
    version: 1;
    turns: Turn[];
    summary: Summary | null;
};

const TRANSCRIPT_BUDGET = 24_000;
const TRANSCRIPT_BUDGET_WITH_SUMMARY = 8_000;
const TURN_TEXT_LIMIT = 4_000;
const SUMMARY_WAIT_MS = 120_000;

const SUMMARY_PROMPT = [
    'Agent Kitty is about to hand this conversation to a different coding agent.',
    'Write a concise handoff note for it in Markdown, under 400 words, covering:',
    "the user's goal, key decisions and constraints, files created or changed",
    '(with paths), commands run and their outcomes, open questions, and next steps.',
    'Do not call tools, edit files or run commands; answer from what you already know.',
    'Reply with only the note.',
].join(' ');

const conversations = new Map<string, Conversation>();

let storeRoot: string | null = null;

/*
 * Workspaces whose saved transcript has been read (or
 * found missing), so it is only loaded once.
 */
const loaded = new Map<string, Promise<void>>();

/*
 * Serialise writes per workspace so an older snapshot
 * never lands after a newer one.
 */
const writes = new Map<string, Promise<void>>();

export function configureHandoffStore(
    root: string,
): void {
    storeRoot = path.join(
        root,
        '.agent-kitty',
        'conversations',
    );
}

function storePath(
    workspaceId: string,
): string | null {
    return storeRoot
        ? path.join(
              storeRoot,
              `${encodeURIComponent(workspaceId)}.json`,
          )
        : null;
}

function isTurn(value: unknown): value is Turn {
    const turn = value as Turn;

    return (
        Boolean(turn) &&
        typeof turn.harnessLabel === 'string' &&
        typeof turn.user === 'string' &&
        typeof turn.assistant === 'string'
    );
}

function isSummary(
    value: unknown,
): value is Summary {
    const summary = value as Summary;

    return (
        Boolean(summary) &&
        typeof summary.text === 'string' &&
        typeof summary.coversTurns === 'number' &&
        typeof summary.fromLabel === 'string'
    );
}

function enqueueWrite(
    workspaceId: string,
    task: () => Promise<void>,
): void {
    const next = (
        writes.get(workspaceId) ??
        Promise.resolve()
    )
        .then(task)
        .catch((error) => {
            console.error(
                `[handoff] Unable to save conversation for ${workspaceId}`,
                error,
            );
        });

    writes.set(workspaceId, next);

    void next.finally(() => {
        if (writes.get(workspaceId) === next) {
            writes.delete(workspaceId);
        }
    });
}

function persist(
    workspaceId: string,
    current: Conversation,
): void {
    const file = storePath(workspaceId);

    if (!file) {
        return;
    }

    const snapshot: StoredConversation = {
        version: 1,
        turns: [...current.turns],
        summary: current.summary,
    };

    enqueueWrite(workspaceId, async () => {
        await fs.mkdir(path.dirname(file), {
            recursive: true,
        });

        const temp = `${file}.${process.pid}.tmp`;

        await fs.writeFile(
            temp,
            `${JSON.stringify(snapshot, null, 2)}\n`,
            'utf8',
        );

        await fs.rename(temp, file);
    });
}

/*
 * Load the saved transcript for a workspace the first
 * time it is needed after a restart. Safe to call on
 * every prompt.
 */
export function loadConversation(
    workspaceId: string,
): Promise<void> {
    const existing = loaded.get(workspaceId);

    if (existing) {
        return existing;
    }

    const task = (async () => {
        const file = storePath(workspaceId);

        if (!file || conversations.has(workspaceId)) {
            return;
        }

        let stored: Partial<StoredConversation>;

        try {
            stored = JSON.parse(
                await fs.readFile(file, 'utf8'),
            );
        } catch (error) {
            if (
                (error as NodeJS.ErrnoException)
                    .code !== 'ENOENT'
            ) {
                console.error(
                    `[handoff] Unable to read saved conversation for ${workspaceId}`,
                    error,
                );
            }

            return;
        }

        const turns = Array.isArray(stored.turns)
            ? stored.turns.filter(isTurn)
            : [];

        if (
            turns.length === 0 ||
            conversations.has(workspaceId)
        ) {
            return;
        }

        conversations.set(workspaceId, {
            turns,
            summary: isSummary(stored.summary)
                ? stored.summary
                : null,
            pending: null,
            seen: new WeakMap(),
        });

        console.log(
            `[handoff] Restored ${turns.length} turn${turns.length === 1 ? '' : 's'} for ${workspaceId}`,
        );
    })();

    loaded.set(workspaceId, task);

    return task;
}

function conversation(
    workspaceId: string,
): Conversation {
    let existing =
        conversations.get(workspaceId);

    if (!existing) {
        existing = {
            turns: [],
            summary: null,
            pending: null,
            seen: new WeakMap(),
        };

        conversations.set(
            workspaceId,
            existing,
        );
    }

    return existing;
}

function truncate(
    text: string,
    limit: number,
): string {
    const trimmed = text.trim();

    if (trimmed.length <= limit) {
        return trimmed;
    }

    return `${trimmed.slice(0, limit)}\n[truncated]`;
}

function formatTurn(turn: Turn): string {
    return [
        `### User (via ${turn.harnessLabel})`,
        truncate(turn.user, TURN_TEXT_LIMIT),
        '',
        `### Assistant (${turn.harnessLabel})`,
        truncate(
            turn.assistant || '(no text response)',
            TURN_TEXT_LIMIT,
        ),
    ].join('\n');
}

/*
 * Seed the transcript from the chat history the
 * browser still holds, for conversations that predate
 * the saved transcript. Ignored once the server has
 * its own record.
 */
export function seedConversation(
    workspaceId: string,
    harnessLabel: string,
    history: { user: string; assistant: string }[],
): void {
    if (
        conversations.has(workspaceId) ||
        history.length === 0
    ) {
        return;
    }

    const current = conversation(workspaceId);

    current.turns = history.map((turn) => ({
        harnessLabel,
        user: turn.user,
        assistant: turn.assistant,
    }));

    console.log(
        `[handoff] Seeded ${history.length} turn${history.length === 1 ? '' : 's'} for ${workspaceId} from the browser`,
    );

    persist(workspaceId, current);
}

/*
 * Record a completed exchange. The agent that
 * answered it is caught up on the whole transcript.
 */
export function recordTurn(
    workspaceId: string,
    agent: WorkspaceAgent,
    turn: Turn,
): void {
    const current =
        conversation(workspaceId);

    current.turns.push(turn);

    current.seen.set(
        agent,
        current.turns.length,
    );

    persist(workspaceId, current);
}

/*
 * Mark a fresh session (new chat) as having seen
 * nothing, and forget the old transcript.
 */
export function clearConversation(
    workspaceId: string,
): void {
    conversations.delete(workspaceId);

    loaded.set(workspaceId, Promise.resolve());

    const file = storePath(workspaceId);

    if (file) {
        enqueueWrite(workspaceId, () =>
            fs.rm(file, { force: true }),
        );
    }
}

export function hasPendingSummary(
    workspaceId: string,
): boolean {
    return Boolean(
        conversations.get(workspaceId)
            ?.pending,
    );
}

/*
 * Wait for an in-flight handoff summary, but never
 * block a prompt for longer than SUMMARY_WAIT_MS.
 */
export async function waitForPendingSummary(
    workspaceId: string,
): Promise<void> {
    const pending =
        conversations.get(workspaceId)
            ?.pending;

    if (!pending) {
        return;
    }

    let timer: NodeJS.Timeout | undefined;

    await Promise.race([
        pending,
        new Promise<void>((resolve) => {
            timer = setTimeout(
                resolve,
                SUMMARY_WAIT_MS,
            );
        }),
    ]);

    clearTimeout(timer);
}

/*
 * Ask the outgoing agent for a handoff summary in the
 * background. Only an idle agent that has seen the
 * whole transcript can summarise it, and only when
 * there is something newer than the last summary.
 */
export function requestSummary(
    workspaceId: string,
    agent: WorkspaceAgent,
    harnessLabel: string,
): void {
    const current =
        conversations.get(workspaceId);

    if (
        !current ||
        current.pending ||
        agent.isBusy()
    ) {
        return;
    }

    const turnCount =
        current.turns.length;

    if (
        turnCount === 0 ||
        current.seen.get(agent) !==
            turnCount ||
        (current.summary?.coversTurns ?? 0) >=
            turnCount
    ) {
        return;
    }

    console.log(
        `[handoff] Summarising ${workspaceId} with ${harnessLabel}`,
    );

    const pending = agent
        .prompt(SUMMARY_PROMPT)
        .then((result) => {
            const text =
                result.response.trim();

            /*
             * Ignore the result if the chat was
             * reset while the summary was running.
             */
            if (
                text &&
                conversations.get(workspaceId) ===
                    current
            ) {
                current.summary = {
                    text,
                    coversTurns: turnCount,
                    fromLabel: harnessLabel,
                };

                persist(workspaceId, current);
            }
        })
        .catch((error) => {
            console.error(
                `[handoff] Summary failed for ${workspaceId}`,
                error,
            );
        })
        .finally(() => {
            current.pending = null;
        });

    current.pending = pending;
}

/*
 * Build the hidden context block for an agent that
 * has not seen every turn. Returns null when the agent
 * is already caught up.
 */
export function buildHandoff(
    workspaceId: string,
    agent: WorkspaceAgent,
): Handoff | null {
    const current =
        conversations.get(workspaceId);

    if (!current) {
        return null;
    }

    const seen =
        current.seen.get(agent) ?? 0;

    const missing =
        current.turns.slice(seen);

    if (missing.length === 0) {
        return null;
    }

    const summary =
        current.summary &&
        current.summary.coversTurns > seen
            ? current.summary
            : null;

    let budget = summary
        ? TRANSCRIPT_BUDGET_WITH_SUMMARY
        : TRANSCRIPT_BUDGET;

    /*
     * Keep the most recent turns verbatim, newest
     * first, until the budget runs out.
     */
    const replayed: string[] = [];

    for (
        let index = missing.length - 1;
        index >= 0;
        index -= 1
    ) {
        const formatted =
            formatTurn(missing[index]);

        if (
            formatted.length > budget &&
            replayed.length > 0
        ) {
            break;
        }

        replayed.unshift(formatted);
        budget -= formatted.length;
    }

    const omitted =
        missing.length - replayed.length;

    const from = [
        ...new Set(
            missing.map(
                (turn) => turn.harnessLabel,
            ),
        ),
    ];

    /*
     * Turns that came only from this agent's own
     * harness mean an earlier session of the same
     * agent, i.e. Agent Kitty was restarted.
     */
    const reason: Handoff['reason'] =
        from.every(
            (label) =>
                label === agent.harnessLabel,
        )
            ? 'restart'
            : 'switch';

    const intro =
        reason === 'restart'
            ? `Agent Kitty was restarted, so this is a new session, but the user can still see the earlier conversation below (held with ${from.join(', ')}). Continue it as if you remember it. Check the current state of any files before relying on it, and respond only to the new user message at the end.`
            : `The user switched coding agents during this conversation. The following happened with ${from.join(', ')} and you have not seen it. Treat it as background, check the current state of any files before relying on it, and respond only to the new user message at the end.`;

    const sections = [
        '[Agent Kitty handoff]',
        intro,
    ];

    if (summary) {
        sections.push(
            '',
            `## Handoff summary (written by ${summary.fromLabel})`,
            summary.text,
        );
    }

    sections.push(
        '',
        '## Recent turns (oldest first)',
    );

    if (omitted > 0) {
        sections.push(
            `(${omitted} earlier turn${omitted === 1 ? '' : 's'} omitted${summary ? '; see the summary above' : ''})`,
        );
    }

    sections.push(
        replayed.join('\n\n'),
        '',
        '[End of handoff]',
    );

    return {
        text: sections.join('\n'),
        from,
        mode: summary
            ? 'summary'
            : 'transcript',
        reason,
    };
}
