import { createConnection } from 'node:net';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { processProbeLimit, type Activity, type ProcessScope } from '../rest/workspaceProcessScan';

const resultSchema = z.object({ confirmed: z.boolean(), fingerprint: z.string().regex(/^(?:[a-f0-9]{64})?$/),
    blockers: z.array(z.enum(['activity_visibility_unconfirmed', 'process_visibility_unconfirmed',
        'live_session_or_process', 'process_entrypoint_reference', 'open_file_reference', 'mount_reference'])).max(6),
}).strict();

export function workspaceProcessProbe(socketPath: string, queueDirectory: string) {
    return async (cwd: string, scope: ProcessScope): Promise<Activity> => {
        const id = basename(cwd);
        if (!/^[a-f0-9]{64}$/.test(id) || cwd !== join(queueDirectory, 'worktrees', id)) throw new Error('invalid worktree for process probe');
        const request = JSON.stringify({ id, ...scope }) + '\n';
        if (Buffer.byteLength(request) > processProbeLimit) throw new Error('process probe request too large');
        return new Promise((resolve, reject) => {
            const socket = createConnection(socketPath);
            let response = '';
            const timeout = setTimeout(() => socket.destroy(new Error('process probe timed out')), 5000);
            socket.once('connect', () => socket.write(request));
            socket.setEncoding('utf8');
            socket.on('data', (chunk: string) => {
                response += chunk;
                if (Buffer.byteLength(response) > 4096) socket.destroy(new Error('process probe response too large'));
            });
            socket.once('error', reject);
            socket.once('end', () => {
                try { resolve(resultSchema.parse(JSON.parse(response))); }
                catch (error) { reject(error); }
            });
            socket.once('close', () => { clearTimeout(timeout); reject(new Error('process probe connection closed')); });
        });
    };
}
