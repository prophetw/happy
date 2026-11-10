import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, truncateSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hash, HostedDotConfig, hostedProducerIdentity } from './hostedDotState';
import { HOSTED_INPUT_AUTHORITY_VERSION, readHostedInputAuthority } from './hostedDotAuthority';
const hooks = vi.hoisted(() => ({ onRead: undefined as undefined | (() => void) }));
vi.mock('node:fs', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return { ...fs, readSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number | null) => {
        const result = fs.readSync(fd, bytes, offset, length, position); hooks.onRead?.(); return result;
    } };
});
const dirs: string[] = [];
afterEach(() => { hooks.onRead = undefined; dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'authority-')); dirs.push(directory);
    const config = HostedDotConfig.parse({ version: 1, dotId: randomUUID(), sessionId: 'session', directory,
        happyHome: '/tmp/happy', serverUrl: 'http://localhost:1234', executable: 'codex', args: [], model: 'test',
        provider: 'openai', instruction: 'test', codexHome: '/tmp/codex' });
    const state: any = { version: 1, binding: hash(config), epoch: 0, status: 'ready',
        authority: { version: 1, producer: hostedProducerIdentity(), revision: 1 },
        inputs: [{ seq: 1, id: 'one', text: 'request', status: 'accepted' },
            { origin: 'task-result', id: 'task', text: 'untrusted result', status: 'accepted' }] };
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
    const save = () => writeFileSync(join(directory, 'state.json'), JSON.stringify(state)); save();
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
    truncateSync(file, 32 * 1024 * 1024 + 1); expect(f.read).toThrow();
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

it.each(['state.json', 'config.json'])('rejects an atomic %s replacement during snapshot reading', target => {
    const f = fixture(), path = join(f.config.directory, target);
    let reads = 0;
    hooks.onRead = () => {
        // config consumes one data read plus EOF; state then consumes its data read.
        if (++reads !== 3) return;
        const replacement = path + '.replacement';
        writeFileSync(replacement, readFileSync(path)); renameSync(replacement, path);
    };
    expect(f.read).toThrow('hosted_authority_file_changed');
});
