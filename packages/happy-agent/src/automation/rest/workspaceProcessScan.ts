import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

export type Activity = { confirmed: boolean; blockers: string[]; fingerprint: string };
export type ProcessScope = { pids: number[]; groups: number[]; sessions: string[] };
export const processProbeLimit = 64 * 1024;

const inside = (path: string, root: string) => path === root || path.startsWith(root + '/');
const decodeMountPath = (path: string) => path.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const vanished = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Shared by local CLI inspection and the socket-activated Linux probe. */
export async function scanWorkspaceProcesses(cwd: string, scope: ProcessScope): Promise<Activity> {
    const names = readdirSync('/proc').filter(name => /^\d+$/.test(name));
    if (names.length > 32768) throw new Error('process scan limit');
    const blockers = new Set<string>(), mounts = new Set<string>(), identities: string[] = [];
    const pids = new Set(scope.pids), groups = new Set(scope.groups), sessions = new Set(scope.sessions);
    const pathArgument = Buffer.from(cwd);
    let inspected = 0;
    for (const name of names) {
        if (++inspected % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        try {
            const path = `/proc/${name}`;
            const first = readFileSync(path + '/stat', 'utf8');
            const fields = first.slice(first.lastIndexOf(')') + 2).split(/\s+/);
            if (['Z', 'X'].includes(fields[0])) continue;
            const workingDirectory = readlinkSync(path + '/cwd');
            if (inside(workingDirectory, cwd) || pids.has(Number(name)) || groups.has(Number(fields[2]))) blockers.add('live_session_or_process');
            const argv = readFileSync(path + '/cmdline');
            if (argv.includes(pathArgument)) blockers.add('process_entrypoint_reference');
            if (argv.toString('utf8').split('\0').some(arg => sessions.has(arg))) blockers.add('live_session_or_process');
            for (const fd of readdirSync(path + '/fd')) {
                try {
                    if (inside(readlinkSync(path + '/fd/' + fd).replace(/ \(deleted\)$/, ''), cwd)) blockers.add('open_file_reference');
                } catch (error) { if (!vanished(error)) throw error; }
            }
            const namespace = readlinkSync(path + '/ns/mnt');
            if (!mounts.has(namespace)) {
                for (const line of readFileSync(path + '/mountinfo', 'utf8').split('\n').filter(Boolean)) {
                    const fields = line.split(' ');
                    const source = decodeMountPath(fields[3]), target = decodeMountPath(fields[4]);
                    if (inside(target, cwd) || source !== '/' && (inside(source, cwd) || inside(cwd, source))) blockers.add('mount_reference');
                }
                mounts.add(namespace);
            }
            const last = readFileSync(path + '/stat', 'utf8');
            if (last.slice(last.lastIndexOf(')') + 2).split(/\s+/)[19] !== fields[19]) throw new Error('process identity changed');
            identities.push(`${name}:${fields[19]}:${workingDirectory}:${namespace}`);
        } catch (error) {
            if (!vanished(error)) blockers.add('process_visibility_unconfirmed');
        }
    }
    return { confirmed: !blockers.has('process_visibility_unconfirmed'), blockers: [...blockers].sort(),
        fingerprint: createHash('sha256').update(JSON.stringify(identities.sort())).digest('hex') };
}
