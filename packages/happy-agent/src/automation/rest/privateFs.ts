import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError } from './schema';

/** Linux/WSL service state must be owned by this uid, private, and never a symlink. */
export function privateDirectory(path: string, create = false) {
    try {
        if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
        const stat = lstatSync(path), uid = process.getuid?.();
        // Ownership and mode bits only exist on POSIX; Windows reports uid 0 and 0o666 modes.
        if (!stat.isDirectory() || stat.isSymbolicLink()
            || (uid !== undefined && ((stat.mode & 0o077) !== 0 || stat.uid !== uid))
            || realpathSync(path) !== resolve(path)) throw new Error();
    } catch { throw new ApiError('UNSAFE_PRIVATE_DIRECTORY', 503); }
}
export function privateRead(path: string, maxBytes = 1024 * 1024): Buffer {
    let fd: number | undefined;
    try {
        if (realpathSync(path) !== resolve(path)) throw new Error();
        const uid = process.getuid?.();
        fd = openSync(path, constants.O_RDONLY | (uid !== undefined ? constants.O_NOFOLLOW : 0));
        const s = fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || s.size > maxBytes
            || (uid !== undefined && (s.uid !== uid || (s.mode & 0o077) !== 0))) throw new Error();
        return readFileSync(fd);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error; throw new ApiError('PRIVATE_MATERIAL_UNAVAILABLE', 503); }
    finally { if (fd !== undefined) closeSync(fd); }
}
