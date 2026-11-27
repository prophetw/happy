import { afterEach, expect, it } from 'vitest';
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostedAdmission, requestHostedAdmission } from './hostedDotAdmission';
import { recoverHeldHostedDot, recoverHostedDot } from './hostedDotLifecycle';
import { hash, hostedProducerIdentity, savePrivate } from './hostedDotState';
import { readHostedStorage, saveHostedStorage } from './hostedDotStorage';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const identity = hostedProducerIdentity();
const exited = spawnSync(process.execPath, ['-e', "console.log(require('fs').readFileSync('/proc/self/stat','utf8').split(') ').pop().split(' ')[19])"], { encoding: 'utf8' });
const former = { pid: exited.pid, start: exited.stdout.trim(), boot: identity.boot };
function fixture(owner = former) {
    const directory = mkdtempSync(join(tmpdir(), 'held-recovery-'));
    directories.push(directory);
    const binding = { directory, dotId: randomUUID(), sessionId: 'original-session' };
    const config = { version: 1, dotId: binding.dotId, sessionId: binding.sessionId, happyHome: join(directory, 'happy'),
        serverUrl: 'https://relay.invalid', directory, executable: 'fixture', args: [], model: 'fixture', effort: 'xhigh',
        provider: 'fixture', providerConfig: {}, instruction: 'fixture', codexHome: join(directory, 'codex'), environment: [] };
    const state = { authority: { version: 1, producer: owner, revision: 6 }, version: 1, binding: hash(config), epoch: 0,
        threadId: 'original-thread', creating: false, afterSeq: 150, status: 'blocked', error: 'hosted_admission_file_invalid',
        inputs: [{ seq: 117, id: 'original-input', text: 'original', status: 'completed', turnId: 'turn', preserved: 'legacy input metadata' }],
        outputs: [{ localId: 'original-output', envelope: { original: true }, sent: true }], controls: ['old-stop'], priorMetadata: 'retained', outputReceipts: [] };
    saveHostedStorage(join(directory, 'state.json'), state);
    for (const [name, value] of Object.entries({ config, owner, control: { id: 'old-stop', action: 'stop' } })) savePrivate(join(directory, name + '.json'), value);
    const b = { ...binding, epoch: 0 };
    requestHostedAdmission({ ...b, bootstrapStopped: true, operation: { id: 'maintenance-pause', action: 'pause', expectedRevision: 0, leaseUntil: Date.now() + 60000 } });
    createHostedAdmission(b, owner).stopped();
    const read = (name: string) => name === 'state' ? readHostedStorage(join(directory, 'state.json'))! : JSON.parse(readFileSync(join(directory, name + '.json'), 'utf8'));
    const proof = { binding, owner, epoch: 0, operationId: 'maintenance-pause', revision: 1, journalSHA256: hash(read('state')) };
    return { binding, directory, state, proof, read };
}
it('only explicit recovery reopens a settled journal under its still-closed admission', () => {
    const f = fixture(), intent = f.read('admission-intent'), stopped = f.read('admission-status');
    expect(recoverHostedDot(f.binding)).toMatchObject({ recovered: false });
    expect(recoverHeldHostedDot(f.proof)).toEqual({ recovered: true });
    expect(f.read('state')).toEqual({ ...f.state, status: 'starting', error: null });
    expect(f.read('admission-intent')).toEqual(intent); expect(f.read('admission-status')).toEqual(stopped);
    expect(recoverHeldHostedDot(f.proof).recovered).toBe(false);
    expect(f.read('recovery').attempts).toBe(1);
});
it('rejects a live holder and any competing runtime or admission lock', () => {
    const live = fixture(identity);
    expect(recoverHeldHostedDot(live.proof).recovered).toBe(false);
    const f = fixture();
    for (const name of ['runtime.lock', 'admission.lock']) {
        const fd = openSync(join(f.directory, name), 'a+', 0o600);
        try {
            expect(spawnSync('flock', ['-xn', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status).toBe(0);
            expect(() => recoverHeldHostedDot(f.proof)).toThrow(/busy/);
        } finally { closeSync(fd); }
        expect(f.read('state')).toEqual(f.state);
    }
});
it.each(['delete', 'clear', 'admission-permissions'] as const)('keeps a %s fence intact', issue => {
    const f = fixture();
    if (issue === 'delete') savePrivate(join(f.directory, 'control.json'), { id: 'cancel', action: 'delete' });
    if (issue === 'clear') savePrivate(join(f.directory, 'lifecycle-clear.json'), { requestId: 'clear' });
    if (issue === 'admission-permissions') chmodSync(join(f.directory, 'admission-intent.json'), 0o644);
    expect(() => recoverHeldHostedDot(f.proof)).toThrow(/hosted_/);
    expect(f.read('state')).toEqual(f.state);
});
it('honors the persisted recovery budget and backoff', () => {
    const f = fixture(), prior = { attempts: 2, lastAttemptAt: Date.now() };
    savePrivate(join(f.directory, 'recovery.json'), prior);
    expect(recoverHeldHostedDot(f.proof)).toEqual({ recovered: false, reason: 'backoff' });
    expect(f.read('recovery')).toEqual(prior);
    expect(f.read('state')).toEqual(f.state);
});
it.each(['unknown','queued','unacked','creating','injecting','duplicate-output','wrong-error','authority','stale-proof','receipt','revision','pending-stop'] as const)('retains the original blocked journal for %s', problem => {
    const f = fixture(), state = f.read('state');
    if (problem === 'unknown' || problem === 'queued') state.inputs[0].status = problem;
    if (problem === 'unacked') state.outputs[0].sent = false;
    if (problem === 'creating') state.creating = true;
    if (problem === 'injecting') state.bootstrap = { stage: 'injecting', threadId: state.threadId };
    if (problem === 'duplicate-output') state.outputs.push(state.outputs[0]);
    if (problem === 'wrong-error') state.error = 'hosted_input_unconfirmed';
    if (problem === 'authority') state.authority.producer.start = '1';
    if (problem === 'stale-proof') state.authority.revision++;
    if (problem === 'receipt') {
        const status = f.read('admission-status'); status.operationId = 'another-pause';
        savePrivate(join(f.directory, 'admission-status.json'), status);
    }
    if (problem === 'revision') f.proof.revision++;
    if (problem === 'pending-stop') savePrivate(join(f.directory, 'control.json'), { id: 'other', action: 'stop' });
    saveHostedStorage(join(f.directory, 'state.json'), state);
    if (problem !== 'stale-proof') f.proof.journalSHA256 = hash(state);
    expect(recoverHeldHostedDot(f.proof).recovered).toBe(false);
    expect(f.read('state')).toEqual(state);
    expect(existsSync(join(f.directory, 'recovery.json'))).toBe(false);
});
