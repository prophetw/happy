import { readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { processProbeLimit, scanWorkspaceProcesses, type ProcessScope } from '../rest/workspaceProcessScan';

function readRequest(): unknown {
    const buffer = Buffer.alloc(processProbeLimit);
    let size = 0;
    while (size < buffer.length) {
        const count = readSync(0, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        const newline = buffer.subarray(size, size + count).indexOf(10);
        if (newline >= 0) return JSON.parse(buffer.toString('utf8', 0, size + newline));
        size += count;
    }
    throw new Error('missing process probe frame');
}

const ids = (values: unknown): values is number[] => Array.isArray(values)
    && values.every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647);

async function run() {
    const root = process.argv[2], request = readRequest() as Partial<ProcessScope> & { id?: string };
    if (process.argv.length !== 3 || root !== realpathSync(root) || !request || Object.keys(request).length !== 4
        || typeof request.id !== 'string' || !/^[a-f0-9]{64}$/.test(request.id)
        || !ids(request.pids) || !ids(request.groups) || !Array.isArray(request.sessions) || !request.sessions.length
        || !request.sessions.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('invalid probe scope');
    const cwd = join(root, request.id);
    if (cwd !== realpathSync(cwd)) throw new Error('invalid checkout path');
    const stat = statSync(cwd);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error('invalid checkout');
    return scanWorkspaceProcesses(cwd, { pids: request.pids, groups: request.groups, sessions: request.sessions });
}

const result = await run().catch(() => ({ confirmed: false, blockers: ['activity_visibility_unconfirmed'], fingerprint: '' }));
process.stdout.write(JSON.stringify(result) + '\n');
