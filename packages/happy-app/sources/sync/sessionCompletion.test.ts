import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ApiUpdateContainerSchema } from './apiTypes';
import { normalizeRawMessage } from './typesRaw';
import type { AgentState, Session } from './storageTypes';
import { didSessionCompleteTurn, selectCompletedSessionIds } from './sessionCompletion';
import { getSessionAttentionStatus } from '@/utils/sessionListStatus';
import { selectMobileSessionAttention } from './mobileSessionAttention';

// The real store; only native storage, the socket and encryption are replaced.
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('./persistence', () => ({
    loadSettings: () => ({}), loadLocalSettings: () => ({}), saveLocalSettings: vi.fn(), saveSettings: vi.fn(),
    loadPurchases: () => null, savePurchases: vi.fn(), loadProfile: () => null, saveProfile: vi.fn(),
    loadSessionDrafts: () => ({}), saveSessionDrafts: vi.fn(),
    loadRigComposerDraft: () => null, saveRigComposerDraft: vi.fn(),
    loadSessionLastMessageSentAt: () => ({}), saveSessionLastMessageSentAt: vi.fn(),
}));
vi.mock('./sync', () => ({ sync: { encryption: null } }));
vi.mock('./apiSocket', () => ({ apiSocket: { emitWithAck: vi.fn() } }));
vi.mock('@/realtime/RealtimeSession', () => ({ getCurrentRealtimeSessionId: () => null, getVoiceSession: () => null }));
vi.mock('@/components/tools/knownTools', () => ({ isMutableTool: () => true }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { storage } from './storage';

afterEach(() => vi.unstubAllGlobals());

function session(id = 'a', patch: Partial<Session> = {}): Session {
    return {
        id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
        thinking: false, thinkingAt: 0, presence: 'online', ...patch,
    };
}

const permission = { requests: { p: { tool: 'Bash', arguments: {} } } } as AgentState;
const question = { communications: { q: { kind: 'form', form: { questions: [{ id: 'q', header: 'Continue', question: 'Continue?', options: [{ label: 'Yes' }] }] } } } } as AgentState;
const asyncQuestion = { communications: { q: { ...question.communications!.q, isBlocking: false } } } as AgentState;

describe('session completion', () => {
    it('recognizes an active turn becoming idle, but not an ordinary heartbeat or initial load', () => {
        expect(didSessionCompleteTurn(session('a', { thinking: true }), session())).toBe(true);
        expect(didSessionCompleteTurn(session(), session())).toBe(false);
        expect(didSessionCompleteTurn(session('a', { presence: 1 }), session())).toBe(false);
    });

    it('does not mistake a disconnect, permission prompt, or blocking question for completion', () => {
        const running = session('a', { thinking: true });
        expect(didSessionCompleteTurn(running, session('a', { presence: 2 }))).toBe(false);
        expect(didSessionCompleteTurn(running, session('a', { agentState: permission }))).toBe(false);
        expect(didSessionCompleteTurn(running, session('a', { agentState: question }))).toBe(false);
        expect(didSessionCompleteTurn(session('a', { agentState: permission }), session('a', { thinking: true }))).toBe(false);
        expect(didSessionCompleteTurn(session('a', { agentState: question }), session())).toBe(true);
    });

    it('keeps running and waiting-for-input states ahead of old unread results', () => {
        expect(getSessionAttentionStatus('thinking', true)).toBe('running');
        expect(getSessionAttentionStatus('permission_required', true)).toBe('permission_required');
        expect(getSessionAttentionStatus('input_required', true)).toBe('input_required');
        expect(getSessionAttentionStatus('waiting', true)).toBe('completed');
        expect(getSessionAttentionStatus('waiting', false)).toBeNull();
        expect(getSessionAttentionStatus('disconnected', false)).toBeNull();
    });

    it('only queues unread finished top-level conversations, newest first', () => {
        const sessions = Object.fromEntries([
            session('a'), session('b'), session('read'), session('viewing'), session('archiving'),
            session('archived', { metadata: { lifecycleState: 'archived' } as Session['metadata'] }),
            session('side', { metadata: { isSideChat: true } as Session['metadata'] }),
            session('running', { thinking: true }), session('permission', { agentState: permission }),
            session('question', { agentState: question }),
            session('offline-result', { presence: 10, active: false, metadata: { client: { id: 'rig' } } as Session['metadata'] }),
            session('inactive-cli', { presence: 10, active: false }),
        ].map(s => [s.id, s]));
        expect(selectCompletedSessionIds({
            sessions,
            unreadSessionIds: new Set(['a', 'b', 'viewing', 'archiving', 'archived', 'side', 'running', 'permission', 'question', 'deleted', 'offline-result', 'inactive-cli']),
            archivingSessionIds: new Set(['archiving']), currentViewingSessionId: 'viewing',
        })).toEqual(['offline-result', 'b', 'a']);
    });
});


describe('completion state through the real session store', () => {
    beforeEach(() => {
        storage.setState({ sessions: {}, machines: {}, unreadSessionIds: new Set(), sessionAttention: {}, archivingSessionIds: new Set(), currentViewingSessionId: null, appIsActive: true });
    });

    function apply(patch: Partial<Session>) {
        const previous = storage.getState().sessions.a ?? session();
        storage.getState().applySessions([{ ...previous, ...patch, seq: previous.seq + 1, agentStateVersion: previous.agentStateVersion + 1 }]);
    }

    it('creates one unread result per background turn, clears it on rerun, and clears it on opening', () => {
        apply({ thinking: true });
        expect(storage.getState().unreadSessionIds.size).toBe(0);
        apply({ thinking: false });
        expect(selectCompletedSessionIds(storage.getState())).toEqual(['a']);
        apply({ thinking: false });
        expect(selectCompletedSessionIds(storage.getState())).toEqual(['a']);
        apply({ thinking: true });
        expect(storage.getState().unreadSessionIds.has('a')).toBe(false);
        apply({ thinking: false });
        expect(selectCompletedSessionIds(storage.getState())).toEqual(['a']);
        storage.getState().setCurrentViewingSession('a');
        expect(storage.getState().unreadSessionIds.has('a')).toBe(false);
        expect(selectCompletedSessionIds(storage.getState())).toEqual([]);
    });

    it('does not notify for the conversation already being viewed', () => {
        apply({ thinking: true });
        storage.getState().setCurrentViewingSession('a');
        apply({ thinking: false });
        expect(storage.getState().unreadSessionIds.size).toBe(0);
    });

    it('keeps a successful retry successful after heartbeats and delayed failure metadata', () => {
        apply({ thinking: true });
        apply({ thinking: false, lastTurnStatus: 'failed' });
        storage.getState().applySessionAttention({ a: {
            kind: 'failed', eventId: 'failed:3', seq: 3, at: 10, read: false, version: 0,
        } });
        apply({ thinking: true, lastTurnStatus: undefined });
        apply({ thinking: false, lastTurnStatus: 'completed', lastTurnSeq: 5 });
        apply({ thinking: false }); // Presence refresh before the done push arrives.
        expect(storage.getState().sessions.a.attentionKind).toBe('done');
        storage.getState().applySessionAttention({ a: {
            kind: 'failed', eventId: 'failed:3', seq: 3, at: 10, read: false, version: 1,
        } });
        expect(selectMobileSessionAttention({ ...storage.getState(), appIsActive: false }))
            .toEqual([expect.objectContaining({ status: 'completed' })]);
    });

    it('waits for a Codex outcome instead of showing success when thinking stops', () => {
        apply({ metadata: { flavor: 'codex' } as Session['metadata'], thinking: true });
        apply({ thinking: false });
        expect(storage.getState().unreadSessionIds.has('a')).toBe(false);
        apply({ lastTurnStatus: 'failed', lastTurnSeq: 3, lastTurnErrorCode: 'serverOverloaded' });
        expect(selectMobileSessionAttention({ ...storage.getState(), appIsActive: false }))
            .toEqual([expect.objectContaining({ status: 'failed', errorCode: 'serverOverloaded' })]);
        apply({ thinking: true, lastTurnStatus: undefined, lastTurnSeq: 4 });
        apply({ thinking: false });
        expect(storage.getState().unreadSessionIds.has('a')).toBe(false);
        apply({ lastTurnStatus: 'completed', lastTurnSeq: 5 });
        expect(selectCompletedSessionIds(storage.getState())).toEqual(['a']);
    });

    it('clears an inferred completion when a cancellation arrives late', () => {
        apply({ thinking: true });
        apply({ thinking: false });
        apply({ lastTurnStatus: 'cancelled' });
        expect(storage.getState().unreadSessionIds.has('a')).toBe(false);
    });

    it('replays failed and successful wire turns through the real sync handler and store', async () => {
        // Match the receipt transport tests: run production methods while replacing
        // only the native shell, socket, and encryption boundary.
        const parsed = ts.createSourceFile('sync.ts', readFileSync(new URL('./sync.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
        const klass = parsed.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'Sync')!;
        const methods = klass.members.filter(member => member.name && ['handleUpdate', 'publishSessionFailure'].includes(member.name.getText(parsed)))
            .map(member => member.getText(parsed)).join('\n');
        const Harness = new Function('ApiUpdateContainerSchema', 'normalizeRawMessage', 'storage',
            ts.transpile(`class Sync { ${methods} }; return Sync;`, { target: ts.ScriptTarget.ES2022 }))(
            ApiUpdateContainerSchema, normalizeRawMessage, storage,
        );
        const sync = new Harness();
        Object.assign(sync, {
            encryption: { getSessionEncryption: () => ({ decryptMessage: async (message: any) => ({ ...message, content: JSON.parse(message.content.c) }) }) },
            applySessions: storage.getState().applySessions, sessionLastSeq: new Map(),
            getMessagesSync: () => ({ invalidate() {} }), onSessionDataUpdated() {},
        });
        apply({ thinking: false });
        const send = (seq: number, ev: Record<string, unknown>) => sync.handleUpdate({
            id: `update-${seq}`, seq, createdAt: seq,
            body: { t: 'new-message', sid: 'a', message: {
                id: `message-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
                content: { t: 'encrypted', c: JSON.stringify({ role: 'session', content: {
                    id: `event-${seq}`, time: seq, role: 'agent', turn: 'turn', ev,
                } }) },
            } },
        });
        await send(2, { t: 'turn-start' });
        await send(3, { t: 'turn-end', status: 'failed', errorCode: 'serverOverloaded' });
        expect(selectMobileSessionAttention({ ...storage.getState(), appIsActive: false }))
            .toEqual([expect.objectContaining({ status: 'failed', errorCode: 'serverOverloaded' })]);
        await send(4, { t: 'turn-start' });
        await send(5, { t: 'turn-end', status: 'completed' });
        apply({ thinking: false });
        await send(3, { t: 'turn-end', status: 'failed', errorCode: 'serverOverloaded' });
        expect(storage.getState().sessions.a).toMatchObject({ lastTurnStatus: 'completed', lastTurnSeq: 5 });
        expect(selectMobileSessionAttention({ ...storage.getState(), appIsActive: false }))
            .toEqual([expect.objectContaining({ status: 'completed' })]);
    });

    it.each(['hidden', 'unfocused'])('queues the open conversation when its browser tab is %s', (background) => {
        vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
        apply({ thinking: true });
        storage.getState().setCurrentViewingSession('a');
        vi.stubGlobal('document', {
            visibilityState: background === 'hidden' ? 'hidden' : 'visible',
            hasFocus: () => background === 'hidden',
        });
        apply({ thinking: false });
        expect(storage.getState().unreadSessionIds.has('a')).toBe(true);
        expect(selectCompletedSessionIds(storage.getState())).toEqual(['a']);
    });

    it('does not clear unread when navigation changes while the browser tab is hidden', () => {
        apply({ thinking: true });
        apply({ thinking: false });
        vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
        storage.getState().setCurrentViewingSession('a');
        expect(storage.getState().unreadSessionIds.has('a')).toBe(true);
        expect(selectCompletedSessionIds(storage.getState())).toEqual(['a']);
    });

    it('does not mark blocking questions or disconnects completed', () => {
        apply({ thinking: true });
        apply({ thinking: false, agentState: question });
        expect(storage.getState().unreadSessionIds.size).toBe(0);
        apply({ thinking: true, agentState: null });
        apply({ thinking: false, active: false });
        expect(storage.getState().unreadSessionIds.size).toBe(0);
    });

    it('shows a pending async question as input required after the turn stops', () => {
        apply({ thinking: true });
        apply({ agentState: asyncQuestion });
        apply({ thinking: false });
        const state = storage.getState();
        expect(selectCompletedSessionIds(state)).toEqual([]);
        expect(state.sessions.a.attentionKind).not.toBe('done');
        expect(selectMobileSessionAttention({ ...state, sessionAttention: {}, appIsActive: false }))
            .toEqual([expect.objectContaining({ id: 'a', status: 'input_required' })]);
    });
});
