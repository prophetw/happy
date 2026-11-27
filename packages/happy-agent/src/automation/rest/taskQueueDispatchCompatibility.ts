import { z } from 'zod';
import { executionSchema, restrictedExecution } from './execution';
import { QueueLedgerError } from './schema';
import type { QueueTask, Workspace } from './taskQueue';

type State = { workspaces: Workspace[]; tasks: QueueTask[] };
const key = 'happyDispatchV1';
const deferred = Number.MAX_SAFE_INTEGER;
const timestamp = z.number().int().positive().optional();
const evidence = z.strictObject({
    resourceAt: timestamp, startedAt: timestamp, endedAt: timestamp,
    postponed: z.literal(true).optional(), notBefore: z.number().nonnegative().optional(),
});
const extension = z.strictObject({
    execution: executionSchema.optional(), hadOptions: z.boolean(), defaultResolvedOptions: z.boolean(),
    tasks: z.record(z.string().regex(/^[a-f0-9]{64}$/), evidence),
});

/** The rollback Worker understands v2 and preserves the opaque workspace options.
 * It cannot dispatch restricted turns: scheduling is deferred on disk and its
 * strict launch-options check rejects the marker even for a newly enqueued send. */
export function encodeDispatch<T extends State>(state: T): T {
    const workspaceByID = new Map(state.workspaces.map(workspace => [workspace.id, workspace]));
    const entries = new Map<string, Record<string, z.infer<typeof evidence>>>();
    const tasks = state.tasks.map(task => {
        const { resourceAt, startedAt, endedAt, ...stored } = task;
        const workspace = workspaceByID.get(task.workspaceID ?? '');
        const postponed = restrictedExecution(workspace?.execution.mode) && !task.dispatched
            && ['queued', 'waiting-resource', 'preparing'].includes(task.state);
        if (resourceAt === undefined && startedAt === undefined && endedAt === undefined && !postponed) return task;
        if (!workspace) return stored;
        const records = entries.get(workspace.id) ?? {};
        records[task.id] = { resourceAt, startedAt, endedAt,
            ...(postponed ? { postponed: true, notBefore: task.notBefore } : {}) };
        entries.set(workspace.id, records);
        if (postponed) stored.notBefore = deferred;
        return stored;
    });
    const workspaces = state.workspaces.map(workspace => {
        const { execution, options, resolvedOptions } = workspace;
        const restricted = restrictedExecution(execution.mode);
        const records = entries.get(workspace.id);
        if (!restricted && !execution.retireAfterIntegration && !records) return workspace;
        const { retireAfterIntegration: _retire, ...rollback } = execution;
        const stored = { execution: restricted || execution.retireAfterIntegration ? execution : undefined, tasks: records ?? {},
            hadOptions: options !== undefined, defaultResolvedOptions: restricted && resolvedOptions === undefined };
        return { ...workspace, execution: restricted ? { mode: 'read-only' as const, resources: execution.resources } : rollback,
            options: { ...options, [key]: stored }, resolvedOptions: stored.defaultResolvedOptions ? {} : resolvedOptions };
    });
    return { ...state, workspaces, tasks };
}

export function decodeDispatch(state: State) {
    let tasks: Map<string, QueueTask> | undefined;
    for (const workspace of state.workspaces) {
        if (!workspace.options || !Object.hasOwn(workspace.options, key)) continue;
        const { [key]: raw, ...options } = workspace.options;
        const parsed = extension.safeParse(raw);
        if (!parsed.success) throw new QueueLedgerError('compatibility');
        const { execution, hadOptions, defaultResolvedOptions, tasks: rows } = parsed.data;
        const restricted = restrictedExecution(execution?.mode);
        if (execution && (workspace.execution.mode !== (restricted ? 'read-only' : execution.mode)
            || JSON.stringify(workspace.execution.resources) !== JSON.stringify(execution.resources)))
            throw new QueueLedgerError('compatibility');
        if (execution) workspace.execution = execution;
        workspace.options = hadOptions ? options : undefined;
        if (defaultResolvedOptions) workspace.resolvedOptions = undefined;
        if (!Object.keys(rows).length) continue;
        tasks ??= new Map(state.tasks.map(task => [task.id, task]));
        for (const [id, { postponed, notBefore, ...timing }] of Object.entries(rows)) {
            const task = tasks.get(id);
            if (!task || task.workspaceID !== workspace.id || postponed && !restricted) throw new QueueLedgerError('compatibility');
            Object.assign(task, timing);
            if (postponed && task.notBefore === deferred) task.notBefore = notBefore;
        }
    }
}
