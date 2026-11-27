import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fsyncSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hash } from '../journal';
import { TaskQueue } from './taskQueue';
import { TaskScheduler } from './taskScheduler';

vi.mock('node:fs', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});

const roots: string[] = [];
const actualSync = vi.mocked(fsyncSync).getMockImplementation()!;
afterEach(() => {
    vi.mocked(fsyncSync).mockImplementation(actualSync);
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'happy-queue-durability-'));
    roots.push(directory);
    const queue = new TaskQueue(directory);
    const file = join(directory, hash('queue') + '.json');
    const key = readFileSync(join(directory, '.payload-key'));
    const request = { requestID: 'send', grantID: 'grant', workerID: 'worker', sessionID: 'session',
        authorization: '', text: 'original', resources: [{ key: 'machine', mode: 'shared' as const }] };
    return { directory, queue, file, key, request };
}

function plaintext(path: string, key: Buffer) {
    const bytes = Buffer.from(JSON.parse(readFileSync(path, 'utf8')).value.sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}

function replacePlaintext(path: string, key: Buffer, clear: Buffer) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
    writeFileSync(path, JSON.stringify({ key: 'queue',
        value: { sealed: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64') } }));
}

function corruptStagedWrite(f: ReturnType<typeof fixture>, matches: (clear: Buffer) => boolean) {
    let injected = false;
    vi.mocked(fsyncSync).mockImplementation(fd => {
        const path = readlinkSync(`/proc/self/fd/${fd}`);
        if (!injected && path.startsWith(f.file + '.') && path.endsWith('.tmp')) {
            const clear = plaintext(path, f.key);
            if (matches(clear)) {
                const offset = clear.indexOf('original');
                expect(offset).toBeGreaterThan(0);
                clear[offset] = 0xa4;
                replacePlaintext(path, f.key, clear);
                injected = true;
            }
        }
        actualSync(fd);
    });
    return () => expect(injected).toBe(true);
}

it('rejects authenticated bad UTF-8 even if a lossy decoder would parse it as JSON', () => {
    const f = fixture();
    f.queue.noteScheduler('fixture-scheduler');
    // A replacement character still leaves this scheduler key valid JSON.
    const clear = plaintext(f.file, f.key);
    const offset = clear.indexOf('fixture-scheduler');
    expect(offset).toBeGreaterThan(0);
    clear[offset] = 0xa4;
    replacePlaintext(f.file, f.key, clear);
    expect(() => f.queue.tasks()).toThrow(expect.objectContaining({ code: 'QUEUE_CORRUPT', queuePhase: 'utf8' }));
});

it('does not replace a readable queue when a staged task no longer matches its fingerprint', () => {
    const f = fixture();
    const original = readFileSync(f.file);
    vi.mocked(fsyncSync).mockImplementationOnce(fd => {
        const path = readlinkSync(`/proc/self/fd/${fd}`);
        expect(path.startsWith(f.file + '.')).toBe(true);
        const clear = plaintext(path, f.key).toString('utf8').replace('"text":"original"', '"text":"modified"');
        replacePlaintext(path, f.key, Buffer.from(clear));
        actualSync(fd);
    });
    expect(() => f.queue.enqueue(f.request)).toThrow(expect.objectContaining({ code: 'QUEUE_WRITE_REJECTED', queuePhase: 'identity' }));
    expect(readFileSync(f.file)).toEqual(original);
    expect(readdirSync(f.directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(f.queue.enqueue(f.request).dispatched).toBe(false);
    expect(f.queue.enqueue(f.request).id).toBe(f.queue.tasks()[0].id);
    expect(f.queue.tasks()).toHaveLength(1);
});

it('rejects a corrupt dispatch claim and safely resumes the original request', async () => {
    const f = fixture();
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const accepted = f.queue.enqueue(f.request);
    const sent = vi.fn(async () => ({ seq: 1, id: 'sent' }));
    const scheduler = (queue: TaskQueue) => new TaskScheduler(queue, {
        authorize: async () => {},
        observe: async () => ({ process: 'running', cursor: 0, outcome: 'running' }),
        send: sent,
        stop: async () => {},
    }, 'worker');
    const injected = corruptStagedWrite(f, clear => clear.includes('"dispatched":true'));
    await expect(scheduler(f.queue).tick()).rejects.toMatchObject({ code: 'QUEUE_WRITE_REJECTED', queuePhase: 'utf8' });
    injected();
    expect(sent).toHaveBeenCalledTimes(0);
    expect(f.queue.tasks()[0]).toMatchObject({ id: accepted.id, state: 'queued', dispatched: false });
    now += 4_000;
    const reopened = new TaskQueue(f.directory);
    const restarted = scheduler(reopened);
    await restarted.tick();
    expect(reopened.enqueue(f.request)).toMatchObject({ id: accepted.id, dispatched: true });
    await restarted.tick();
    expect(sent).toHaveBeenCalledTimes(1);
});

it('keeps the durable send claim after a corrupt receipt update and never sends twice', async () => {
    const f = fixture();
    const accepted = f.queue.enqueue(f.request);
    const sent = vi.fn(async () => ({ seq: 1, id: 'sent' }));
    const scheduler = (queue: TaskQueue) => new TaskScheduler(queue, {
        authorize: async () => {},
        observe: async () => ({ process: 'running', cursor: 0 }),
        send: sent,
        stop: async () => {},
    }, 'worker');
    const injected = corruptStagedWrite(f, clear => clear.includes('"messageID":"sent"'));
    await expect(scheduler(f.queue).tick()).rejects.toMatchObject({ code: 'QUEUE_WRITE_REJECTED', queuePhase: 'utf8' });
    injected();
    const reopened = new TaskQueue(f.directory);
    expect(reopened.enqueue(f.request)).toMatchObject({ id: accepted.id, dispatched: true, state: 'blocked' });
    await scheduler(reopened).tick();
    expect(sent).toHaveBeenCalledTimes(1);
});

it('refreshes scheduler presence without rewriting the ledger on every tick', () => {
    const f = fixture();
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const peer = new TaskQueue(f.directory);
    const ciphertexts = new Set<string>();
    for (let tick = 0; tick < 12; tick++) {
        (tick % 2 ? peer : f.queue).noteScheduler('worker');
        const lastSeen = peer.transaction(state => state.schedulers.worker.lastSeen, true);
        expect(now - lastSeen).toBeLessThan(10_000);
        ciphertexts.add(hash(readFileSync(f.file, 'utf8')));
        now += 1_000;
    }
    expect(ciphertexts.size).toBe(3);
    now -= 30_000;
    peer.noteScheduler('worker');
    expect(f.queue.transaction(state => state.schedulers.worker.lastSeen, true)).toBe(now);
});
