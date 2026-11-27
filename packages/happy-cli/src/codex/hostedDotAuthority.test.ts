import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, truncateSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hash, HOSTED_STATE_MAX_BYTES, HostedDotConfig, hostedProducerIdentity } from './hostedDotState';
import { prepareHostedStorage, saveHostedStorage } from './hostedDotStorage';
import { createHostedAuthorityPublisher } from './hostedDotAuthorityPublisher';
import { HOSTED_INPUT_AUTHORITY_VERSION, readHostedInputAuthority } from './hostedDotAuthority';
const hooks = vi.hoisted(() => ({ afterSnapshot: undefined as undefined | (() => void) }));
vi.mock('./hostedDotStorage', async importOriginal => {
    const storage = await importOriginal<typeof import('./hostedDotStorage')>();
    return { ...storage, readHostedStorage: (...args: Parameters<typeof storage.readHostedStorage>) => {
        const state = storage.readHostedStorage(...args); hooks.afterSnapshot?.(); return state;
    } };
});
const dirs: string[] = [];
afterEach(() => { hooks.afterSnapshot = undefined; dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'authority-')); dirs.push(directory);
    const config = HostedDotConfig.parse({ version: 1, dotId: randomUUID(), sessionId: 'session', directory,
        happyHome: '/tmp/happy', serverUrl: 'http://localhost:1234', executable: 'codex', args: [], model: 'test',
        provider: 'openai', instruction: 'test', codexHome: '/tmp/codex' });
    const state: any = { version: 1, binding: hash(config), epoch: 0, status: 'ready', outputReceipts: [],
        authority: { version: 1, producer: hostedProducerIdentity(), revision: 1 },
        inputs: [{ seq: 1, id: 'one', text: 'request', status: 'accepted' },
            { origin: 'task-result', id: 'task', text: 'untrusted result', status: 'accepted' }] };
    prepareHostedStorage(directory);
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
    const save = () => saveHostedStorage(join(directory, 'state.json'), state); save();
    return { config, state, save, read: () => readHostedInputAuthority(config) };
}
it('exports v1, reads fresh user-only rows without manufacturing epoch/delivery and never writes', () => {
    const f = fixture(), file = join(f.config.directory, 'state.json'), before = readFileSync(file);
    expect(HOSTED_INPUT_AUTHORITY_VERSION).toBe(1);
    expect(f.read().inputs).toEqual([{ origin: 'user', seq: 1, id: 'one', text: 'request', status: 'accepted' }]);
    expect(readFileSync(file)).toEqual(before);
    f.state.authority.revision++; f.state.status = 'blocked'; f.save();
    expect(f.read()).toMatchObject({ revision: 2, status: 'blocked', producer: { pid: process.pid } });
});
it('accepts effort-omitted legacy binding, but rejects wrong config identity or binding', () => {
    const f = fixture(), { effort, ...legacy } = f.config;
    f.state.binding = hash(legacy); f.save(); expect(f.read().version).toBe(1);
    expect(() => readHostedInputAuthority({ ...f.config, sessionId: 'other' })).toThrow();
    f.state.binding = 'wrong'; f.save(); expect(f.read).toThrow();
});
it.each([
    (s: any) => delete s.authority, (s: any) => s.authority.version = 2,
    (s: any) => s.authority.revision = 0, (s: any) => s.authority.revision = Number.MAX_SAFE_INTEGER + 1,
    (s: any) => s.authority.producer.start = 'bad', (s: any) => s.status = 'unknown',
    (s: any) => delete s.epoch, (s: any) => delete s.inputs[0].seq,
    (s: any) => s.inputs[0].origin = 'assistant', (s: any) => s.inputs[0].delivery = 'bad',
    (s: any) => s.inputs.push(s.inputs[0]),
])('fails closed on malformed authority %s', mutate => {
    const f = fixture(); mutate(f.state); f.save(); expect(f.read).toThrow();
});
it('rejects missing, oversized, symlinked files and symlink directories', () => {
    const f = fixture(), file = join(f.config.directory, 'state.json');
    truncateSync(file, HOSTED_STATE_MAX_BYTES + 1); expect(f.read).toThrow();
    rmSync(file); expect(f.read).toThrow();
    symlinkSync(join(f.config.directory, 'config.json'), file); expect(f.read).toThrow();
    const link = join(f.config.directory, 'link'); symlinkSync(f.config.directory, link);
    expect(() => readHostedInputAuthority({ ...f.config, directory: link })).toThrow();
    rmSync(file); mkdirSync(file); expect(f.read).toThrow();
});
it('preserves legacy empty IDs and rejects reordered user sequence and newer reset floors', () => {
    const f = fixture(); f.state.inputs[0].id = ''; f.save(); expect(f.read().inputs[0].id).toBe('');
    f.state.inputs.push({ seq: 2, id: 'two', text: 'next', status: 'queued' }); f.save(); expect(f.read().inputs).toHaveLength(2);
    f.state.inputs.reverse(); f.save(); expect(f.read).toThrow();
    f.state.inputs.reverse(); f.save();
    writeFileSync(join(f.config.directory, 'reset-epoch.json'), JSON.stringify({ epoch: 1 })); expect(f.read).toThrow();
});

