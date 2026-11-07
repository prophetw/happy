import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@/auth/AuthContext';
import { useSessionVisibility } from '@/hooks/useSessionVisibility';
import { storage, useRealtimeStatus, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionArchiveTestloopDot, sessionUpdateDotIdentity } from '@/sync/ops';
import { getServerUrl } from '@/sync/serverConfig';
import { retiredDotSessionIds, projectTestloopDotsMessages, readTestloopDotsMetadata, testloopDotsCommand, type TestloopDotsRequest } from '@/sync/testloopDots';

type Pending = { request: TestloopDotsRequest; attempt: number; timedOut: boolean };
type Deletion = { requestId: string; revision: number; id: string; sessionId: string };

// A workspace and an open Dot can observe the same durable receipt together.
// Share the actual attempt so they cannot archive one session twice.
const archiveAttempts = new Map<string, Promise<void>>();

/** Deletion receipts the latest projection confirms: the target is gone from the current list. */
function confirmedDeletionsOf(raw: ReturnType<typeof projectTestloopDotsMessages>): Deletion[] {
    const current = raw.snapshot;
    if (!current?.ok) return [];
    const byDot = new Map<string, Deletion>();
    for (const deletion of Object.values(raw.deletions)) {
        if (current.revision < deletion.revision
            || current.dots.some(dot => dot.id === deletion.id || dot.sessionId === deletion.sessionId)) continue;
        byDot.set(deletion.id, deletion);
    }
    return [...byDot.values()];
}

