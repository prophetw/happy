import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, chmodSync, renameSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHostedAdmission, readHostedAdmission, requestHostedAdmission } from './hostedDotAdmission';
import { hostedProducerIdentity } from './hostedDotState';

const hooks = vi.hoisted(() => ({
    paths: new Map<number, string>(),
    onOpen: undefined as undefined | ((file: string) => void),
    onRead: undefined as undefined | ((file: string) => void),
}));
vi.mock('node:fs', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return { ...fs,
        openSync: (...args: Parameters<typeof fs.openSync>) => {
            const fd = fs.openSync(...args), file = String(args[0]); hooks.paths.set(fd, file); hooks.onOpen?.(file); return fd;
        },
        readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
            const value = fs.readFileSync(...args);
            if (typeof args[0] === 'number') hooks.onRead?.(hooks.paths.get(args[0]) ?? '');
            return value;
        },
        readSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number | null) => {
            const size = fs.readSync(fd, bytes, offset, length, position); hooks.onRead?.(hooks.paths.get(fd) ?? ''); return size;
        },
    };
});
afterEach(() => { hooks.onOpen = hooks.onRead = undefined; hooks.paths.clear(); });

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'admission-'));
    const b = { directory, dotId: randomUUID(), sessionId: 'fixture', epoch: 0 };
    writeFileSync(join(directory, 'config.json'), JSON.stringify(b), { mode: 0o600 });
    return { b, close: () => rmSync(directory, { recursive: true }) };
}
it('legacy refuses ACK; stopped bootstrap holds across crashes, lease expiry and explicit CAS resume', () => {
    const f = fixture();
    try {
        const op = { id: 'upgrade', action: 'pause' as const, expectedRevision: 0, leaseUntil: Date.now() + 30000 };
        expect(() => requestHostedAdmission({ ...f.b, operation: op })).toThrow('legacy_or_offline');
        const held = requestHostedAdmission({ ...f.b, operation: op, bootstrapStopped: true });
        expect(held.acknowledged).toBe(false);
        const producer = createHostedAdmission(f.b, hostedProducerIdentity());
        expect(producer.permits(true)).toBe(false);
        expect(readHostedAdmission(f.b).status?.phase).toBe('draining');
        expect(producer.permits(false)).toBe(false);
        expect(readHostedAdmission(f.b).status?.phase).toBe('paused');
        expect(requestHostedAdmission({ ...f.b, operation: op }).desired?.revision).toBe(1);
        expect(() => requestHostedAdmission({ ...f.b, operation: { ...op, leaseUntil: op.leaseUntil + 1 } })).toThrow('operation_conflict');
        expect(() => requestHostedAdmission({ ...f.b, operation: { ...op, id: 'different' } })).toThrow('revision_conflict');
        expect(createHostedAdmission(f.b, hostedProducerIdentity()).permits(false)).toBe(false);
        requestHostedAdmission({ ...f.b, operation: { id: 'resume', action: 'resume', expectedRevision: 1, leaseUntil: 0 } });
        expect(producer.permits(false)).toBe(true);
        producer.stopped(); expect(readHostedAdmission(f.b).supported).toBe(false);
    } finally { f.close(); }
});
it('rejects cross epoch, owner-private metadata and symlink paths', () => {
    const f = fixture();
    try {
        const producer = createHostedAdmission(f.b, hostedProducerIdentity()); producer.permits(false);
        requestHostedAdmission({ ...f.b, operation: { id: 'pause', action: 'pause', expectedRevision: 0, leaseUntil: Date.now() + 10000 } });
        expect(() => readHostedAdmission({ ...f.b, epoch: 1 })).toThrow('binding_changed');
        symlinkSync(join(f.b.directory, 'config.json'), join(f.b.directory, 'link'));
        expect(() => readHostedAdmission({ ...f.b, directory: join(f.b.directory, 'link') })).toThrow();
        symlinkSync(join(f.b.directory, 'missing'), join(f.b.directory, 'dangling'));
        expect(() => readHostedAdmission({ ...f.b, directory: join(f.b.directory, 'dangling') })).toThrow('symlink');
        chmodSync(f.b.directory, 0o755);
        expect(() => readHostedAdmission(f.b)).toThrow('directory_invalid');
    } finally { f.close(); }
});
it('reserves a recovery receipt when maintenance history reaches its limit', () => {
    const f = fixture();
    try {
        const m = createHostedAdmission(f.b, hostedProducerIdentity()); m.permits(false);
        for (let i = 0; i < 62; i++) requestHostedAdmission({ ...f.b, operation: { id: 'op-' + i, action: 'resume', leaseUntil: 0, expectedRevision: i } });
        requestHostedAdmission({ ...f.b, operation: { id: 'last-pause', action: 'pause', leaseUntil: Date.now() + 10000, expectedRevision: 62 } });
        expect(m.permits(false)).toBe(false);
        expect(() => requestHostedAdmission({ ...f.b, operation: { id: 'extra-pause', action: 'pause', leaseUntil: Date.now() + 10000, expectedRevision: 63 } })).toThrow('history_full');
        requestHostedAdmission({ ...f.b, operation: { id: 'last-resume', action: 'resume', leaseUntil: 0, expectedRevision: 63 } });
        expect(m.permits(false)).toBe(true);
    } finally { f.close(); }
});
it('a dangling intent never reopens producer admission or becomes a missing command', () => {
    const f = fixture();
    try {
        const m = createHostedAdmission(f.b, hostedProducerIdentity()); m.permits(false);
        symlinkSync(join(f.b.directory, 'missing'), join(f.b.directory, 'admission-intent.json'));
        expect(() => m.permits(false)).toThrow('symlink');
        expect(() => readHostedAdmission(f.b)).toThrow('symlink');
    } finally { f.close(); }
});

