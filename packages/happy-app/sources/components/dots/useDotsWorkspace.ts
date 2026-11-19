import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@/auth/AuthContext';
import { useSessionVisibility } from '@/hooks/useSessionVisibility';
import { storage, useRealtimeStatus, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionArchiveTestloopDot, sessionUpdateDotIdentity } from '@/sync/ops';
import { readDotsWorkspace } from '@/sync/dotsWorkspaceRead';
import { isTerminalDotsWorkspaceResult, loadDotsWorkspaceCommandStates, readDotsWorkspaceCommandReceipt, requestDotsWorkspaceCommand,
    saveDotsWorkspaceCommand, settleDotsWorkspaceCommand, subscribeDotsWorkspaceCommand, type DotsWorkspaceCommandState } from '@/sync/dotsWorkspaceCommand';
import { getServerUrl } from '@/sync/serverConfig';
import { dotsWorkspaceCommandTarget, retiredDotSessionIds, projectTestloopDotsMessages, readTestloopDotsMetadata,
    mergeDotsWorkspaceRead, mergeDotsWorkspaceReceipt, type TestloopDotsSnapshot, type DotsWorkspaceCommand } from '@/sync/testloopDots';

type ReceiptCheck = { checking: boolean; message: string };
type CommandFeedback = { target: string | undefined; error?: string; notice?: string };
type Deletion = { requestId: string; revision: number; id: string; sessionId: string };
const emptyJournal: DotsWorkspaceCommandState[] = [];
const receiptCheckInterval = 5000;

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
    const [journal, setJournal] = React.useState<{ scope: typeof commandScope; states: DotsWorkspaceCommandState[] } | null>(null);
    const states = journal && journal.scope === commandScope ? journal.states : emptyJournal;
    const journalRead = React.useRef(0);
    const [live, setLive] = React.useState<{ key: string; snapshot: TestloopDotsSnapshot } | null>(null);
    const raw = React.useMemo(() => {
        const read = mergeDotsWorkspaceRead(history, live?.key === readKey ? live.snapshot : readResults.get(readKey));
        return states.reduce((projection, { command, result }) => {
            if (!result) return projection;
            const receipt = result.snapshot ?? { schemaVersion: 1 as const, workspaceId, requestId: command.requestId,
                revision: projection.snapshot?.revision ?? 0, ok: false, error: result.error ?? undefined, dots: projection.snapshot?.dots ?? [] };
            return mergeDotsWorkspaceReceipt(projection, command, receipt);
        }, read);
    }, [history, live, readKey, states, workspaceId]);
    const [refreshing, setRefreshing] = React.useState(false);
    const [readError, setReadError] = React.useState<string | null>(null);
    const inFlightRead = React.useRef<{ epoch: number; promise: Promise<void> } | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [checks, setChecks] = React.useState<Record<string, ReceiptCheck>>({});
    const [archiveErrors, setArchiveErrors] = React.useState<Record<string, string>>({});
    const [archivePendingIds, setArchivePendingIds] = React.useState<string[]>([]);
    const generation = React.useRef(0), recovered = React.useRef(false), mounted = React.useRef(true);
    const receiptChecks = React.useMemo(() => new Map<string, Promise<void>>(), [scope]);
    // Feedback is for operations observed by this view. Historical receipts still update the directory.
    const observed = React.useMemo(() => new Set<string>(), [scope]);
    const mirroredUpdates = React.useMemo(() => new Set<string>(), [scope]);
    const latestProjection = React.useRef(raw);
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
        const loaded = await loadDotsWorkspaceCommandStates(commandScope);
        if (version === journalRead.current && mounted.current && validBinding()) setJournal({ scope: commandScope, states: loaded });
    }, [commandScope, validBinding]);
    React.useEffect(() => commandScope ? subscribeDotsWorkspaceCommand(commandScope, () => {
        void restoreJournal().catch(() => {
            if (mounted.current && validBinding()) setError('本机操作恢复记录无法读取，请检查设备存储后重试。');
        });
    }) : undefined, [commandScope, restoreJournal, validBinding]);

    useFocusEffect(React.useCallback(() => {
        const epoch = ++generation.current;
        recovered.current = false;
        inFlightRead.current = null; setRefreshing(false); setReadError(null);
        setReadyScope(null); setChecks({}); setError(null); setArchiveErrors({});
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
    const refreshDirectory = React.useCallback((): Promise<void> => {
        if (!validBinding() || !active) return Promise.resolve();
        const epoch = generation.current;
        if (inFlightRead.current?.epoch === epoch) return inFlightRead.current.promise;
        const current = () => mounted.current && generation.current === epoch && validBinding();
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

    const checkCommand = React.useCallback((command: DotsWorkspaceCommand): Promise<void> => {
        if (!commandScope || !validBinding()) return Promise.resolve();
        const { requestId } = command;
        const existing = receiptChecks.get(requestId);
        if (existing) return existing;
        const epoch = generation.current;
        const report = (message: string, checking = false) => {
            if (mounted.current && generation.current === epoch && validBinding())
                setChecks(previous => ({ ...previous, [requestId]: { checking, message } }));
        };
        report('正在核对原请求回执…', true);
        const attempt = (async () => {
            try {
                const result = await readDotsWorkspaceCommandReceipt(sessionId, workspaceId, command);
                if (!validBinding()) return;
                if (isTerminalDotsWorkspaceResult(result)) {
                    await settleDotsWorkspaceCommand(commandScope, command, result);
                    if (mounted.current && generation.current === epoch && validBinding()) void refreshDirectory();
                } else {
                    report(result.status === 'unknown' ? '宿主尚未找到原请求，已保留请求编号。'
                        : '宿主已登记原请求，仍在处理中。');
                }
            } catch {
                report('暂时无法核对回执，已保留原请求。可检查连接与宿主版本后再核对。');
            } finally {
                receiptChecks.delete(requestId);
            }
        })();
        receiptChecks.set(requestId, attempt);
        return attempt;
    }, [commandScope, validBinding, sessionId, workspaceId, receiptChecks, refreshDirectory]);

    const waiting = React.useMemo(() => states.filter(state => !state.result).map(state => state.command), [states]);
    const latestWaiting = React.useRef(waiting);
    latestWaiting.current = waiting;
    const checkPending = React.useCallback(async () => {
        await Promise.all(latestWaiting.current.map(checkCommand));
    }, [checkCommand]);
    const checkReceipt = (requestId: string) => {
        const command = latestWaiting.current.find(item => item.requestId === requestId);
        return command ? checkCommand(command) : Promise.resolve();
    };

    const submit = React.useCallback(async (request: DotsWorkspaceCommand): Promise<boolean> => {
        if (!ready || !commandScope || !validBinding() || !active) return false;
        const epoch = generation.current;
        const current = () => mounted.current && generation.current === epoch && validBinding();
        if (current()) setError(null);
        try {
            if (!await saveDotsWorkspaceCommand(commandScope, request)) return false;
        } catch (cause) {
            if (current()) {
                setError(cause instanceof Error && cause.message === 'dots_command_pending'
                    ? '这个目标已有待核对的操作，请先核对原请求。'
                    : '本机无法保存操作恢复记录，未发送新操作。请检查设备存储后重试。');
            }
            return false;
        }
        observed.add(request.requestId);
        if (!validBinding()) return true;
        try {
            const result = await requestDotsWorkspaceCommand(sessionId, workspaceId, request);
            if (!validBinding()) return true;
            if (isTerminalDotsWorkspaceResult(result)) {
                await settleDotsWorkspaceCommand(commandScope, request, result);
                if (current()) void refreshDirectory();
                return true;
            }
        } catch {
            // A transport failure leaves the original request journaled.
        }
        if (current()) void checkCommand(request);
        return true;
    }, [ready, commandScope, validBinding, active, observed, sessionId, workspaceId, refreshDirectory, checkCommand]);

    React.useEffect(() => {
        if (ready && active) void refreshDirectory();
    }, [ready, active, refreshDirectory]);

    const hasPending = waiting.length > 0;
    useFocusEffect(React.useCallback(() => {
        if (ready && active && realtime === 'connected') void checkPending();
    }, [ready, active, realtime, checkPending]));
    useFocusEffect(React.useCallback(() => {
        if (!ready || !active || !hasPending || realtime !== 'connected') return;
        const timer = setInterval(() => void checkPending(), receiptCheckInterval);
        return () => clearInterval(timer);
    }, [ready, active, hasPending, realtime, checkPending]));

    React.useEffect(() => {
        if (!ready || !active || !isLoaded || recovered.current || !commandScope) return;
        recovered.current = true;
        const occupied = new Set(states.map(state => dotsWorkspaceCommandTarget(state.command)));
        // Legacy chat commands are already sent. Recover the latest unanswered intent per target.
        for (const request of [...history.pendingRequests].reverse()) {
            const target = dotsWorkspaceCommandTarget(request);
            if (occupied.has(target)) continue;
            occupied.add(target);
            void saveDotsWorkspaceCommand(commandScope, request).then(saved => {
                if (saved) void checkCommand(request);
            }).catch(() => {
                if (mounted.current && validBinding()) setError('旧请求恢复记录尚未保存在本机，请检查设备存储后重试。');
            });
        }
    }, [ready, active, isLoaded, history.pendingRequests, commandScope, states, validBinding, checkCommand]);

    React.useEffect(() => {
        if (!ready || !active) return;
        for (const request of waiting) {
            if (!detailDotId || dotsWorkspaceCommandTarget(request) === detailDotId) observed.add(request.requestId);
        }
    }, [ready, active, waiting, detailDotId, observed]);

    const confirmedDeletions = React.useMemo(() => confirmedDeletionsOf(raw), [raw]);

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
        if (!ready || !active) return;
        for (const { command, result } of states) {
            if (command.action !== 'update' || result?.status !== 'applied'
                || !observed.has(command.requestId) || mirroredUpdates.has(command.requestId)) continue;
            mirroredUpdates.add(command.requestId);
            const dot = result.snapshot?.dots.find(item => item.id === command.dotId);
            if (!dot || dot.name !== command.name || dot.instruction !== command.instruction) continue;
            void sync.ensureSessionReady(dot.sessionId).then(() => {
                if (!validBinding()) return;
                const current = latestProjection.current.snapshot;
                const currentDot = current?.ok ? current.dots.find(item => item.id === dot.id) : undefined;
                if (!currentDot || currentDot.sessionId !== dot.sessionId || currentDot.name !== dot.name
                    || currentDot.instruction !== dot.instruction) return;
                const binding = readTestloopDotsMetadata(storage.getState().sessions[dot.sessionId]?.metadata);
                if (binding?.kind !== 'dot' || binding.dotId !== dot.id || binding.workspaceId !== workspaceId
                    || binding.workspaceSessionId !== sessionId) throw new Error('dot_binding_changed');
                return sessionUpdateDotIdentity(dot.sessionId, dot.name, dot.instruction);
            }).catch(error => console.error(`Failed to sync Dot identity for session ${dot.sessionId}`, error));
        }
    }, [active, ready, states, observed, mirroredUpdates, validBinding, sessionId, workspaceId]);

    const visible = (command: DotsWorkspaceCommand) => !detailDotId || dotsWorkspaceCommandTarget(command) === detailDotId;
    const pendingCommands = ready ? waiting.filter(visible).map(request => ({
        request, checking: checks[request.requestId]?.checking ?? false,
        message: checks[request.requestId]?.message ?? '正在等待后台回执，可核对原请求。',
    })) : [];
    const pendingFor = (dotId?: string) => pendingCommands.find(({ request }) => dotsWorkspaceCommandTarget(request) === dotId);

    const feedback = ready ? states.flatMap<CommandFeedback>(({ command, result }) => {
        if (!result || !visible(command) || !observed.has(command.requestId)) return [];
        const target = dotsWorkspaceCommandTarget(command);
        if (result.status === 'rejected') return [{ target, error: `后台未接受本次操作（${result.error}）。` }];
        if (command.action === 'delete') {
            return confirmedDeletions.some(deletion => deletion.requestId === command.requestId)
                ? [{ target, notice: '已删除 Dot，历史对话与记录已保留。' }]
                : [{ target, error: '后台已接受删除，正在等待最新列表确认目标已消失。' }];
        }
        if (command.action === 'clear') {
            const receiptDot = result.snapshot?.dots.find(dot => dot.id === command.dotId);
            const currentDot = raw.snapshot?.ok ? raw.snapshot.dots.find(dot => dot.id === command.dotId) : undefined;
            return receiptDot && currentDot?.sessionId === receiptDot.sessionId
                ? [{ target, notice: '已清空旧聊天并重置模型上下文；长期记忆、Dot 身份、模型设置、授权和独立任务保留。' }]
                : [{ target, error: '后台已接受清空，但最新列表尚未确认原 Dot 与会话仍存在，请刷新核对。' }];
        }
        return [{ target, notice: command.action === 'create' ? `已创建「${command.name}」。` : `已更新「${command.name}」。` }];
    }) : [];
    const workspaceError = error ?? (ready ? readError : null);
    const errorFor = (dotId?: string) => feedback.find(result => result.target === dotId)?.error ?? workspaceError;
    const refresh = () => {
        if (!ready) {
            setReload(value => value + 1);
            return Promise.resolve();
        }
        return Promise.all([refreshDirectory(), checkPending()]).then(() => {});
    };
    return {
        ready, projection: ready ? raw : null, pendingCommands, pendingFor, refreshing: ready && refreshing,
        error: feedback.findLast(result => result.error)?.error ?? workspaceError, errorFor,
        notice: feedback.findLast(result => result.notice)?.notice ?? null,
        archiveError: ready ? Object.values(archiveErrors)[0] ?? null : null,
        archivePending: ready && archivePendingIds.length > 0,
        submit, refresh, checkReceipt, retryArchive,
    };
}
