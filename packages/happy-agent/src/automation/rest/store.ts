import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from '../journal';
import { ApiError } from './schema';
import { privateDirectory, privateRead } from './privateFs';

/** Non-secret metadata only. Corruption never becomes an empty/default grant store. */
export class MetadataStore {
    constructor(private directory: string, private maxBytes = 1024 * 1024) { privateDirectory(directory, true); }
    private path(key: string) { return join(this.directory, `${hash(key)}.json`); }
    get<T>(key: string): T | null {
        privateDirectory(this.directory);
        try { return JSON.parse(privateRead(this.path(key), this.maxBytes).toString('utf8')).value as T; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new ApiError('STORE_UNAVAILABLE', 503); }
    }
    list<T>(prefix: string): T[] {
        privateDirectory(this.directory);
        try { return readdirSync(this.directory).filter(p => /^[a-f0-9]{64}\.json$/.test(p)).map(p => JSON.parse(privateRead(join(this.directory, p)).toString('utf8'))).filter(v => typeof v.key === 'string' && v.key.startsWith(prefix)).map(v => v.value as T); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new ApiError('STORE_UNAVAILABLE', 503); }
    }
    claim(key: string, value: unknown): boolean {
        try { this.write(key, value, true); return true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
    }
    set(key: string, value: unknown) { this.write(key, value, false); }
    delete(key: string) {
        privateDirectory(this.directory);
        try { unlinkSync(this.path(key)); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw new ApiError('STORE_UNAVAILABLE', 503); }
        const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    }
    pruneExpired(now: number) {
        for (const record of this.list<{ expiresAt: number }>('proof:')) {
            if (!Number.isFinite(record.expiresAt)) throw new ApiError('STORE_UNAVAILABLE', 503);
        }
        try {
            for (const p of readdirSync(this.directory).filter(p => /^[a-f0-9]{64}\.json$/.test(p))) {
                const record = JSON.parse(privateRead(join(this.directory, p)).toString('utf8'));
                if (record.key.startsWith('proof:') && record.value.expiresAt < now) unlinkSync(join(this.directory, p));
            }
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ApiError('STORE_UNAVAILABLE', 503); }
    }
    private write(key: string, value: unknown, exclusive: boolean) {
        privateDirectory(this.directory);
        const path = this.path(key), target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
        const fd = openSync(target, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ key, value })); fsyncSync(fd); } finally { closeSync(fd); }
        if (!exclusive) renameSync(target, path);
        const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    }
}
