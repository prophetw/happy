import { existsSync, lstatSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { SessionEnvelope } from '@slopus/happy-wire';

export const HOSTED_STATE_MAX_BYTES = 32 * 1024 * 1024;

export const HostedDotConfig = z.strictObject({ version: z.literal(1), dotId: z.string().uuid(), sessionId: z.string().min(1),
    happyHome: z.string().startsWith('/'), serverUrl: z.string().url(), directory: z.string().startsWith('/'),
    executable: z.string().min(1), args: z.array(z.string()), model: z.string().min(1), effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).default('xhigh'), provider: z.string().regex(/^[A-Za-z0-9_-]+$/),
    providerConfig: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}), instruction: z.string().min(1),
    bootstrap: z.strictObject({ file: z.string().startsWith('/'), digest: z.string().regex(/^[a-f0-9]{64}$/), afterSeq: z.number().int().nonnegative() }).optional(),
    codexHome: z.string().startsWith('/'), environment: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(s => !['CODEX_HOME', 'HOME', 'HAPPY_HOME_DIR', 'NODE_OPTIONS'].includes(s), 'reserved_environment')).default([]) });
export type HostedDotConfig = z.infer<typeof HostedDotConfig>;
const Input = z.object({ epoch: z.number().int().nonnegative().default(0), delivery: z.enum(['queue', 'steer']).default('queue'), origin: z.enum(['user','task-result']).optional(), seq: z.number().int().positive().optional(), id: z.string(), text: z.string(), permissionMode: z.string().optional(),
    status: z.enum(['queued', 'dispatching', 'accepted', 'completed', 'interrupted', 'failed', 'unknown', 'rejected']),
    turnId: z.string().optional(), beforeTurns: z.array(z.string()).optional(), error: z.string().optional() }).refine(row => row.origin === 'task-result' || row.seq !== undefined, 'hosted_user_receipt_required');
export const HostedAuthorityMetadata = z.strictObject({ version: z.literal(1),
    producer: z.strictObject({ pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        start: z.string().regex(/^[0-9]+$/), boot: z.string().uuid() }),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
/** Linux process identity, not just a reusable PID. Unsupported hosts fail closed. */
export function hostedProducerIdentity(): z.infer<typeof HostedAuthorityMetadata>['producer'] {
    if (process.platform !== 'linux') throw new Error('hosted_authority_platform_unsupported');
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    return HostedAuthorityMetadata.shape.producer.parse({ pid: process.pid,
        start: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19],
        boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() });
}
/** @internal Full journal validation shared by Happy-owned lifecycle operations. */
export const HostedDotJournal = z.object({ authority: HostedAuthorityMetadata.optional(), version: z.literal(1), binding: z.string(), epoch: z.number().int().nonnegative(),
    threadId: z.string().nullable(), creating: z.boolean(), afterSeq: z.number().int().nonnegative(),
    status: z.enum(['starting', 'ready', 'running', 'blocked', 'stopped']), error: z.string().nullable(),
    bootstrap: z.object({ stage: z.enum(['injecting', 'applied']), threadId: z.string() }).optional(),
    inputs: z.array(Input).max(10000), outputs: z.array(z.object({ localId: z.string(), envelope: z.unknown(), sent: z.boolean() })).max(50000),
    controls: z.array(z.string()).default([]) });
export type HostedState = z.infer<typeof HostedDotJournal>;
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function readPrivate(file: string): any {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > HOSTED_STATE_MAX_BYTES) throw new Error('hosted_file_invalid');
    return JSON.parse(readFileSync(file, 'utf8'));
}
export function savePrivate(file: string, value: unknown): void {
    const tmp = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
}
export function loadHostedState(file: string, config: HostedDotConfig): HostedState {
    const binding = hash(config);
    const state = existsSync(file) ? HostedDotJournal.parse(readPrivate(file)) : HostedDotJournal.parse({ version: 1, binding, epoch: existsSync(config.directory + '/reset-epoch.json') ? z.object({ epoch: z.number().int().nonnegative() }).parse(readPrivate(config.directory + '/reset-epoch.json')).epoch : 0, threadId: null,
        creating: false, afterSeq: config.bootstrap?.afterSeq ?? 0, status: 'starting', error: null, inputs: [], outputs: [] });
    if (state.binding !== binding) {
        const { effort, ...legacy } = config;
        if (state.binding !== hash(legacy)) throw new Error('hosted_binding_changed');
        state.binding = binding;
    }
    if (existsSync(config.directory + '/reset-epoch.json') && z.object({ epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).parse(readPrivate(config.directory + '/reset-epoch.json')).epoch > state.epoch)
        throw new Error('hosted_epoch_stale');
    if (state.bootstrap?.stage === 'injecting') throw new Error('hosted_bootstrap_unconfirmed');
    return state;
}
export function addOutput(state: HostedState, envelope: SessionEnvelope): void {
    const localId = `hosted:${state.epoch}:${envelope.id}`;
    const existing = state.outputs.find(o => o.localId === localId);
    if (!existing) state.outputs.push({ localId, envelope, sent: false });
}

export const HostedTaskGateway = z.strictObject({ version: z.literal(1), dotId: z.string().uuid(), sessionId: z.string(), servers: z.record(z.string().regex(/^(?:(?:happy|mcp)_[A-Za-z0-9_-]+|dot_memory)$/),
    z.strictObject({ command: z.string().startsWith('/'), args: z.array(z.string()).max(16), startup_timeout_sec: z.literal(30), tool_timeout_sec: z.number().int().min(1).max(120), required: z.literal(true), default_tools_approval_mode: z.literal('approve') })) });
export const HostedTaskEvent = z.strictObject({ version: z.literal(1), id: z.string().regex(/^task-[a-f0-9]{64}$/), dotId: z.string().uuid(), sessionId: z.string(), epoch: z.number().int().nonnegative(), createdAt: z.string().datetime(), text: z.string().min(1).max(18000) });
