import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@/auth/AuthContext';
import { useSessionVisibility } from '@/hooks/useSessionVisibility';
import { storage, useRealtimeStatus, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionArchiveTestloopDot, sessionUpdateDotIdentity } from '@/sync/ops';
import { readDotsWorkspace } from '@/sync/dotsWorkspaceRead';
import { loadDotsWorkspaceCommandState, requestDotsWorkspaceCommand, saveDotsWorkspaceCommand, settleDotsWorkspaceCommand,
    subscribeDotsWorkspaceCommand, type DotsWorkspaceCommandState } from '@/sync/dotsWorkspaceCommand';
import { getServerUrl } from '@/sync/serverConfig';
import { retiredDotSessionIds, projectTestloopDotsMessages, readTestloopDotsMetadata, mergeDotsWorkspaceRead, mergeDotsWorkspaceReceipt, type TestloopDotsSnapshot, type TestloopDotsRequest } from '@/sync/testloopDots';

type Pending = { request: TestloopDotsRequest; attempt: number; timedOut: boolean };
type Deletion = { requestId: string; revision: number; id: string; sessionId: string };

// Cache only bounded views, keyed by credentials, relay, workspace and detail.
const readResults = new Map<string, TestloopDotsSnapshot>();
// A workspace and an open Dot must share one durable receipt archive attempt.
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
    const history = React.useMemo(() => projectTestloopDotsMessages(messages, workspaceId), [messages, workspaceId]);
    const readKey = JSON.stringify([server, token, secret, sessionId, workspaceId, detailDotId]);
    const encryption = sync.encryption;
    const commandScope = React.useMemo(() => encryption?.anonID ? { encryption, serverUrl: server, sessionId, workspaceId } : null,
        [encryption, server, sessionId, workspaceId]);
    const [journal, setJournal] = React.useState<{ scope: typeof commandScope; state: DotsWorkspaceCommandState | null } | null>(null);
    const currentCommandScope = React.useRef(commandScope); currentCommandScope.current = commandScope;
    const journalRead = React.useRef(0);
    const [live, setLive] = React.useState<{ key: string; snapshot: TestloopDotsSnapshot } | null>(null);
    const raw = React.useMemo(() => {
        const read = mergeDotsWorkspaceRead(history, live?.key === readKey ? live.snapshot : readResults.get(readKey));
        const state = journal?.scope === commandScope ? journal.state : null;
        if (!state?.result) return read;
        const receipt = state.result.snapshot ?? { schemaVersion: 1 as const, workspaceId, requestId: state.command.requestId,
            revision: read.snapshot?.revision ?? 0, ok: false, error: state.result.error ?? undefined, dots: read.snapshot?.dots ?? [] };
        return mergeDotsWorkspaceReceipt(read, state.command, receipt);
    }, [history, live, readKey, journal, commandScope, workspaceId]);
    const [refreshing, setRefreshing] = React.useState(false);
    const [readError, setReadError] = React.useState<string | null>(null);
    const readAttempt = React.useRef(0), recovered = React.useRef(false);
    const inFlightRead = React.useRef<{ epoch: number; promise: Promise<void> } | null>(null);
    const [pending, setPending] = React.useState<Pending | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);
    const [archiveErrors, setArchiveErrors] = React.useState<Record<string, string>>({});
    const [archivePendingIds, setArchivePendingIds] = React.useState<string[]>([]);
    const generation = React.useRef(0), initialized = React.useRef(false), mounted = React.useRef(true);
    const pendingId = React.useRef<string | null>(null);
    const writing = React.useRef<{ scope: typeof commandScope } | null>(null);
    const savingReceipts = React.useRef(new Set<string>());
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

    const restoreJournal = React.useCallback(async () => {
        if (!commandScope) throw new Error('dots_command_encryption_unavailable');
        const version = ++journalRead.current;
        const state = await loadDotsWorkspaceCommandState(commandScope);
        if (version === journalRead.current && mounted.current && currentCommandScope.current === commandScope && validBinding())
            setJournal({ scope: commandScope, state });
    }, [commandScope, validBinding]);
    React.useEffect(() => commandScope ? subscribeDotsWorkspaceCommand(commandScope, () => {
        void restoreJournal().catch(() => {
            if (mounted.current && validBinding()) setError('本机操作恢复记录无法读取，请检查设备存储后重试。');
        });
    }) : undefined, [commandScope, restoreJournal, validBinding]);

    useFocusEffect(React.useCallback(() => {
        const epoch = ++generation.current;
        initialized.current = false; recovered.current = false; pendingId.current = null;
        readAttempt.current++; inFlightRead.current = null; setRefreshing(false); setReadError(null);
        setReadyScope(null); setPending(null); setError(null); setNotice(null); setArchiveErrors({});
        if (active && sameAccount()) void sync.ensureSessionReady(sessionId).then(async () => {
            if (epoch !== generation.current || !mounted.current) return;
            if (!validBinding()) throw new Error('workspace_binding_changed');
            await restoreJournal();
            if (epoch !== generation.current || !mounted.current || !validBinding()) return;
            setReadyScope(scope);
        }).catch(() => {
            if (epoch === generation.current && mounted.current && sameAccount()) setError('暂时无法读取工作台，请检查连接后重试。');
        });
        return () => { generation.current++; };
    }, [scope, sessionId, active, sameAccount, validBinding, reload, restoreJournal]));

    const ready = readyScope === scope && validBinding();
    const realtime = useRealtimeStatus();
    useSessionVisibility(sessionId, active && ready, Boolean(detailDotId), realtime);
    const refresh = React.useCallback((): Promise<void> => {
        if (!validBinding() || !active) return Promise.resolve();
        const epoch = generation.current;
        if (inFlightRead.current?.epoch === epoch) return inFlightRead.current.promise;
        const attempt = ++readAttempt.current;
        const current = () => mounted.current && generation.current === epoch && readAttempt.current === attempt && validBinding();
        setRefreshing(true); setReadError(null);
        const archiveSessionIds = Object.values(storage.getState().sessions).flatMap(session => {
            const binding = readTestloopDotsMetadata(session.metadata);
            return binding?.kind === 'dot' && binding.workspaceId === workspaceId && binding.workspaceSessionId === sessionId
                && !(session.active === false && session.metadata?.lifecycleState === 'archived') ? [session.id] : [];
        });
        const batches = archiveSessionIds.length ? Array.from({ length: Math.ceil(archiveSessionIds.length / 50) },
            (_, index) => archiveSessionIds.slice(index * 50, index * 50 + 50)) : [[]];
        const promise = (async () => {
            const deletions = new Map<string, Deletion>();
            for (const batch of batches) {
                const request = { schemaVersion: 1 as const, workspaceId, requestId: randomUUID(),
                    ...(detailDotId ? { action: 'inspect' as const, dotId: detailDotId } : { action: 'list' as const }),
                    ...(batch.length ? { archiveSessionIds: batch } : {}) };
                const received = await readDotsWorkspace(sessionId, request);
                if (!current()) return;
                for (const deletion of received.deletedDots ?? []) deletions.set(deletion.requestId, deletion);
                // Each network page is bounded to 50 proofs; the local view combines verified pages.
                const snapshot = { ...received, ...(deletions.size ? { deletedDots: [...deletions.values()] } : {}) };
                readResults.delete(readKey); readResults.set(readKey, snapshot);
                if (readResults.size > 16) readResults.delete(readResults.keys().next().value!);
                setLive({ key: readKey, snapshot });
            }
        })().catch(() => {
            if (current()) setReadError('暂时无法刷新工作台，当前保留上次读取的内容；请检查连接与宿主版本后重试。');
        }).finally(() => {
            if (current()) { inFlightRead.current = null; setRefreshing(false); }
        });
        inFlightRead.current = { epoch, promise };
        return promise;
    }, [sessionId, workspaceId, detailDotId, readKey, active, validBinding]);

    const submit = React.useCallback(async (request: TestloopDotsRequest): Promise<boolean> => {
        if (!ready || !commandScope || !validBinding() || !active || writing.current?.scope === commandScope
            || pendingId.current && pendingId.current !== request.requestId || request.action === 'list' || request.action === 'inspect') return false;
        const attempt = { scope: commandScope }; writing.current = attempt;
        readAttempt.current++; inFlightRead.current = null; setRefreshing(false); setReadError(null);
        const epoch = generation.current;
        const current = () => mounted.current && generation.current === epoch && currentCommandScope.current === commandScope && validBinding();
        if (request.action === 'delete') requestedDeletions.current.add(request.requestId);
        pendingId.current = request.requestId;
        setPending(previous => ({ request, attempt: (previous?.attempt ?? 0) + 1, timedOut: false }));
        setError(null); setNotice(null);
        let saved = false;
        try {
            await saveDotsWorkspaceCommand(commandScope, request);
            saved = true;
            if (!current()) return true;
            const result = await requestDotsWorkspaceCommand(sessionId, workspaceId, request);
            if (result.status === 'applied' || result.status === 'rejected') {
                // A reply still belongs to this encrypted journal after blur/unmount.
                // New credentials or another workspace cannot receive its UI effects.
                await settleDotsWorkspaceCommand(commandScope, request, result);
                if (current()) { await restoreJournal(); void refresh(); }
            } else if (current()) {
                setPending(previous => previous?.request.requestId === request.requestId ? { ...previous, timedOut: true } : previous);
                setError('后台已登记原请求，结果仍在处理中；可沿用原请求核对。');
            }
        } catch {
            if (current()) {
                if (!saved) {
                    pendingId.current = null; setPending(null);
                    setError('本机无法保存操作恢复记录，未发送新操作。请检查存储，或恢复上次请求。');
                    await restoreJournal().catch(() => {});
                } else if (pendingId.current === request.requestId) {
                    setError('请求结果尚未确认，重试会保留原请求编号与内容。');
                    setPending(previous => previous?.request.requestId === request.requestId ? { ...previous, timedOut: true } : previous);
                }
            }
        } finally { if (writing.current === attempt) writing.current = null; }
        return saved;
    }, [ready, commandScope, sessionId, workspaceId, validBinding, active, restoreJournal, refresh]);

    React.useEffect(() => {
        if (!ready || !active || initialized.current) return;
        initialized.current = true;
        void refresh();
    }, [ready, active, refresh]);
    React.useEffect(() => {
        if (!ready || !active || journal?.scope !== commandScope) return;
        const request = journal.state?.result ? null : journal.state?.command;
        if (request && pendingId.current !== request.requestId) {
            if (request.action === 'delete') requestedDeletions.current.add(request.requestId);
            pendingId.current = request.requestId;
            setPending({ request, attempt: 0, timedOut: true });
            setError('上次请求尚无处理回执，可以重试同一请求核对结果。');
        }
    }, [ready, active, journal, commandScope]);
    React.useEffect(() => {
        if (!ready || !active || !isLoaded || recovered.current || !commandScope) return;
        recovered.current = true;
        const request = history.pendingRequest;
        if (request && request.action !== 'list' && request.action !== 'inspect' && !pendingId.current
            && !(journal?.scope === commandScope && journal.state?.result && journal.state.command.requestId === request.requestId)) {
            if (request.action === 'delete') requestedDeletions.current.add(request.requestId);
            pendingId.current = request.requestId;
            setPending({ request, attempt: 0, timedOut: true });
            setError('上次请求尚无处理回执，可以重试同一请求核对结果。');
            void saveDotsWorkspaceCommand(commandScope, request).catch(() => {
                if (mounted.current && validBinding()) setError('旧请求恢复记录尚未保存在本机，请检查设备存储后重试。');
            });
        }
    }, [ready, active, isLoaded, history.pendingRequest, commandScope, journal, validBinding]);

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

        const archiveKey = JSON.stringify([server, token, secret, sessionId, workspaceId, deletion.id]);
        let attempt = archiveAttempts.get(archiveKey);
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
            archiveAttempts.set(archiveKey, attempt);
            const running = attempt;
            running.then(() => {
                if (archiveAttempts.get(archiveKey) === running) archiveAttempts.delete(archiveKey);
            }, () => {
                if (archiveAttempts.get(archiveKey) === running) archiveAttempts.delete(archiveKey);
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
            if (mounted.current && validBinding()) setArchivePendingIds(previous => previous.filter(id => id !== deletion.id));
        }
    }, [sessionId, workspaceId, validBinding, server, token, secret]);

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
        if (commandScope && request.action !== 'list' && request.action !== 'inspect'
            && !(journal?.scope === commandScope && journal.state?.result && journal.state.command.requestId === request.requestId)) {
            const key = JSON.stringify([server, token, secret, sessionId, workspaceId, request.requestId]);
            if (!savingReceipts.current.has(key)) {
                savingReceipts.current.add(key);
                void settleDotsWorkspaceCommand(commandScope, request, { schemaVersion: 1, workspaceId, requestId: request.requestId,
                    status: receipt.ok ? 'applied' : 'rejected', error: receipt.ok ? null : receipt.error ?? 'dots_command_rejected', snapshot: receipt,
                }).catch(() => {
                    if (!mounted.current || !validBinding()) return;
                    setError('后台回执已收到，但本机恢复记录未能更新；请检查设备存储并保留原请求。');
                    setPending(previous => previous?.request.requestId === request.requestId && !previous.timedOut ? { ...previous, timedOut: true } : previous);
                }).finally(() => savingReceipts.current.delete(key));
            }
            return;
        }
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
                        if (!validBinding()) return;
                        const current = latestProjection.current.snapshot;
                        const currentDot = current?.ok ? current.dots.find(item => item.id === dot.id) : undefined;
                        if (!currentDot || currentDot.sessionId !== dot.sessionId || currentDot.name !== dot.name
                            || currentDot.instruction !== dot.instruction) return;
                        const binding = readTestloopDotsMetadata(storage.getState().sessions[dot.sessionId]?.metadata);
                        if (binding?.kind !== 'dot' || binding.dotId !== dot.id || binding.workspaceId !== workspaceId
                            || binding.workspaceSessionId !== sessionId) throw new Error('dot_binding_changed');
                        return sessionUpdateDotIdentity(dot.sessionId, dot.name, dot.instruction);
                    })
                    .catch(error => console.error(`Failed to sync Dot identity for session ${dot.sessionId}`, error));
            }
        }
    }, [raw.receipts, raw.snapshot, pending, ready, confirmedDeletions, sessionId, workspaceId, commandScope, journal, server, token, secret, validBinding]);
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

    return { ready, projection: ready ? raw : null, pending: ready ? pending : null, refreshing: ready && refreshing, error: error ?? (ready ? readError : null), notice: ready ? notice : null,
        archiveError: ready ? Object.values(archiveErrors)[0] ?? null : null,
        archivePending: ready && archivePendingIds.length > 0,
        submit, refresh, retryArchive,
        retry: () => !ready ? setReload(value => value + 1) : pending ? submit(pending.request) : refresh() };
}
