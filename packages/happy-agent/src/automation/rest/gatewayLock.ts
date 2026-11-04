import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from './schema';
import { privateDirectory, privateRead } from './privateFs';

/** One process per durable grant directory. Never silently take over a stale owner. */
export function lockGateway(directory: string) {
    privateDirectory(directory, true);
    const path = join(directory, '.gateway-owner'), instance = randomUUID();
    let fd: number;
    try { fd = openSync(path, 'wx', 0o600); } catch { throw new ApiError('GATEWAY_DIRECTORY_LOCKED', 503); }
    try { writeFileSync(fd, JSON.stringify({ instance, pid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); }
    return () => { if (JSON.parse(privateRead(path).toString('utf8')).instance !== instance) throw new ApiError('GATEWAY_DIRECTORY_LOCKED', 503); unlinkSync(path); };
}
