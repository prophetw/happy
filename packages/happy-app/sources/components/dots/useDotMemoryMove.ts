import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { sync } from '@/sync/sync';
import { clearDotMemoryMove, dotMemoryMoveError, dotMemoryMoveNotice, loadDotMemoryMoves, requestDotMemoryMove,
    saveDotMemoryMove, type DotMemoryMoveIntent, type DotMemoryMoveReceipt } from '@/sync/dotMemoryMove';
import type { MemoryScope } from '@/sync/dotObservation';

/** No effects perform a migration. Only a user press can enter run(), including recovery. */
export function useDotMemoryMove({ sessionId, dotId, localScope, binding, cancellation, current, refresh }: {
    sessionId: string; dotId: string; localScope: string | null; binding: object; cancellation: () => number; current: () => boolean; refresh: () => Promise<void>;
}) {
    const [state, setState] = React.useState<{ scope: string | null; pending: DotMemoryMoveIntent[]; busy: boolean;
        error: string | null; notice: string | null; receipt: DotMemoryMoveReceipt | null }>({ scope: null, pending: [], busy: false, error: null, notice: null, receipt: null });
    const live = React.useRef({ localScope, binding, cancellation, current, refresh }); live.current = { localScope, binding, cancellation, current, refresh };
    const inFlight = React.useRef(false);
    React.useEffect(() => {
        try { setState({ scope: localScope, pending: localScope ? loadDotMemoryMoves(localScope) : [], busy: false, error: null, notice: null, receipt: null }); }
        catch (failure) { setState({ scope: localScope, pending: [], busy: false, error: dotMemoryMoveError(failure), notice: null, receipt: null }); }
    }, [localScope, binding]);
    const run = async (intent: DotMemoryMoveIntent, recover: boolean, cancel = false, inspect = false) => {
        const scope = localScope;
        if (!scope || inFlight.current || !live.current.current() || live.current.localScope !== scope || live.current.binding !== binding) return;
        const generation = live.current.cancellation();
        inFlight.current = true;
        const valid = () => live.current.localScope === scope && live.current.binding === binding && live.current.cancellation() === generation && live.current.current();
        const update = (patch: Partial<typeof state>) => { if (valid()) setState(previous => ({ ...previous, scope, ...patch })); };
        let phase: 'prepare' | 'status' | 'move' | 'cancel' = cancel ? 'cancel' : recover ? 'status' : 'prepare';
        const addError = (message: string) => { if (valid()) setState(previous => ({ ...previous, error: [previous.error, message].filter(Boolean).join(' ') })); };
        const save = () => {
            try { saveDotMemoryMove(scope, intent); update({ pending: loadDotMemoryMoves(scope) }); return true; }
            catch { addError('本机无法保存移动恢复记录，已停止继续发送请求。请检查设备存储后重试。'); return false; }
        };
        const show = async (receipt: DotMemoryMoveReceipt) => {
            if (!valid()) return;
            update({ receipt, notice: dotMemoryMoveNotice(receipt), error: receipt.error ? dotMemoryMoveError(new Error(receipt.error)) : null });
            if (receipt.status === 'abandoned' || receipt.status === 'completed_locally' && ['indexed', 'superseded'].includes(receipt.indexing) && receipt.cleanup === 'complete') {
                try { clearDotMemoryMove(scope, intent.requestID); update({ pending: loadDotMemoryMoves(scope) }); }
                catch { addError('移动回执已保留；本机恢复记录未能更新，请稍后重新核对。'); }
            }
            // A refresh failure must never replace a confirmed receipt with a failed migration.
            if (receipt.status !== 'ready') {
                try { await live.current.refresh(); }
                catch { addError('移动回执已保留；两层列表刷新失败，请刷新核对。'); }
            }
        };
        try {
            update({ error: null, notice: null, receipt: null });
            if (!inspect && !save()) return;
            update({ busy: true });
            await sync.ensureSessionReady(sessionId);
            if (!valid()) return;
            if (cancel) { await show(await requestDotMemoryMove(sessionId, 'cancel', intent)); return; }
            if (recover) {
                try {
                    const receipt = await requestDotMemoryMove(sessionId, 'status', intent);
                    if (!valid()) return;
                    if (receipt.status === 'completed_locally' || receipt.status === 'needs_attention' || receipt.status === 'abandoned') { await show(receipt); return; }
                    if (intent.targetRevision === undefined) { intent = { ...intent, targetRevision: receipt.targetExpectedRevision }; if (!save()) return; }
                } catch (failure) {
                    if (!(failure instanceof Error) || failure.message !== 'memory_move_not_found') throw failure;
                }
            }
            if (!valid()) return;
            if (intent.targetRevision === undefined || inspect) {
                phase = 'prepare';
                const prepared = await requestDotMemoryMove(sessionId, 'prepare', intent);
                if (!valid()) return;
                if (prepared.requestID !== intent.requestID) {
                    const replacedID = intent.requestID;
                    intent = { ...intent, requestID: prepared.requestID, sourceRevision: prepared.sourceRevision, targetRevision: prepared.targetExpectedRevision };
                    if (!save()) return;
                    try { if (!inspect) clearDotMemoryMove(scope, replacedID); }
                    catch { addError('已找到宿主原请求，但本机恢复记录未能更新。请稍后重新核对。'); return; }
                    update({ pending: loadDotMemoryMoves(scope), notice: '发现这条记忆上次未完成的移动，请恢复原请求并核对结果。', receipt: prepared });
                    return;
                }
                if (inspect) {
                    // A query press never authorizes a new migration, including a source which became effective again.
                    if (prepared.duplicate || prepared.status !== 'ready') {
                        intent = { ...intent, sourceRevision: prepared.sourceRevision, targetRevision: prepared.targetExpectedRevision };
                        if (save()) await show(prepared);
                    } else update({ notice: '未找到这条记忆的未完成移动；本次仅核对，未发起移动。' });
                    return;
                }
                if (prepared.status !== 'ready') { await show(prepared); return; }
                intent = { ...intent, targetRevision: prepared.targetExpectedRevision }; if (!save()) return;
            }
            if (!valid()) return;
            phase = 'move';
            const receipt = await requestDotMemoryMove(sessionId, 'move', intent);
            if (valid()) await show(receipt);
        } catch (failure) {
            if (inspect) {
                const code = failure instanceof Error ? failure.message : '';
                update({ error: code === 'memory_move_source_unavailable' ? '未找到可恢复的移动记录，源记忆已过期、未确认或不可用；本次未发起移动。'
                    : ['memory_move_transport_unconfirmed', 'memory_move_invalid_response'].includes(code)
                        ? '未收到可核对的移动记录，本次未提交移动。请检查连接后再次核对。' : dotMemoryMoveError(failure) });
                return;
            }
            // A rejected read-only prepare has not changed either ledger. Other failures retain the ID for recovery.
            let storageError = '', pending: DotMemoryMoveIntent[] | undefined;
            try {
                if (phase === 'prepare' && failure instanceof Error && ['memory_move_source_changed', 'memory_move_source_unavailable',
                    'memory_move_target_conflict', 'memory_move_not_authorized', 'memory_move_identity_unavailable', 'memory_move_identity_changed'].includes(failure.message)) {
                    clearDotMemoryMove(scope, intent.requestID);
                }
                pending = loadDotMemoryMoves(scope);
            } catch { storageError = ' 本机恢复记录未能更新，请检查设备存储并保留原请求。'; }
            update({ error: dotMemoryMoveError(failure) + storageError, ...(pending ? { pending } : {}) });
        } finally {
            inFlight.current = false;
            setState(previous => previous.scope === scope ? { ...previous, busy: false } : previous);
        }
    };
    const shown = state.scope === localScope && current() ? state : { ...state, pending: [], error: null, notice: null, receipt: null, busy: false };
    return { ...shown, start: (keyDigest: string, sourceRevision: number, sourceScope: MemoryScope) => {
        if (!localScope || !live.current.current() || live.current.binding !== binding) return;
        try {
            const previous = loadDotMemoryMoves(localScope).find(item => item.dotId === dotId && item.keyDigest === keyDigest
                && item.sourceScope === sourceScope && item.sourceRevision === sourceRevision);
            void run(previous ?? { requestID: randomUUID(), dotId, keyDigest, sourceRevision, sourceScope }, Boolean(previous));
        } catch (failure) { setState(previous => ({ ...previous, scope: localScope, error: dotMemoryMoveError(failure) })); }
    }, inspect: (keyDigest: string, sourceRevision: number, sourceScope: MemoryScope) => {
        if (localScope && live.current.current() && live.current.binding === binding)
            void run({ requestID: randomUUID(), dotId, keyDigest, sourceRevision, sourceScope }, false, false, true);
    }, recover: (intent: DotMemoryMoveIntent) => void run(intent, true), cancel: (intent: DotMemoryMoveIntent) => void run(intent, true, true) };
}
