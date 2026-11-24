import { createHash } from 'node:crypto';
import type { HostedArchivedInput } from './hostedDotStorage';
import type { HostedState } from './hostedDotState';

const HIGH_ROWS = 8000, LOW_ROWS = 4000;
const HIGH_JOURNAL_BYTES = 24 * 1024 * 1024;
const LOW_INPUT_BYTES = 12 * 1024 * 1024;
const settled = new Set(['completed', 'failed', 'interrupted', 'rejected']);
const unresolved = new Set(['dispatching', 'accepted', 'unknown']);

/**
 * Keep a rolling window of the Relay inputs already resolved on this thread.
 * This does not touch Relay history, task-result dedupe, or unconfirmed outputs.
 * Persist the retained rows and watermark in the existing writer transaction.
 */
export function checkpointHostedUserInputs(state: HostedState, previousJournalBytes: number): HostedArchivedInput[] {
    const overRows = state.inputs.length >= HIGH_ROWS;
    if (!overRows && previousJournalBytes < HIGH_JOURNAL_BYTES) return [];
    if (!state.threadId || state.authority === undefined || state.creating || state.bootstrap?.stage === 'injecting'
        || state.inputs.some(row => unresolved.has(row.status)) || state.outputs.some(row => !row.sent)) return [];
    // Keep a real dispatched row. Its current-epoch native turn is required to
    // resume the existing thread and fence recovery of unbound dispatches.
    let anchor: HostedState['inputs'][number] | undefined;
    for (let i = state.inputs.length - 1; i >= 0; i--) {
        const row = state.inputs[i];
        if (row.epoch === state.epoch && row.turnId && row.beforeTurns !== undefined && settled.has(row.status)) {
            anchor = row;
            break;
        }
    }
    if (!anchor) return [];
    const size = (row: HostedState['inputs'][number]) => Buffer.byteLength(JSON.stringify(row)) + 1;
    const measure = previousJournalBytes >= HIGH_JOURNAL_BYTES;
    let inputBytes = measure ? state.inputs.reduce((n, row) => n + size(row), 0) : 0;
    let remaining = state.inputs.length, retired = state.retiredUserSeq ?? 0;
    const remove = new Set<HostedState['inputs'][number]>();
    for (const row of state.inputs) {
        if (remaining <= LOW_ROWS && inputBytes <= LOW_INPUT_BYTES) break;
        if (row.origin === 'task-result') continue;
        // Do not advance past any retained user input. Keep the latest native
        // anchor even if rejected or pending rows would otherwise fill the window.
        if (row === anchor || row.epoch !== state.epoch || row.seq === undefined || row.seq <= retired
            || row.seq > state.afterSeq || !settled.has(row.status)
            || (row.status !== 'rejected' && !row.turnId)) break;
        remove.add(row);
        retired = row.seq;
        remaining--;
        if (measure) inputBytes -= size(row);
    }
    if (remove.size) {
        state.inputs = state.inputs.filter(row => !remove.has(row));
        state.retiredUserSeq = retired;
    }
    return [...remove].map(row => ({
        epoch: row.epoch, seq: row.seq!, id: row.id, status: row.status as HostedArchivedInput['status'],
        textDigest: 'sha256:' + createHash('sha256').update(JSON.stringify(row.text)).digest('hex'),
        ...(row.permissionMode === undefined ? {} : { permissionMode: row.permissionMode }),
    }));
}

/** Never match by text against turns retired from the active input journal. */
export function hostedUnboundRecoveryTurns<T extends { id: string }>(
    turns: T[], beforeTurns: string[] | undefined, compacted: boolean,
): T[] {
    const excluded = new Set(beforeTurns ?? []);
    if (!compacted) return turns.filter(turn => !excluded.has(turn.id));
    if (!beforeTurns?.length || !turns.some(turn => turn.id === beforeTurns.at(-1))) return [];
    for (let i = turns.length - 1; i >= 0; i--) {
        if (excluded.has(turns[i].id)) return turns.slice(i + 1);
    }
    return [];
}
