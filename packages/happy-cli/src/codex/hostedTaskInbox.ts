import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, opendirSync, readFileSync, unlinkSync, type Dir, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { HostedTaskEvent, type HostedDotConfig, type HostedState } from './hostedDotState';
import { hostedHistoryEvent, HOSTED_INPUT_MAX_ROWS } from './hostedDotStorage';

const eventName = /^task-[a-f0-9]{64}\.json$/;
const sameFile = (before: Stats, after: Stats) => before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
type Event = ReturnType<typeof HostedTaskEvent.parse>;

function readEvent(file: string) {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024 || before.uid !== process.getuid?.())
            throw Error('hosted_task_event_file_invalid');
        const raw: unknown = JSON.parse(readFileSync(fd, 'utf8'));
        if (!sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(file))) throw Error('hosted_task_event_file_changed');
        return { before, event: HostedTaskEvent.parse(raw), file };
    } finally { closeSync(fd); }
}

export class HostedTaskInbox {
    private scan?: Dir;
    private dir: string;
    constructor(private config: Pick<HostedDotConfig, 'directory' | 'dotId' | 'sessionId'>) { this.dir = join(config.directory, 'events'); }

    close() { this.scan?.closeSync(); this.scan = undefined; }

    sweep(state: HostedState, journalBytes: number, availableBytes: number, persist: () => void,
        suppressed: (event: Event) => boolean, maxFiles = 64) {
        const result = { removed: 0, taken: 0, suppressed: 0, unreadable: 0, deferred: 0 };
        const directory = lstatSync(this.dir, { throwIfNoEntry: false });
        if (!directory) { this.close(); return result; }
        if (!directory.isDirectory() || directory.uid !== process.getuid?.()) throw Error('hosted_task_events_path_invalid');
        this.scan ??= opendirSync(this.dir, { bufferSize: maxFiles });
        const entries: ReturnType<typeof readEvent>[] = [];
        for (let visited = 0; visited < maxFiles; visited++) {
            const entry = this.scan.readSync();
            if (!entry) { this.close(); break; }
            if (!eventName.test(entry.name)) continue;
            try {
                const data = readEvent(join(this.dir, entry.name)), { event } = data;
                if (event.dotId !== this.config.dotId || event.sessionId !== this.config.sessionId || entry.name !== event.id + '.json')
                    throw Error('hosted_task_event_binding_changed');
                entries.push(data);
            } catch (error) {
                if (error instanceof Error && error.message === 'hosted_task_event_binding_changed') throw error;
                result.unreadable++;
            }
        }
        entries.sort((a, b) => a.event.createdAt.localeCompare(b.event.createdAt) || a.event.id.localeCompare(b.event.id));
        const byId = new Map(state.inputs.filter(row => row.origin === 'task-result').map(row => [row.id, row]));
        const ready: typeof entries = [];
        for (const item of entries) {
            const { event } = item;
            if (event.epoch > state.epoch) { result.deferred++; continue; }
            if (event.epoch < state.epoch) {
                // The producer does not run this scan until its current epoch
                // is committed. Older events cannot regain authority after reset.
                ready.push(item); result.suppressed++; continue;
            }
            const old = byId.get(event.id);
            if (old) {
                if (old.epoch === event.epoch && old.text === event.text) ready.push(item);
                else result.unreadable++;
                continue;
            }
            if (state.historyVersion === 1) {
                const receipt = hostedHistoryEvent(this.config.directory, event.epoch, event.id);
                if (receipt) {
                    const textDigest = 'sha256:' + createHash('sha256').update(JSON.stringify(event.text)).digest('hex');
                    if (textDigest === receipt.textDigest) ready.push(item); else result.unreadable++;
                    continue;
                }
            }
            const row: HostedState['inputs'][number] = { id: event.id, epoch: event.epoch, origin: 'task-result',
                delivery: 'queue', text: event.text, status: 'queued' };
            const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
            if (state.inputs.length >= HOSTED_INPUT_MAX_ROWS || journalBytes + bytes >= availableBytes) { result.deferred++; continue; }
            if (suppressed(event)) {
                row.status = 'rejected'; row.error = 'hosted_task_notice_suppressed';
                result.suppressed++;
            }
            state.inputs.push(row); byId.set(row.id, row);
            journalBytes += bytes; result.taken++; ready.push(item);
        }
        // A crash after commit and before unlink is a normal exact-ID replay.
        // A failed commit leaves every new event file for the next owner.
        if (result.taken) persist();
        for (const item of ready) {
            const after = lstatSync(item.file, { throwIfNoEntry: false });
            if (!after || !sameFile(item.before, after)) continue;
            unlinkSync(item.file); result.removed++;
        }
        if (result.removed) {
            const fd = openSync(this.dir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
            try { fsyncSync(fd); } finally { closeSync(fd); }
        }
        return result;
    }
}
