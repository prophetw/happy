import { beforeEach, describe, expect, it, vi } from 'vitest';

const dotId = '55555555-5555-4555-8555-555555555555';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const dotBinding = { schemaVersion: 1, kind: 'dot', workspaceId, workspaceSessionId: 'workspace-session', dotId };
const mocks = vi.hoisted(() => ({
    request: vi.fn(), emitWithAck: vi.fn(), sessionRPC: vi.fn(),
    encryptRaw: vi.fn(), decryptRaw: vi.fn(), state: null as any,
}));

vi.mock('./apiSocket', () => ({ apiSocket: { request: mocks.request, emitWithAck: mocks.emitWithAck, sessionRPC: mocks.sessionRPC } }));
vi.mock('./sync', () => ({ sync: { encryption: { getSessionEncryption: () => ({
    encryptRaw: mocks.encryptRaw, decryptRaw: mocks.decryptRaw,
}) } } }));
vi.mock('./storage', () => ({ storage: { getState: () => mocks.state } }));
vi.mock('./rigComposer', () => ({ rigComposerSetMode: vi.fn() }));

import { sessionArchiveTestloopDot, sessionDelete } from './ops';

beforeEach(() => {
    mocks.request.mockReset();
    mocks.emitWithAck.mockReset();
    mocks.sessionRPC.mockReset();
    mocks.encryptRaw.mockReset();
    mocks.decryptRaw.mockReset();
    mocks.encryptRaw.mockImplementation(async value => JSON.stringify(value));
    mocks.request.mockResolvedValue({ ok: true });
    mocks.emitWithAck.mockResolvedValue({ result: 'success', version: 5, metadata: 'encrypted' });
    mocks.state = { sessions: { 'dot-session': {
        id: 'dot-session', active: true, metadataVersion: 4,
        metadata: { testloopDots: dotBinding, summary: { text: '写作助理', updatedAt: 1 }, lifecycleState: 'running', preserved: 'value' },
    } } };
});

describe('Testloop Dot archive mirror', () => {
    it('archives the host session and version-writes lifecycle metadata without deleting preserved fields', async () => {
        await sessionArchiveTestloopDot('dot-session', dotId);

        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('/v1/sessions/dot-session/archive', { method: 'POST' });
        expect(mocks.emitWithAck).toHaveBeenCalledOnce();
        expect(mocks.emitWithAck).toHaveBeenCalledWith('update-metadata', {
            sid: 'dot-session', metadata: expect.any(String), expectedVersion: 4,
        });
        const written = mocks.encryptRaw.mock.calls.at(-1)?.[0];
        expect(written).toMatchObject({ lifecycleState: 'archived', lifecycleStateSince: expect.any(Number),
            testloopDots: dotBinding, summary: { text: '写作助理', updatedAt: 1 }, preserved: 'value' });
        expect(mocks.request).not.toHaveBeenCalledWith('/v1/sessions/dot-session', expect.anything());
        expect(mocks.sessionRPC).not.toHaveBeenCalled();
    });

    it('is idempotent once both archive predicates are present and completes a metadata-only partial retry', async () => {
        const session = mocks.state.sessions['dot-session'];
        session.active = false;
        session.metadata.lifecycleState = 'archived';
        session.metadata.lifecycleStateSince = 123;
        await sessionArchiveTestloopDot('dot-session', dotId);
        expect(mocks.request).not.toHaveBeenCalled();
        expect(mocks.emitWithAck).not.toHaveBeenCalled();

        session.metadata.lifecycleState = 'running';
        delete session.metadata.lifecycleStateSince;
        await sessionArchiveTestloopDot('dot-session', dotId);
        expect(mocks.request).not.toHaveBeenCalled();
        expect(mocks.emitWithAck).toHaveBeenCalledOnce();
        expect(mocks.encryptRaw.mock.calls[0][0]).toMatchObject({ lifecycleState: 'archived' });
    });

    it('leaves a failed archive retryable and does not write a false lifecycle tombstone', async () => {
        mocks.request.mockResolvedValueOnce({ ok: false, status: 503 });
        await expect(sessionArchiveTestloopDot('dot-session', dotId)).rejects.toThrow('503');
        expect(mocks.emitWithAck).not.toHaveBeenCalled();

        await sessionArchiveTestloopDot('dot-session', dotId);
        expect(mocks.request).toHaveBeenCalledTimes(2);
        expect(mocks.emitWithAck).toHaveBeenCalledOnce();
    });

    it('reapplies only the archive patch after a metadata version conflict', async () => {
        const latest = { testloopDots: dotBinding, summary: { text: '最新名称' }, lifecycleState: 'running', latest: true };
        mocks.decryptRaw.mockResolvedValue(latest);
        mocks.emitWithAck.mockResolvedValueOnce({ result: 'version-mismatch', version: 8, metadata: 'latest-encrypted' })
            .mockResolvedValueOnce({ result: 'success', version: 9, metadata: 'written' });

        await sessionArchiveTestloopDot('dot-session', dotId);
        expect(mocks.emitWithAck).toHaveBeenNthCalledWith(2, 'update-metadata', {
            sid: 'dot-session', metadata: expect.any(String), expectedVersion: 8,
        });
        expect(mocks.encryptRaw.mock.calls.at(-1)?.[0]).toMatchObject({
            lifecycleState: 'archived', summary: { text: '最新名称' }, latest: true, testloopDots: dotBinding,
        });
    });

    it('refuses a changed session binding before any archive or metadata request', async () => {
        mocks.state.sessions['dot-session'].metadata.testloopDots = { ...dotBinding, dotId: '66666666-6666-4666-8666-666666666666' };
        await expect(sessionArchiveTestloopDot('dot-session', dotId)).rejects.toThrow('binding changed');
        expect(mocks.request).not.toHaveBeenCalled();
        expect(mocks.emitWithAck).not.toHaveBeenCalled();
    });
});

describe('Testloop generic delete last line of defense', () => {
    it.each(['dot', 'workspace'] as const)('refuses physical deletion for a valid %s without calling the server', async kind => {
        mocks.state.sessions['dot-session'].metadata.testloopDots = kind === 'dot' ? dotBinding : { schemaVersion: 1, kind, workspaceId };
        await expect(sessionDelete('dot-session')).resolves.toMatchObject({ success: false, message: expect.stringContaining('Dots') });
        expect(mocks.request).not.toHaveBeenCalled();
    });
});
