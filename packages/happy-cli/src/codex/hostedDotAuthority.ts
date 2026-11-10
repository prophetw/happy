import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { hash, HOSTED_STATE_MAX_BYTES, HostedAuthorityMetadata, HostedDotConfig } from './hostedDotState';

export const HOSTED_INPUT_AUTHORITY_VERSION = 1 as const;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Input = z.object({ origin: z.enum(['user', 'task-result']).optional(), seq: integer.positive().optional(),
    id: z.string(), text: z.string(), permissionMode: z.string().optional(), epoch: integer.optional(),
    delivery: z.enum(['queue', 'steer']).optional(),
    status: z.enum(['queued', 'dispatching', 'accepted', 'completed', 'interrupted', 'failed', 'unknown', 'rejected'])
}).refine(row => row.origin === 'task-result' || row.seq !== undefined);
const Journal = z.object({ version: z.literal(1), binding: z.string(), epoch: integer,
    authority: HostedAuthorityMetadata,
    status: z.enum(['starting', 'ready', 'running', 'blocked', 'stopped']), inputs: z.array(Input).max(10000) });
export type HostedInputAuthority = {
    version: 1; dotId: string; sessionId: string; epoch: number; revision: number;
    producer: z.infer<typeof HostedAuthorityMetadata>['producer']; status: z.infer<typeof Journal>['status'];
    inputs: Array<Omit<z.infer<typeof Input>, 'origin' | 'seq'> & { origin: 'user'; seq: number }>;
};
/** Bounded descriptor reads avoid following links and stat/read replacement races. */
function stamp(file: string) { return lstatSync(file, { bigint: true }); }
function same(a: ReturnType<typeof stamp>, b: ReturnType<typeof stamp>): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function unchanged(file: string, before: ReturnType<typeof stamp>): void {
    if (!same(before, stamp(file))) throw new Error('hosted_authority_file_changed');
}
function readBounded(file: string) {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd, { bigint: true }), limit = BigInt(HOSTED_STATE_MAX_BYTES);
        if (!stat.isFile() || stat.size > limit) throw new Error('hosted_authority_file_invalid');
        const bytes = Buffer.alloc(Number(stat.size) + 1);
        let size = 0, n: number;
        while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += n;
        if (BigInt(size) !== stat.size) throw new Error('hosted_authority_file_changed');
        if (!same(stat, fstatSync(fd, { bigint: true }))) throw new Error('hosted_authority_file_changed');
        unchanged(file, stat);
        return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown, stamp: stat };
    } finally { closeSync(fd); }
}
/** Read-only, synchronous, fresh snapshot. Throws on unavailable or invalid authority.
 * This token is not a lifetime authorization: callers must verify producer liveness
 * and re-read immediately before each guarded operation. No recovery defaults apply.
 */
export function readHostedInputAuthority(expected: { directory: string; dotId: string; sessionId: string }): HostedInputAuthority {
    if (!expected || typeof expected.directory !== 'string' || !isAbsolute(expected.directory)
        || realpathSync(expected.directory) !== resolve(expected.directory)) throw new Error('hosted_authority_directory_invalid');
    const configFile = join(expected.directory, 'config.json'), stateFile = join(expected.directory, 'state.json');
    const configRead = readBounded(configFile), config = HostedDotConfig.parse(configRead.value);
    if (config.dotId !== expected.dotId || config.sessionId !== expected.sessionId || config.directory !== expected.directory)
        throw new Error('hosted_authority_binding_changed');
    const stateRead = readBounded(stateFile), state = Journal.parse(stateRead.value);
    const floorFile = join(expected.directory, 'reset-epoch.json');
    let floorRead: ReturnType<typeof readBounded> | undefined;
    try {
        floorRead = readBounded(floorFile);
        const floor = z.object({ epoch: integer }).parse(floorRead.value);
        if (floor.epoch > state.epoch) throw new Error('hosted_authority_epoch_changed');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const { effort, ...legacy } = config;
    if (state.binding !== hash(config) && state.binding !== hash(legacy)) throw new Error('hosted_authority_binding_changed');
    const inputs: HostedInputAuthority['inputs'] = [];
    const seqs = new Set<number>(), ids = new Set<string>();
    let lastSeq = 0;
    for (const row of state.inputs) {
        if (row.origin === 'task-result') continue;
        if (row.seq! <= lastSeq || seqs.has(row.seq!) || ids.has(row.id)) throw new Error('hosted_authority_duplicate_input');
        lastSeq = row.seq!; seqs.add(row.seq!); ids.add(row.id);
        inputs.push({ ...row, origin: 'user', seq: row.seq! });
    }
    if (floorRead) unchanged(floorFile, floorRead.stamp);
    else {
        try { stamp(floorFile); throw new Error('hosted_authority_epoch_changed'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    unchanged(configFile, configRead.stamp); unchanged(stateFile, stateRead.stamp);
    if (realpathSync(expected.directory) !== resolve(expected.directory)) throw new Error('hosted_authority_directory_invalid');
    return { version: 1, dotId: config.dotId, sessionId: config.sessionId, epoch: state.epoch,
        revision: state.authority.revision, producer: state.authority.producer, status: state.status, inputs };
}
