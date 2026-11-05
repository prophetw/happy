import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@/auth/AuthContext';
import { useSessionVisibility } from '@/hooks/useSessionVisibility';
import { storage, useRealtimeStatus, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { getServerUrl } from '@/sync/serverConfig';
import { projectTestloopDotsMessages, readTestloopDotsMetadata, testloopDotsCommand, type TestloopDotsRequest } from '@/sync/testloopDots';

type Pending = { request: TestloopDotsRequest; attempt: number; timedOut: boolean };

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
    const generation = React.useRef(0), initialized = React.useRef(false), mounted = React.useRef(true);
    const pendingId = React.useRef<string | null>(null);
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
        setReadyScope(null); setPending(null); setError(null); setNotice(null);
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
        pendingId.current = request.requestId;
        setPending(previous => ({ request, attempt: (previous?.attempt ?? 0) + 1, timedOut: false }));
        setError(null); setNotice(null);
        try {
            const accepted = await sync.sendMessage(sessionId, testloopDotsCommand(request), {
                displayText: request.action === 'create' ? `创建 Dot：${request.name}` : request.action === 'inspect' ? '刷新 Dot 工作与记忆' : '刷新 Dots 列表',
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
            pendingId.current = raw.pendingRequest.requestId;
            setPending({ request: raw.pendingRequest, attempt: 0, timedOut: true });
            setError('上次请求尚无处理回执，可以重试同一请求核对结果。');
        } else void refresh();
    }, [ready, active, isLoaded, raw.pendingRequest, refresh]);
    React.useEffect(() => {
        if (!ready || !pending) return;
        const receipt = raw.receipts[pending.request.requestId];
        if (!receipt) return;
        pendingId.current = null; setPending(null);
        if (!receipt.ok) setError(`后台未接受本次操作${receipt.error ? `（${receipt.error}）` : ''}。`);
        else if (pending.request.action === 'inspect' && receipt.workbench?.detail?.dotId !== pending.request.dotId)
            setError('后台未提供对应 Dot 的工作与记忆数据，请核对宿主版本后刷新。');
        else { setError(null); if (pending.request.action === 'create') setNotice(`已创建「${pending.request.name}」。`); }
    }, [raw.receipts, pending, ready]);
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
        submit, refresh, retry: () => !ready ? setReload(value => value + 1) : pending ? submit(pending.request) : refresh() };
}
