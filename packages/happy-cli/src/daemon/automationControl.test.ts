import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutomationControl, observeOwnedProcess } from './automationControl';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'happy-control-test-')); dirs.push(directory);
    const spawn = vi.fn(async (_path: string) => ({ type: 'success', sessionId: 's1' }));
    const stop = vi.fn(() => true);
    const observe = vi.fn((): 'running' | 'stopping' | 'stopped' | 'unknown' => 'running');
    const deps = { directory, spawn, stop, observe };
    return { ...deps, control: createAutomationControl(deps) };
}
const create = { version: 1, operation: 'create', requestID: 'r1', directory: '/fixture' };
describe('durable encrypted automation RPC contract', () => {
    it('requires absence of parent AND descendants; EPERM/restart/Windows stay unknown', () => {
        const info = { pid: 123, owned: true, stopping: true };
        const absent = () => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }); };
        expect(observeOwnedProcess(info, absent, 'linux')).toBe('stopped');
        expect(observeOwnedProcess(info, pid => { if (pid > 0) absent(); }, 'linux')).toBe('stopping');
        expect(observeOwnedProcess(info, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }, 'linux')).toBe('unknown');
        expect(observeOwnedProcess({ ...info, owned: false }, absent, 'linux')).toBe('unknown');
        expect(observeOwnedProcess(info, absent, 'win32')).toBe('unknown');
    });
    it('deduplicates in-flight and persisted creates, including after restart', async () => {
        const s = setup(); let resolve!: (value: { type: string; sessionId: string }) => void;
        s.spawn.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
        const running = s.control(create);
        expect(await s.control(create)).toMatchObject({ state: 'pending' });
        expect(await s.control({ version: 1, operation: 'request', requestID: 'r1' })).toMatchObject({ state: 'pending' });
        resolve({ type: 'success', sessionId: 's1' });
        expect(await running).toMatchObject({ state: 'confirmed', sessionID: 's1' });
        expect(await createAutomationControl(s)(create)).toMatchObject({ state: 'confirmed', sessionID: 's1' });
        expect(s.spawn).toHaveBeenCalledTimes(1);
        expect(readFileSync(join(s.directory, readdirSync(s.directory)[0]), 'utf8')).not.toContain('/fixture');
    });
    it('rejects changed payload on an existing requestID', async () => {
        const s = setup(); await s.control(create);
        expect(await s.control({ ...create, directory: '/other' })).toMatchObject({ errorCode: 'REQUEST_ID_CONFLICT' });
        expect(s.spawn).toHaveBeenCalledTimes(1);
    });
    it('does not redispatch a crash-window intent or corrupted receipt', async () => {
        const s = setup(); await s.control(create);
        const path = join(s.directory, readdirSync(s.directory)[0]);
        const receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.state = 'pending'; delete receipt.sessionID;
        writeFileSync(path, JSON.stringify(receipt));
        expect(await createAutomationControl(s)(create)).toMatchObject({ state: 'unknown' });
        writeFileSync(path, '{broken');
        expect(await createAutomationControl(s)(create)).toMatchObject({ errorCode: 'INVALID_REQUEST_OR_JOURNAL_UNAVAILABLE' });
        expect(s.spawn).toHaveBeenCalledTimes(1);
    });
    it('separates cancel receipt from actual process exit', async () => {
        const s = setup();
        const cancel = { version: 1, operation: 'cancel', requestID: 'c1', sessionID: 's1' };
        expect(await s.control(cancel)).toMatchObject({ state: 'cancel_requested', process: 'running' });
        s.observe.mockReturnValue('stopping');
        expect(await s.control({ version: 1, operation: 'status', sessionID: 's1' })).toMatchObject({ process: 'stopping' });
        s.observe.mockReturnValue('stopped');
        expect(await s.control(cancel)).toMatchObject({ state: 'cancel_requested', process: 'stopped' });
        expect(s.stop).toHaveBeenCalledTimes(1);
    });
    it('fails closed on bad IDs/versions and keeps dispatch exceptions uncertain', async () => {
        const s = setup();
        expect(await s.control({ ...create, version: 2 })).toMatchObject({ errorCode: 'UNSUPPORTED_VERSION' });
        expect(await s.control({ ...create, requestID: '../escape' })).toMatchObject({ errorCode: 'INVALID_REQUEST_OR_JOURNAL_UNAVAILABLE' });
        s.spawn.mockRejectedValue(new Error('sensitive-token'));
        const reply = await s.control(create);
        expect(reply).toMatchObject({ state: 'unknown', errorCode: 'DISPATCH_NOT_CONFIRMED' });
        expect(JSON.stringify(reply)).not.toContain('sensitive-token');
    });
});
