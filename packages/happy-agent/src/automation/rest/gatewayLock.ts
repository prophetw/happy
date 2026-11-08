import { constants, existsSync, openSync, writeFileSync, fsyncSync, closeSync, fstatSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from './schema';
import { privateDirectory, privateRead } from './privateFs';

/** Linux flock survives helper exit and releases on process death/reboot. The marker is audit metadata. */
export function lockGateway(directory: string) {
    privateDirectory(directory, true);
    const path = join(directory, '.gateway-owner'), instance = randomUUID();
    let fd: number | undefined;
    try {
        // Never unlink this inode: all contenders must lock the same open file description.
        fd = openSync(join(directory, '.gateway-lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error();
        if (spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 5000 }).status !== 0) throw new Error();
        // An old binary did not hold the kernel lock. Require an explicit stopped-service migration for its marker.
        if (existsSync(path) && JSON.parse(privateRead(path).toString('utf8')).version !== 2) throw new Error();
        const marker = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(marker, JSON.stringify({ version: 2, instance, pid: process.pid })); fsyncSync(marker); } finally { closeSync(marker); }
    } catch { if (fd !== undefined) closeSync(fd); throw new ApiError('GATEWAY_DIRECTORY_LOCKED', 503); }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        try { if (JSON.parse(privateRead(path).toString('utf8')).instance !== instance) throw new ApiError('GATEWAY_DIRECTORY_LOCKED', 503); unlinkSync(path); }
        finally { closeSync(fd!); }
    };
}
