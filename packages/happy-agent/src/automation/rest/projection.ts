import { createReceiptErrorCode, redact } from '../control';
import { ApiError } from './schema';
import { codeBuddyOptionsDetailsSchema, launchModelValue } from './options';

const fields = new Set(['version','ok','requestID','data','error','code','retryable','instruction','taskID','machineID','sessionID','state',
    'messageID','seq','process','safeToRetrySameRequestID','hasMore','reconciliationCursor','machines','sessions','availability','activeAt',
    'nextCursor','turn','kind','turnID','waitingForPermission','pendingInputs','inputID','blocking','messages','text','truncated','attribution','ready','outcome',
    // Launch-option discovery and the resolved tasks.create selection. Keys only.
    'options','agents','agent','models','permissionModes','efforts','defaultAgent','defaultModel','defaultPermissionMode','defaultEffort',
    'model','permissionMode','effort','execution','executionState','executionDispatched','queueID','queueReason','canCancel','recovery','mode','directory','branch','baseCommit','projectID','port','resources','resultCommit','dirty','workspaceState','retainedRef','retainedCommit',
    'checkoutDigest','reviewPending','candidateCommit','candidateTree','testResult','testCleanup','command','exitCode']);
/** Last boundary: never serialize arbitrary worker objects or transport errors to a cloud caller. */
export function projectResponse(input: unknown): Record<string, unknown> {
    const project = (value: unknown, depth: number, key = ''): unknown => {
        if (depth > 8) throw new ApiError('INVALID_WORKER_RESPONSE', 502);
        if (typeof value === 'string' && ['directory','branch','recovery'].includes(key)) return redact(value).slice(0, 4096);
        if (typeof value === 'string' && key === 'command') return redact(value).slice(0, 300);
        if (typeof value === 'string' && key === 'retainedRef') return /^refs\/happy\/workspaces\/[a-f0-9]{64}\/[a-f0-9]{40,64}$/.test(value) ? value : 'unknown';
        if (typeof value === 'string') return key === 'text' ? redact(value).slice(0,16000) : key === 'instruction' ? undefined
            : ['models', 'model', 'defaultModel'].includes(key) && launchModelValue.safeParse(value).success ? value
            : /^[A-Za-z0-9_:.\-]{0,256}$/.test(value) ? value : 'unknown';
        if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
        if (Array.isArray(value)) { if (value.length > 500) throw new ApiError('INVALID_WORKER_RESPONSE', 502); return value.map(v => project(v, depth+1,key)); }
        if (!value || typeof value !== 'object') return undefined;
        const projected = Object.fromEntries(Object.entries(value).filter(([k]) => fields.has(k)).map(([k,v]) => [k, project(v, depth+1,k)]));
        if (depth === 1 && key === 'data' && Array.isArray(projected.agents)
            && projected.agents.some(agent => agent?.agent === 'codebuddy')) {
            const details = codeBuddyOptionsDetailsSchema.safeParse((value as Record<string, unknown>).codebuddy);
            if (details.success) projected.codebuddy = details.data;
        }
        if (depth === 1 && key === 'data' && typeof projected.requestID === 'string' && projected.taskID === projected.requestID
            && projected.sessionID === undefined && projected.safeToRetrySameRequestID === false) {
            const errorCode = createReceiptErrorCode(projected.state, (value as Record<string, unknown>).errorCode);
            if (errorCode) projected.errorCode = errorCode;
        }
        return projected;
    };
    const object = input as { version?: unknown; ok?: unknown } | null;
    if (!object || object.version !== 1 || typeof object.ok !== 'boolean') throw new ApiError('INVALID_WORKER_RESPONSE', 502);
    return project(input,0) as Record<string, unknown>;
}
