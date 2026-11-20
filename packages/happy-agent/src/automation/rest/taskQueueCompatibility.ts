import { z } from 'zod';
import { checkoutDigest, executionSchema, objectID, testEvidenceSchema } from './execution';
import { ApiError } from './schema';
import type { QueueTask, Workspace } from './taskQueue';

type QueueRecords = { workspaces: Workspace[]; tasks: QueueTask[] };
const key = 'happyCandidateV1';
const deferred = Number.MAX_SAFE_INTEGER;
const reviewHold = 'candidate_review';
const record = z.strictObject({
    execution: executionSchema,
    candidateTree: objectID.optional(),
    testCleanup: z.enum(['removed', 'retained']).optional(),
    hadOptions: z.boolean(),
    defaultResolvedOptions: z.boolean(),
    tasks: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.strictObject({
        checkoutDigest: checkoutDigest.optional(),
        reviewReleased: z.boolean().optional(),
        testResult: testEvidenceSchema.optional(),
        notBefore: z.number().nonnegative().optional(),
        held: z.strictObject({ dispatched: z.boolean(), reason: z.string().max(256).optional(),
            finishedAt: z.number().nonnegative().optional() }).optional(),
    })),
});

export const holdsReviewCheckout = (t: QueueTask) => t.state === 'completed' && !!t.checkoutDigest && !t.reviewReleased;

/** Decode under the queue flock. Older readers preserve the same record inside opaque options. */
export function decodeCandidates(state: QueueRecords) {
    let byID: Map<string, QueueTask> | undefined;
    for (const workspace of state.workspaces) {
        if (!workspace.options || !Object.hasOwn(workspace.options, key)) continue;
        const { [key]: raw, ...options } = workspace.options;
        const value = record.safeParse(raw);
        if (!value.success || workspace.execution.handoff || workspace.execution.candidate
            || value.data.execution.mode !== workspace.execution.mode
            || JSON.stringify(value.data.execution.resources) !== JSON.stringify(workspace.execution.resources))
            throw new ApiError('QUEUE_CORRUPT', 503);
        const { execution, candidateTree, testCleanup, hadOptions, defaultResolvedOptions, tasks } = value.data;
        Object.assign(workspace, { execution, candidateTree, testCleanup, options: hadOptions ? options : undefined });
        if (defaultResolvedOptions) workspace.resolvedOptions = undefined;
        if (!Object.keys(tasks).length) continue;
        byID ??= new Map(state.tasks.map(t => [t.id, t]));
        for (const [id, { held, notBefore, ...evidence }] of Object.entries(tasks)) {
            const task = byID.get(id);
            if (!task || task.workspaceID !== workspace.id) throw new ApiError('QUEUE_CORRUPT', 503);
            Object.assign(task, evidence);
            if (task.notBefore === deferred) task.notBefore = notBefore;
            if (held && task.state === 'blocked' && task.reason === reviewHold && !task.dispatched)
                Object.assign(task, held, { state: 'completed', reason: held.reason, finishedAt: held.finishedAt });
            else if (held && task.state === 'cancelled' && !task.dispatched)
                Object.assign(task, held, { state: 'completed', reason: held.reason, finishedAt: held.finishedAt, reviewReleased: true });
            else if (held) throw new ApiError('QUEUE_CORRUPT', 503);
        }
    }
}

/** Keep the v2 ledger readable by the fixed rollback Worker. A held completion
 * occupies the original checkout in its scheduler. Queued candidate turns wait
 * for a capable Worker, and its strict launch check refuses new unbound sends. */
export function encodeCandidates<T extends QueueRecords>(state: T): T {
    if (!state.workspaces.some(w => w.execution.candidate || w.execution.handoff || w.candidateTree !== undefined || w.testCleanup !== undefined)
        && !state.tasks.some(t => t.checkoutDigest !== undefined || t.reviewReleased !== undefined || t.testResult !== undefined)) return state;
    const extensions = new Map<string, z.infer<typeof record>['tasks']>();
    const workspaces = new Map(state.workspaces.map(w => [w.id, w]));
    const tasks = state.tasks.map(task => {
        const workspace = task.workspaceID ? workspaces.get(task.workspaceID) : undefined;
        const { checkoutDigest, reviewReleased, testResult, ...stored } = task;
        const evidence = checkoutDigest !== undefined || reviewReleased !== undefined || testResult !== undefined;
        const hold = holdsReviewCheckout(task);
        const postpone = !task.dispatched && ['queued', 'waiting-resource', 'preparing'].includes(task.state)
            && Boolean(workspace?.execution.candidate || workspace?.execution.handoff);
        if (!evidence && !postpone) return task;
        if (!workspace) throw new ApiError('QUEUE_STATE_INVALID', 503);
        let entries = extensions.get(workspace.id);
        if (!entries) { entries = {}; extensions.set(workspace.id, entries); }
        entries[task.id] = { checkoutDigest, reviewReleased, testResult,
            ...(postpone ? { notBefore: task.notBefore } : {}),
            ...(hold ? { held: { dispatched: task.dispatched, reason: task.reason, finishedAt: task.finishedAt } } : {}) };
        if (postpone) stored.notBefore = deferred;
        if (hold) Object.assign(stored, { state: 'blocked', dispatched: false, reason: reviewHold });
        return stored;
    });
    return { ...state, tasks, workspaces: state.workspaces.map(workspace => {
        const { candidateTree, testCleanup, execution, options, resolvedOptions, ...rest } = workspace;
        const entries = extensions.get(workspace.id);
        if (!execution.candidate && !execution.handoff && candidateTree === undefined && testCleanup === undefined && !entries) return workspace;
        const value = { execution, candidateTree, testCleanup, hadOptions: options !== undefined,
            defaultResolvedOptions: resolvedOptions === undefined, tasks: entries ?? {} };
        return { ...rest, execution: { mode: execution.mode, resources: execution.resources },
            options: { ...options, [key]: value }, resolvedOptions: resolvedOptions === undefined ? {} : resolvedOptions };
    }) };
}
