import { expect, it, vi } from 'vitest';
import { createHostedAuthorityPublisher } from './hostedDotAuthorityPublisher';
import { HOSTED_STATE_MAX_BYTES, hostedProducerIdentity, type HostedState } from './hostedDotState';
it('increments revisions and preserves same-producer monotonicity', () => {
    const producer = hostedProducerIdentity();
    const state = { status: 'ready', authority: { version: 1, producer, revision: 4 } } as HostedState;
    const write = vi.fn(), persist = createHostedAuthorityPublisher('fixture', state, producer, write);
    persist(); expect(state.authority?.revision).toBe(5); persist(); expect(state.authority?.revision).toBe(6);
});
it('publishes blocked revocation after a failed ordinary publication', () => {
    const state = { status: 'ready' } as HostedState;
    const write = vi.fn().mockImplementationOnce(() => { throw Error('disk error'); });
    expect(createHostedAuthorityPublisher('fixture', state, hostedProducerIdentity(), write)).toThrow('disk error');
    expect(write).toHaveBeenCalledTimes(2); expect(state.status).toBe('blocked');
});
it('immediately exits if the blocked revocation cannot be persisted', () => {
    const state = { status: 'ready' } as HostedState;
    const write = vi.fn(() => { throw Error('disk error'); });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw Error('fatal exit'); });
    try {
        expect(createHostedAuthorityPublisher('fixture', state, hostedProducerIdentity(), write)).toThrow('fatal exit');
        expect(exit).toHaveBeenCalledWith(1); expect(write).toHaveBeenCalledTimes(2);
    } finally { exit.mockRestore(); }
});
it('fails stopped in a real child when both journal publications fail', async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const modulePath = fileURLToPath(new URL('./hostedDotAuthorityPublisher.ts', import.meta.url));
    const child = spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', `
        import { writeSync } from 'node:fs';
        import { createHostedAuthorityPublisher } from ${JSON.stringify(modulePath)};
        const publish = createHostedAuthorityPublisher('fixture', { status: 'ready' },
            { pid: process.pid, start: '1', boot: '00000000-0000-4000-8000-000000000000' },
            () => { throw new Error('disk unavailable'); });
        writeSync(1, 'ENTERED_PUBLISH');
        publish();
        process.stdout.write('UNSAFE_CONTINUATION');
    `], { encoding: 'utf8', timeout: 10000 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(child.stdout).toBe('ENTERED_PUBLISH');
    expect(child.stderr).toBe('');
    expect(child.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
});

function sizedState(withAuthority: boolean): HostedState {
    const state: any = { status: 'ready', error: null, text: '' };
    if (withAuthority) state.authority = { version: 1, producer: hostedProducerIdentity(), revision: 1 };
    const remaining = HOSTED_STATE_MAX_BYTES - Buffer.byteLength(JSON.stringify(state), 'utf8');
    state.text = '界'.repeat(Math.floor(remaining / 3)) + 'a'.repeat(remaining % 3);
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBe(HOSTED_STATE_MAX_BYTES);
    return state as HostedState;
}
it('allows an exact-limit UTF-8 snapshot including authority metadata', () => {
    const state = sizedState(true), write = vi.fn();
    createHostedAuthorityPublisher('fixture', state, hostedProducerIdentity(), write)();
    expect(write).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBe(HOSTED_STATE_MAX_BYTES);
});
it('fails stopped without writing when new metadata overflows a valid legacy journal', () => {
    const state = sizedState(false), write = vi.fn();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw Error('fatal exit'); });
    try {
        expect(createHostedAuthorityPublisher('fixture', state, hostedProducerIdentity(), write)).toThrow('fatal exit');
        expect(exit).toHaveBeenCalledWith(1); expect(write).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
});
it('does not write an oversized blocked fallback over the last readable journal', () => {
    const state = sizedState(true), write = vi.fn(() => { throw Error('disk error'); });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw Error('fatal exit'); });
    try {
        expect(createHostedAuthorityPublisher('fixture', state, hostedProducerIdentity(), write)).toThrow('fatal exit');
        expect(exit).toHaveBeenCalledWith(1); expect(write).toHaveBeenCalledTimes(1);
        expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBeGreaterThan(HOSTED_STATE_MAX_BYTES);
    } finally { exit.mockRestore(); }
});
