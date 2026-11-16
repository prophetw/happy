import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHostedAdmission, readHostedAdmission, requestHostedAdmission } from './hostedDotAdmission';
import { hostedProducerIdentity } from './hostedDotState';

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
