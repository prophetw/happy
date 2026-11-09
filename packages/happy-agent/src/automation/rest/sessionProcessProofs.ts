import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { MetadataStore } from './store';
import { canonicalRepository } from './taskWorkspaces';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const absolute = z.string().min(1).max(4096).refine(isAbsolute);
export const LinuxProcessIdentitySchema = z.object({
    pid: z.number().int().positive(), uid: z.number().int().nonnegative(),
    bootID: z.string().uuid(), startTicks: z.string().regex(/^\d{1,32}$/),
    cwd: absolute, cgroup: z.string().min(1).max(4096),
}).strict();
export type LinuxProcessIdentity = z.infer<typeof LinuxProcessIdentitySchema>;
const proofSchema = z.object({ version: z.literal(1), machineID: identifier, sessionID: identifier,
    directory: absolute, repository: absolute, identity: LinuxProcessIdentitySchema,
    recordedAt: z.number().int().nonnegative(), source: z.enum(['rpc-running', 'operator-verified']),
}).strict();
type Session = { id: string; metadata: unknown };

/** Existence is not daemon ownership. This fingerprint is used only for scheduling. */
export function readLinuxProcess(pid: number): LinuxProcessIdentity | null {
    if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
        const root = `/proc/${pid}`;
        const first = readFileSync(`${root}/stat`, 'utf8');
        const before = first.slice(first.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (['Z', 'X'].includes(before[0])) return null;
        const uid = statSync(root).uid;
        const bootID = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        const cwd = realpathSync(readlinkSync(`${root}/cwd`));
        const cgroup = readFileSync(`${root}/cgroup`, 'utf8');
        const last = readFileSync(`${root}/stat`, 'utf8');
        const after = last.slice(last.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (before[19] !== after[19] || ['Z', 'X'].includes(after[0]) || statSync(root).uid !== uid
            || readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== bootID
            || realpathSync(readlinkSync(`${root}/cwd`)) !== cwd || readFileSync(`${root}/cgroup`, 'utf8') !== cgroup) return null;
        return LinuxProcessIdentitySchema.parse({ pid, uid, bootID, startTicks: after[19], cwd, cgroup });
    } catch { return null; }
}
const sameIdentity = (a: LinuxProcessIdentity, b: LinuxProcessIdentity) =>
    a.pid === b.pid && a.uid === b.uid && a.bootID === b.bootID && a.startTicks === b.startTicks && a.cwd === b.cwd && a.cgroup === b.cgroup;

/** Machine-local corroboration, never a grant, running-status override, or kill right. */
export class SessionProcessProofs {
    private readonly store: MetadataStore;
    private readonly inspect: (pid: number) => LinuxProcessIdentity | null;
    constructor(readonly directory: string, readonly machineID: string,
        options: { inspect?: (pid: number) => LinuxProcessIdentity | null } = {}) {
        identifier.parse(machineID);
        this.store = new MetadataStore(directory);
        this.inspect = options.inspect ?? readLinuxProcess;
    }
    private target(session: Session) {
        identifier.parse(session.id);
        const metadata = session.metadata as { machineId?: unknown; hostPid?: unknown; path?: unknown } | null;
        if (!metadata || metadata.machineId !== this.machineID || !Number.isSafeInteger(metadata.hostPid) || Number(metadata.hostPid) <= 0
            || typeof metadata.path !== 'string' || !isAbsolute(metadata.path) || realpathSync(metadata.path) !== metadata.path || !statSync(metadata.path).isDirectory()) return null;
        const identity = this.inspect(Number(metadata.hostPid));
        if (!identity || !LinuxProcessIdentitySchema.safeParse(identity).success || identity.pid !== metadata.hostPid || identity.uid !== process.getuid?.() || identity.cwd !== metadata.path) return null;
        return { identity, directory: metadata.path, repository: canonicalRepository(metadata.path) };
    }
    private record(session: Session, source: 'rpc-running' | 'operator-verified', expected?: LinuxProcessIdentity): boolean {
        try {
            const target = this.target(session);
            if (!target || expected && !sameIdentity(target.identity, LinuxProcessIdentitySchema.parse(expected))) return false;
            const key = `session:${session.id}`, prior = this.store.get<unknown>(key);
            if (prior !== null && !proofSchema.safeParse(prior).success) return false;
            const current = this.inspect(target.identity.pid);
            if (!current || !sameIdentity(current, target.identity)) return false;
            if (prior !== null) {
                const saved = proofSchema.parse(prior);
                if (saved.machineID === this.machineID && saved.sessionID === session.id && saved.directory === target.directory
                    && saved.repository === target.repository && sameIdentity(saved.identity, target.identity)) return true;
            }
            this.store.set(key, proofSchema.parse({ version: 1, machineID: this.machineID, sessionID: session.id, ...target, recordedAt: Date.now(), source }));
            return true;
        } catch { return false; }
    }
    recordRunning(session: Session, rpcProcess: unknown): boolean {
        return rpcProcess === 'running' && this.record(session, 'rpc-running');
    }
    /** Called as the original OS user after the root bootstrap verifies maintenance evidence. */
    importVerified(session: Session, expected: LinuxProcessIdentity): boolean {
        return this.record(session, 'operator-verified', expected);
    }
    verify(session: Session): boolean {
        try {
            const proof = proofSchema.parse(this.store.get(`session:${session.id}`));
            const target = this.target(session);
            if (!target) return false;
            return proof.machineID === this.machineID && proof.sessionID === session.id && proof.directory === target.directory
                && proof.repository === target.repository && sameIdentity(proof.identity, target.identity);
        } catch { return false; }
    }
}