/** The UI reads encrypted host receipts; sending a message is never a business success receipt. */
export function useDotsWorkspace(sessionId: string, workspaceId: string, active: boolean, detailDotId?: string) {
    const auth = useAuth();
    const token = auth.credentials?.token, secret = auth.credentials?.secret, server = getServerUrl();
    const scope = React.useMemo(() => ({}), [token, secret, server, sessionId, workspaceId, detailDotId]);
    const [readyScope, setReadyScope] = React.useState<object | null>(null);
    const [reload, setReload] = React.useState(0);
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const raw = React.useMemo(() => projectTestloopDotsMessages(messages, workspaceId), [messages, workspaceId]);
    const [pending, setPending] = React.useState<Pending | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);
    const [archiveErrors, setArchiveErrors] = React.useState<Record<string, string>>({});
    const [archivePendingIds, setArchivePendingIds] = React.useState<string[]>([]);
    const generation = React.useRef(0), initialized = React.useRef(false), mounted = React.useRef(true);
    const pendingId = React.useRef<string | null>(null);
    const latestProjection = React.useRef(raw);
    const announcedDeletions = React.useRef(new Set<string>());
    // Only a deletion this view asked for is feedback the user is waiting on.
    const requestedDeletions = React.useRef(new Set<string>());
    latestProjection.current = raw;
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
    const sameAccount = React.useCallback(() => !!token && auth.isAuthenticated
        && sync.getCredentials()?.token === token && sync.getCredentials()?.secret === secret && getServerUrl() === server,
    [token, secret, server, auth.isAuthenticated]);
    const validBinding = React.useCallback(() => {
        const binding = readTestloopDotsMetadata(storage.getState().sessions[sessionId]?.metadata);
        return sameAccount() && binding?.kind === 'workspace' && binding.workspaceId === workspaceId;
    }, [sameAccount, sessionId, workspaceId]);

    useFocusEffect(React.useCallback(() => {
        const epoch = ++generation.current;
        initialized.current = false; pendingId.current = null;
        setReadyScope(null); setPending(null); setError(null); setNotice(null); setArchiveErrors({});
        if (active && sameAccount()) void sync.ensureSessionReady(sessionId).then(() => {
            if (epoch !== generation.current || !mounted.current) return;
            if (!validBinding()) throw new Error('workspace_binding_changed');
            setReadyScope(scope);
        }).catch(() => {
            if (epoch === generation.current && mounted.current && sameAccount()) setError('暂时无法读取工作台，请检查连接后重试。');
        });
        return () => { generation.current++; };
    }, [scope, sessionId, active, sameAccount, validBinding, reload]));

    const ready = readyScope === scope && validBinding();
    const realtime = useRealtimeStatus();
    useSessionVisibility(sessionId, active && ready, Boolean(detailDotId), realtime);
    const submit = React.useCallback(async (request: TestloopDotsRequest) => {
        if (!validBinding() || !active) return;
        const epoch = generation.current;
        const current = () => mounted.current && generation.current === epoch && validBinding();
        if (request.action === 'delete') requestedDeletions.current.add(request.requestId);
        pendingId.current = request.requestId;
        setPending(previous => ({ request, attempt: (previous?.attempt ?? 0) + 1, timedOut: false }));
        setError(null); setNotice(null);
        try {
            const accepted = await sync.sendMessage(sessionId, testloopDotsCommand(request), {
                displayText: request.action === 'create' ? `创建 Dot：${request.name}`
                    : request.action === 'update' ? `更新 Dot：${request.name}`
                    : request.action === 'clear' ? '清空 Dot 当前对话上下文'
                    : request.action === 'delete' ? '删除 Dot'
                    : request.action === 'inspect' ? '刷新 Dot 工作与记忆' : '刷新 Dots 列表',
                awaitDelivery: true, isCurrent: current,
            });
            if (!accepted && current() && pendingId.current === request.requestId) {
                setError('请求尚未确认送达，可以沿用原请求重试。');
                setPending(previous => previous?.request.requestId === request.requestId ? { ...previous, timedOut: true } : previous);
            }
        } catch {
            if (current() && pendingId.current === request.requestId) {
                setError('请求结果尚未确认，重试会保留原请求编号。');
                setPending(previous => previous?.request.requestId === request.requestId ? { ...previous, timedOut: true } : previous);
            }
        }
    }, [sessionId, validBinding, active]);
    const refresh = React.useCallback(() => submit(detailDotId
        ? { schemaVersion: 1, requestId: randomUUID(), action: 'inspect', dotId: detailDotId }
        : { schemaVersion: 1, requestId: randomUUID(), action: 'list' }), [submit, detailDotId]);

    React.useEffect(() => {
        if (!ready || !active || !isLoaded || initialized.current) return;
        initialized.current = true;
        if (raw.pendingRequest) {
            if (raw.pendingRequest.action === 'delete') requestedDeletions.current.add(raw.pendingRequest.requestId);
            pendingId.current = raw.pendingRequest.requestId;
            setPending({ request: raw.pendingRequest, attempt: 0, timedOut: true });
            setError('上次请求尚无处理回执，可以重试同一请求核对结果。');
        } else void refresh();
    }, [ready, active, isLoaded, raw.pendingRequest, raw, refresh]);

    const confirmedDeletions = React.useMemo(() => confirmedDeletionsOf(raw), [raw]);

    React.useEffect(() => {
        if (!ready) return;
        for (const deletion of confirmedDeletions) {
            if (!requestedDeletions.current.has(deletion.requestId)) continue;
            if (announcedDeletions.current.has(deletion.requestId)) continue;
            announcedDeletions.current.add(deletion.requestId);
            setError(previous => previous?.startsWith('后台已接受删除') ? null : previous);
            setNotice('已删除 Dot，历史对话与记录已保留。');
        }
    }, [ready, confirmedDeletions]);

    React.useEffect(() => {
        const snapshot = raw.snapshot;
        if (!ready || !active || !snapshot?.ok) return;
        for (const id of retiredDotSessionIds(snapshot, Object.values(storage.getState().sessions))) sync.forgetDeletedDotSession(id);
    }, [ready, active, raw.snapshot, workspaceId]);
    const reconcileArchive = React.useCallback(async (deletion: Deletion) => {
        if (!validBinding()) return;
        const existing = storage.getState().sessions[deletion.sessionId];
        if (existing?.active === false && existing.metadata?.lifecycleState === 'archived') {
            setArchiveErrors(previous => {
                if (!(deletion.id in previous)) return previous;
                const next = { ...previous }; delete next[deletion.id]; return next;
            });
            return;
        }

        let attempt = archiveAttempts.get(deletion.id);
        if (!attempt) {
            attempt = (async () => {
                await sync.ensureSessionReady(deletion.sessionId);
                if (!validBinding()) throw new Error('workspace_binding_changed');
                const binding = readTestloopDotsMetadata(storage.getState().sessions[deletion.sessionId]?.metadata);
                if (binding?.kind !== 'dot' || binding.dotId !== deletion.id || binding.workspaceId !== workspaceId
                    || binding.workspaceSessionId !== sessionId) throw new Error('dot_binding_changed');
                // A newer projection may have revived the same id. Never archive
                // a live binding on the strength of an older deletion receipt.
                const current = latestProjection.current.snapshot;
                if (!current?.ok || current.revision < deletion.revision
                    || current.dots.some(dot => dot.id === deletion.id || dot.sessionId === deletion.sessionId)) return;
                await sessionArchiveTestloopDot(deletion.sessionId, deletion.id);
            })();
            archiveAttempts.set(deletion.id, attempt);
            const running = attempt;
            running.then(() => {
                if (archiveAttempts.get(deletion.id) === running) archiveAttempts.delete(deletion.id);
            }, () => {
                if (archiveAttempts.get(deletion.id) === running) archiveAttempts.delete(deletion.id);
            });
        }
        setArchivePendingIds(previous => previous.includes(deletion.id) ? previous : [...previous, deletion.id]);
        setArchiveErrors(previous => {
            if (!(deletion.id in previous)) return previous;
            const next = { ...previous }; delete next[deletion.id]; return next;
        });
        try {
            await attempt;
            if (!mounted.current || !validBinding()) return;
            setArchiveErrors(previous => {
                if (!(deletion.id in previous)) return previous;
                const next = { ...previous }; delete next[deletion.id]; return next;
            });
        } catch {
            if (mounted.current && validBinding()) {
                setArchiveErrors(previous => ({ ...previous,
                    [deletion.id]: '宿主已删除 Dot，但本地会话归档尚未完成；历史记录仍保留，可单独重试本地归档。' }));
            }
        } finally {
            if (mounted.current) setArchivePendingIds(previous => previous.filter(id => id !== deletion.id));
        }
    }, [sessionId, workspaceId, validBinding]);

    React.useEffect(() => {
        if (!ready || !active) return;
        for (const deletion of confirmedDeletions) void reconcileArchive(deletion);
    }, [ready, active, confirmedDeletions, reconcileArchive]);
    const retryArchive = React.useCallback((dotId?: string) => {
        for (const deletion of confirmedDeletions) {
            if (dotId && deletion.id !== dotId) continue;
            if (!dotId && !archiveErrors[deletion.id]) continue;
            void reconcileArchive(deletion);
        }
    }, [confirmedDeletions, archiveErrors, reconcileArchive]);
    React.useEffect(() => {
        if (!ready || !pending) return;
        const receipt = raw.receipts[pending.request.requestId];
        if (!receipt) return;
        const request = pending.request;
        pendingId.current = null; setPending(null);
        if (!receipt.ok) setError(`后台未接受本次操作${receipt.error ? `（${receipt.error}）` : ''}。`);
        else if (request.action === 'inspect' && receipt.workbench?.detail?.dotId !== request.dotId)
            setError('后台未提供对应 Dot 的工作与记忆数据，请核对宿主版本后刷新。');
        else if (request.action === 'clear') {
            const receiptDot = receipt.dots.find(dot => dot.id === request.dotId);
            const currentDot = raw.snapshot?.ok
                ? raw.snapshot.dots.find(dot => dot.id === request.dotId) : undefined;
            if (!receiptDot || !currentDot || receiptDot.sessionId !== currentDot.sessionId) {
                setError('后台已接受清空，但最新列表尚未确认原 Dot 与会话仍存在，请刷新核对。');
            } else {
                setError(null);
                setNotice('已清空旧聊天并重置模型上下文；长期记忆、Dot 身份、模型设置、授权和独立任务保留。');
            }
        } else if (request.action === 'delete') {
            if (receipt.deletedDot?.id !== request.dotId) {
                setError('后台删除回执缺少对应 Dot 的删除确认，请刷新核对。');
            } else if (!confirmedDeletions.some(deletion => deletion.requestId === request.requestId)) {
                setError('后台已接受删除，正在等待最新列表确认目标已消失。');
            } else setError(null);
        } else {
            setError(null);
            if (request.action === 'create') setNotice(`已创建「${request.name}」。`);
            if (request.action === 'update') {
                setNotice(`已更新「${request.name}」。`);
                const dot = receipt.dots.find(item => item.id === request.dotId);
                if (dot) void sync.ensureSessionReady(dot.sessionId)
                    .then(() => {
                        const binding = readTestloopDotsMetadata(storage.getState().sessions[dot.sessionId]?.metadata);
                        if (binding?.kind !== 'dot' || binding.dotId !== dot.id || binding.workspaceId !== workspaceId
                            || binding.workspaceSessionId !== sessionId) throw new Error('dot_binding_changed');
                        return sessionUpdateDotIdentity(dot.sessionId, request.name, request.instruction);
                    })
                    .catch(error => console.error(`Failed to sync Dot identity for session ${dot.sessionId}`, error));
            }
        }
    }, [raw.receipts, raw.snapshot, pending, ready, confirmedDeletions, sessionId, workspaceId]);
    React.useEffect(() => {
        if (!pending || pending.timedOut) return;
        const id = pending.request.requestId;
        const timer = setTimeout(() => {
            if (pendingId.current !== id) return;
            setPending(previous => previous?.request.requestId === id ? { ...previous, timedOut: true } : previous);
            setError('仍未收到后台回执，可以重试上次请求。');
        }, 15000);
        return () => clearTimeout(timer);
    }, [pending?.request.requestId, pending?.attempt, pending?.timedOut]);

    return { ready, projection: ready ? raw : null, pending: ready ? pending : null, error, notice: ready ? notice : null,
        archiveError: ready ? Object.values(archiveErrors)[0] ?? null : null,
        archivePending: ready && archivePendingIds.length > 0,
        submit, refresh, retryArchive,
        retry: () => !ready ? setReload(value => value + 1) : pending ? submit(pending.request) : refresh() };
}
