import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ControlError } from './relay';

export type RecordEntry = {
    requestID: string; fingerprint: string; method: string; machineID: string;
    sessionID?: string; directory?: string; state: string; messageID?: string; seq?: number;
    cursor?: number;
    /** Raw requested launch options (tasks.create only); never credentials or prompts. */
    options?: { agent?: string; model?: string; permissionMode?: string; effort?: string };
};
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** Single-writer claim across processes; no prompt, credential or plaintext log persistence. */
export class Journal {
    constructor(private directory: string) {}
    private path(id: string) { return join(this.directory, `${hash(id)}.json`); }
    get(id: string): RecordEntry | null {
        try { return JSON.parse(readFileSync(this.path(id), 'utf8')) as RecordEntry; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw new ControlError('JOURNAL_UNAVAILABLE');
        }
    }
    entries(): RecordEntry[] {
        try { return readdirSync(this.directory).filter(p => /^[a-f0-9]{64}\.json$/.test(p)).map(p => JSON.parse(readFileSync(join(this.directory, p), 'utf8')) as RecordEntry); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw new ControlError('JOURNAL_UNAVAILABLE');
        }
    }
    claim(entry: RecordEntry): boolean {
        try { this.write(entry, true); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    }
    save(entry: RecordEntry) { this.write(entry, false); }
    private write(entry: RecordEntry, exclusive: boolean) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const target = exclusive ? this.path(entry.requestID) : `${this.path(entry.requestID)}.${randomUUID()}.tmp`;
        const fd = openSync(target, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify(entry)); fsyncSync(fd); } finally { closeSync(fd); }
        if (!exclusive) renameSync(target, this.path(entry.requestID));
        const dir = openSync(this.directory, 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
    }
}