it('rejects the replacement of the bound config during snapshot reading', () => {
    const f = fixture(), path = join(f.config.directory, 'config.json');
    hooks.afterSnapshot = () => {
        hooks.afterSnapshot = undefined;
        const replacement = path + '.replacement';
        writeFileSync(replacement, readFileSync(path)); renameSync(replacement, path);
    };
    expect(f.read).toThrow('hosted_authority_file_changed');
});

it('retries SQLite commits with unchanged authorization until a stable revision', () => {
    const f = fixture(), path = join(f.config.directory, 'state.json');
    const publish = createHostedAuthorityPublisher(path, f.state, hostedProducerIdentity());
    let writes = 0, reads = 0;
    hooks.afterSnapshot = () => {
        if (++reads % 2 !== 1 || writes >= 2) return;
        f.state.outputs = [{ localId: 'output-' + ++writes, envelope: { text: 'output' }, sent: false }];
        publish();
    };
    expect(f.read().revision).toBe(3);
});

it('exhausts persistent SQLite output churn after four attempts', () => {
    const f = fixture(); let writes = 0, reads = 0;
    hooks.afterSnapshot = () => {
        if (++reads % 2 !== 1) return;
        f.state.authority.revision++;
        f.state.outputs = [{ localId: 'output-' + ++writes, envelope: { text: 'output' }, sent: false }];
        f.save();
    };
    expect(f.read).toThrow('hosted_authority_file_changed');
    expect(writes).toBe(4);
});
it.each([
    (s: any) => s.epoch++,
    (s: any) => s.authority.producer.pid++,
    (s: any) => s.authority.producer.start = '999999',
    (s: any) => s.authority.producer.boot = randomUUID(),
    (s: any) => s.inputs[0].permissionMode = 'read-only',
    (s: any) => s.status = 'stopped',
])('rejects authority changes across a SQLite commit %s', mutate => {
    const f = fixture();
    hooks.afterSnapshot = () => {
        hooks.afterSnapshot = undefined;
        mutate(f.state); f.state.authority.revision++; f.save();
    };
    expect(f.read).toThrow('hosted_authority_snapshot_changed');
});

it.each(['symlink', 'reset', 'config', 'in-place'])('fails closed for %s during a state race', kind => {
    const f = fixture(), path = join(f.config.directory, 'state.json');
    hooks.afterSnapshot = () => {
        hooks.afterSnapshot = undefined;
        if (kind === 'symlink') {
            const target = path + '.target'; renameSync(path, target); symlinkSync(target, path);
        } else if (kind === 'reset') {
            writeFileSync(join(f.config.directory, 'reset-epoch.json'), JSON.stringify({ epoch: 1 }));
        } else if (kind === 'config') {
            const configPath = join(f.config.directory, 'config.json'), tmp = configPath + '.tmp';
            writeFileSync(tmp, JSON.stringify({ ...f.config, sessionId: 'foreign' })); renameSync(tmp, configPath);
        } else {
            f.state.inputs[0].permissionMode = 'read-only'; f.save();
        }
    };
    expect(f.read).toThrow();
});
it('refuses legacy JSON as input authorization', () => {
    const f = fixture();
    rmSync(join(f.config.directory, 'storage.json'));
    rmSync(join(f.config.directory, 'state.sqlite'));
    writeFileSync(join(f.config.directory, 'state.json'), JSON.stringify(f.state));
    expect(f.read).toThrow('hosted_storage_migration_required');
});