function replace(file: string, value: unknown, mode = 0o600) {
    const tmp = file + '.' + randomUUID(); writeFileSync(tmp, JSON.stringify(value), { mode }); chmodSync(tmp, mode); renameSync(tmp, file);
}
function openFixture() {
    const f = fixture(), owner = hostedProducerIdentity(), producer = createHostedAdmission(f.b, owner);
    producer.permits(false);
    requestHostedAdmission({ ...f.b, operation: { id: 'open', action: 'resume', leaseUntil: 0, expectedRevision: 0 } });
    producer.permits(false);
    return { ...f, owner };
}
for (const target of ['config.json', 'admission-intent.json', 'admission-status.json']) {
    for (const timing of ['onOpen', 'onRead'] as const) it(`${target}: ${timing} rename discards old bytes and reopens the current private inode`, () => {
        const f = openFixture(), file = join(f.b.directory, target); let replacements = 0;
        try {
            hooks[timing] = path => {
                if (path !== file) return;
                hooks[timing] = undefined; replacements++;
                if (target === 'admission-intent.json') requestHostedAdmission({ ...f.b,
                    operation: { id: 'pause', action: 'pause', leaseUntil: Date.now() + 30000, expectedRevision: 1 } });
                else if (target === 'admission-status.json') createHostedAdmission(f.b, f.owner).permits(false);
                else replace(file, f.b);
            };
            const result = readHostedAdmission(f.b);
            expect(replacements).toBe(1);
            expect(result.desired?.revision).toBe(target === 'admission-intent.json' ? 2 : 1);
            if (target === 'admission-intent.json') expect(result.desired?.operation.action).toBe('pause');
            expect(result.status?.binding).toEqual(f.b);
        } finally { hooks.onOpen = hooks.onRead = undefined; f.close(); }
    });
}
it('repeated config inode replacement fails after one full reopen', () => {
    const f = openFixture(), file = join(f.b.directory, 'config.json'); let opens = 0;
    try {
        hooks.onOpen = path => { if (path === file) { opens++; replace(file, f.b); } };
        expect(() => readHostedAdmission(f.b)).toThrow('hosted_admission_file_changed');
        expect(opens).toBe(2);
    } finally { hooks.onOpen = undefined; f.close(); }
});
it('same-inode modification never retries or authorizes an earlier descriptor snapshot', () => {
    const f = openFixture(), file = join(f.b.directory, 'config.json'); let opens = 0;
    try {
        hooks.onOpen = path => { if (path === file) opens++; };
        hooks.onRead = path => {
            if (path !== file) return;
            hooks.onRead = undefined;
            writeFileSync(file, JSON.stringify({ ...f.b, sessionId: 'foreign' }));
        };
        expect(() => readHostedAdmission(f.b)).toThrow('hosted_admission_file_changed');
        expect(opens).toBe(1);
    } finally { hooks.onOpen = hooks.onRead = undefined; f.close(); }
});
for (const invalid of ['mode', 'hardlink', 'symlink', 'size', 'json'] as const) it(`an invalid ${invalid} replacement cannot trigger a permissive retry`, () => {
    const f = openFixture(), file = join(f.b.directory, 'config.json');
    try {
        hooks.onOpen = path => {
            if (path !== file) return;
            hooks.onOpen = undefined;
            replace(file, f.b, invalid === 'mode' ? 0o644 : 0o600);
            if (invalid === 'hardlink') linkSync(file, file + '.other');
            if (invalid === 'symlink') { renameSync(file, file + '.other'); symlinkSync(file + '.other', file); }
            if (invalid === 'size') writeFileSync(file, 'x'.repeat(65537));
            if (invalid === 'json') writeFileSync(file, '{malformed');
        };
        expect(() => readHostedAdmission(f.b)).toThrow();
    } finally { hooks.onOpen = undefined; f.close(); }
});
