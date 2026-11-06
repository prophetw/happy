/** Headless Happy host: one Relay consumer, native thread, and durable delivery journal. */
import { mkdirSync, existsSync, openSync, closeSync, lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { CodexAppServerClient } from './codexAppServerClient';
import { HostedDotRelay } from './hostedDotRelay';
import { HostedDotConfig, loadHostedState, readPrivate, savePrivate, addOutput } from './hostedDotState';
import type { ThreadTurn } from './codexAppServerTypes';
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const disabled = ['shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'shell_snapshot_v2', 'apps', 'plugins', 'hooks',
    'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use', 'image_generation',
    'view_image', 'multi_agent', 'multi_agent_v2', 'goals', 'sleep_tool', 'memories', 'skill_search', 'skill_mcp_dependency_install',
    'code_mode', 'code_mode_only', 'code_mode_only_strict_3p_tools', 'code_mode_tool_search', 'code_mode_prewarm', 'code_mode_host_grpc',
    'auth_elicitation', 'request_permissions_tool', 'default_mode_request_user_input', 'daemon_auto_start', 'remote_plugin', 'workspace_dependencies', 'tool_suggest'];
export async function runHostedDot(raw: unknown, signal?: AbortSignal): Promise<void> {
    const config = HostedDotConfig.parse(raw), dir = config.directory;
    for (const path of [dir, config.codexHome]) {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        if (lstatSync(path).isSymbolicLink()) throw new Error('hosted_directory_symlink');
    }
    const fd = openSync(join(dir, 'runtime.lock'), 'a', 0o600);
    if (spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] }).status !== 0) {
        closeSync(fd); throw new Error('hosted_already_running');
    }
    let client: CodexAppServerClient | undefined, relay: HostedDotRelay | undefined;
    let stop = false, active: Promise<void> | undefined, eventError = false, transportLost = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const terminalTurns = new Map<string, 'completed' | 'failed' | 'interrupted'>();
    const onStop = () => { stop = true; };
    process.on('SIGTERM', onStop); process.on('SIGINT', onStop); signal?.addEventListener('abort', onStop);
    const file = join(dir, 'state.json');
    let state: ReturnType<typeof loadHostedState>;
    try { state = loadHostedState(file, config); } catch (error) { closeSync(fd); process.off('SIGTERM', onStop); process.off('SIGINT', onStop); signal?.removeEventListener('abort', onStop); throw error; }
    const persist = () => savePrivate(file, state);
    const text = (turn: string, item: string, value: string, partial: boolean) => {
        const prefix = `${state.threadId}:${turn}:${item}:`;
        const prior = state.outputs.filter(o => o.localId.startsWith(`hosted:${state.epoch}:${prefix}`))
            .map(o => (o.envelope as SessionEnvelope).ev).filter(e => e.t === 'text' && !e.textSnapshot).map(e => (e as { text: string }).text).join('');
        const full = partial ? prior + value : value;
        if (!full.startsWith(prior)) throw new Error('hosted_output_history_conflict');
        if (full.length > prior.length) addOutput(state, createEnvelope('agent', { t: 'text', text: full.slice(prior.length), textOffset: prior.length },
            { id: prefix + prior.length, turn, codexItemId: `${state.threadId}:${item}` }));
        if (!partial) addOutput(state, createEnvelope('agent', { t: 'text', text: value, textOffset: 0, textSnapshot: true },
            { id: prefix + 'snapshot', turn, codexItemId: `${state.threadId}:${item}` }));
    };
    const endTurn = (turn: string, status: 'completed' | 'failed' | 'interrupted') => addOutput(state, createEnvelope('agent',
        { t: 'turn-end', status: status === 'interrupted' ? 'cancelled' : status }, { id: `${state.threadId}:${turn}:end`, turn }));
    const reconcile = (turns: ThreadTurn[]) => {
        for (const row of state.inputs.filter(r => ['dispatching', 'accepted', 'unknown'].includes(r.status))) {
            const matching = row.turnId ? turns.filter(t => t.id === row.turnId && (row.status === 'accepted' || t.items?.some((i: any) => i.type === 'userMessage' && i.content?.some((p: any) => p.type === 'text' && p.text === row.text)))) : turns.filter(t => !row.beforeTurns?.includes(t.id)
                && t.items?.some((i: any) => i.type === 'userMessage' && i.content?.some((p: any) => p.type === 'text' && p.text === row.text)));
            if (matching.length !== 1) { row.status = 'unknown'; continue; }
            const turn = matching[0]; row.turnId = turn.id;
            for (const item of turn.items ?? []) if (item.type === 'agentMessage' && typeof item.text === 'string') text(turn.id, item.id, item.text, false);
            row.status = turn.status === 'completed' ? 'completed' : turn.status === 'failed' ? 'failed' : 'interrupted';
            endTurn(turn.id, row.status);
        }
        if (state.inputs.some(r => r.status === 'unknown')) { state.status = 'blocked'; state.error = 'hosted_input_unconfirmed'; }
        persist();
    };
    try {
        if (existsSync(join(config.codexHome, 'config.toml'))) throw new Error('hosted_requires_isolated_codex_home');
        for (const [name, value] of Object.entries(config.providerConfig)) if (name.endsWith('.base_url')) {
            const url = new URL(String(value));
            if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('hosted_provider_origin_invalid');
        }
        const credentials = readPrivate(realpathSync(join(config.happyHome, 'access.key')));
        const cached = readPrivate(join(config.happyHome, 'sessions.json')).sessions?.[config.sessionId];
        if (!cached || cached.encryptionVariant !== 'dataKey') throw new Error('hosted_session_key_missing');
        const key = Buffer.from(cached.encryptionKey, 'base64');
        if (key.length !== 32 || typeof credentials.token !== 'string') throw new Error('hosted_credentials_invalid');
        if (credentials.serverUrl && credentials.serverUrl.replace(/\/$/, '') !== config.serverUrl.replace(/\/$/, '')) throw new Error('hosted_relay_binding_changed');
        const endpoint = new URL(config.serverUrl);
        if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:'
            && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw new Error('hosted_relay_origin_invalid');
        mkdirSync(join(dir, 'workspace'), { recursive: true, mode: 0o700 });
        const env: Record<string, string> = { CODEX_HOME: config.codexHome };
        for (const name of config.environment) if (process.env[name]) env[name] = process.env[name]!;
        env.CODEX_HOME = config.codexHome;
        for (const name of Object.keys(config.providerConfig)) if (!['name', 'base_url', 'wire_api', 'env_key', 'requires_openai_auth'].some(field => name === `model_providers.${config.provider}.${field}`)) throw new Error('hosted_provider_setting_forbidden');
        const features = Object.fromEntries(disabled.map(name => [name, false])); features.skip_host_skill_discovery = true;
        client = new CodexAppServerClient(undefined, { executable: config.executable, args: config.args,
            cwd: join(dir, 'workspace'), env, onExit: () => { transportLost = true; }, config: { ...config.providerConfig, model_provider: config.provider, features, web_search: 'disabled', mcp_servers: {} },
            instructions: `${config.instruction}\n这是持续对话试验 Dot，目前只支持聊天，没有后台派工、记忆管理、文件或命令执行能力。`,
            onNotification: (method, p) => {
                try {
                    if (p.threadId && p.threadId !== state.threadId) return;
                    if (method === 'turn/started') {
                        const row = state.inputs.find(r => r.status === 'dispatching');
                        if (row) { row.turnId = p.turn.id; row.status = 'accepted'; }
                        addOutput(state, createEnvelope('agent', { t: 'turn-start' }, { id: `${state.threadId}:${p.turn.id}:start`, turn: p.turn.id }));
                    }
                    if (method === 'item/agentMessage/delta') text(p.turnId, p.itemId, p.delta, true);
                    if (method === 'item/completed' && p.item?.type === 'agentMessage') text(p.turnId, p.item.id, p.item.text, false);
                    if (method === 'turn/completed') {
                        const status = p.turn.status === 'completed' ? 'completed' : p.turn.status === 'failed' ? 'failed' : 'interrupted';
                        terminalTurns.set(p.turn.id, status);
                        for (const row of state.inputs.filter(r => r.turnId === p.turn.id && r.status === 'accepted')) {
                            row.status = status;
                            if (p.turn.error) row.error = String(p.turn.error.message ?? p.turn.error.codexErrorInfo ?? 'hosted_model_failed').slice(0, 2000);
                        }
                        endTurn(p.turn.id, status);
                        if (p.turn.error) addOutput(state, createEnvelope('agent', { t: 'service', text: '模型执行失败：' + String(p.turn.error.message ?? p.turn.error.codexErrorInfo ?? '未知错误').slice(0, 1000) + '；没有切换模型或自动重试。' }));
                    }
                    persist();
                } catch { eventError = true; state.status = 'blocked'; state.error = 'hosted_event_persistence_failed'; }
            } });
        client.setApprovalHandler(async () => 'denied');
        client.setEventHandler(event => {
            if (event.type === 'turn_aborted' && event.status === 'failed') {
                transportLost = true;
                for (const row of state.inputs.filter(r => r.status === 'accepted')) { row.status = 'unknown'; row.error = 'hosted_native_transport_lost'; }
                addOutput(state, createEnvelope('agent', { t: 'service', text: 'Codex 执行进程意外退出，正在核对原会话；不会自动重发未确认的输入。' }));
                state.status = 'blocked'; state.error = 'hosted_native_transport_lost'; persist();
            } else if (event.type === 'turn_aborted') {
                for (const row of state.inputs.filter(r => r.status === 'accepted')) { row.status = 'interrupted'; if (row.turnId) { terminalTurns.set(row.turnId, 'interrupted'); endTurn(row.turnId, 'interrupted'); } }
                persist();
            }
        });
        await client.connect();
        const currentThreadHasInput = state.inputs.some(r => r.epoch === state.epoch && r.beforeTurns !== undefined);
        if (state.threadId && currentThreadHasInput) {
            await client.resumeThread({ threadId: state.threadId, cwd: join(dir, 'workspace'), model: config.model, approvalPolicy: 'never', sandbox: 'read-only' });
            reconcile((await client.readThread({ threadId: state.threadId })).thread.turns ?? []);
        } else {
            if (state.creating) throw new Error('hosted_thread_creation_unconfirmed');
            state.creating = true; persist();
            state.threadId = (await client.startThread({ cwd: join(dir, 'workspace'), model: config.model, approvalPolicy: 'never', sandbox: 'read-only' })).threadId;
            state.creating = false; persist();
        }
        relay = new HostedDotRelay({ base: config.serverUrl.replace(/\/$/, ''), token: credentials.token, key, sessionId: config.sessionId, dotId: config.dotId },
            async () => { await client!.abortTurnWithFallback({ gracePeriodMs: 3000, forceRestartOnTimeout: true }); });
        await relay.connect(); await relay.metadata(state.threadId!);
        if (state.status !== 'blocked') { state.status = 'ready'; state.error = null; } persist();
        relay.alive(false); heartbeat = setInterval(() => relay?.alive(Boolean(active)), 2000);
        const flush = async () => {
            for (const o of state.outputs.filter(o => !o.sent)) { await relay!.send(o.localId, o.envelope as SessionEnvelope); o.sent = true; persist(); }
        };
        while (!stop && !signal?.aborted) {
            if (eventError) throw new Error('hosted_event_persistence_failed');
            if (transportLost) {
                if (active) await active;
                transportLost = false;
                if (!await client.reconnectAndResumeThread()) throw new Error('hosted_native_recovery_failed');
                state.status = 'ready'; state.error = null;
                reconcile((await client.readThread({ threadId: state.threadId! })).thread.turns ?? []);
            }
            const controlFile = join(dir, 'control.json');
            if (existsSync(controlFile)) {
                const control = readPrivate(controlFile);
                if (!state.controls.includes(control.id)) {
                    if (!['clear', 'stop', 'delete'].includes(control.action) || typeof control.id !== 'string') throw new Error('hosted_control_invalid');
                    if (active) { await client.abortTurnWithFallback({ gracePeriodMs: 3000, forceRestartOnTimeout: true }); await active; }
                    if (control.action === 'clear') {
                        state.epoch++; state.threadId = null; state.creating = true;
                        for (const row of state.inputs.filter(r => ['queued', 'unknown', 'dispatching', 'accepted'].includes(r.status))) row.status = 'interrupted';
                        persist();
                        state.threadId = (await client.startThread({ cwd: join(dir, 'workspace'), model: config.model, approvalPolicy: 'never', sandbox: 'read-only' })).threadId;
                        state.creating = false; state.error = null; state.status = 'ready'; await relay.metadata(state.threadId);
                    } else stop = true;
                    state.controls.push(control.id); persist();
                }
            }
            if (stop) break;
            try {
                const page = await relay.messages(state.afterSeq);
                for (const message of page.messages) {
                    if (message.seq <= state.afterSeq) throw new Error('hosted_cursor_order_invalid');
                    const body = message.body;
                    if (body.role === 'user' && body.content?.type === 'text' && typeof body.content.text === 'string') {
                        if (body.content.text.length > 12000) {
                            state.inputs.push({ epoch: state.epoch, seq: message.seq, id: message.id, text: body.content.text.slice(0, 12000), delivery: 'queue', status: 'rejected', error: 'hosted_input_limit' });
                            addOutput(state, createEnvelope('agent', { t: 'service', text: '这条消息超过12000字符，请拆分后发送。' }, { id: `input-rejected:${message.seq}` }));
                        } else if (!state.inputs.some(r => r.seq === message.seq)) state.inputs.push({ epoch: state.epoch, seq: message.seq, id: message.id, text: body.content.text, delivery: body.meta?.deliveryMode === 'steer' ? 'steer' : 'queue', status: 'queued' });
                    }
                    state.afterSeq = message.seq; persist();
                }
                if (page.hasMore && !page.messages.length) throw new Error('hosted_cursor_stalled');
                await flush();
                if (active && state.status !== 'blocked') {
                    const row = state.inputs.find(r => r.status === 'queued' && r.delivery === 'steer');
                    const running = state.inputs.find(r => r.status === 'accepted');
                    if (row && running?.turnId) {
                        row.turnId = running.turnId; row.status = 'dispatching'; persist();
                        try {
                            if (await client.steerTurn(row.text)) row.status = terminalTurns.get(row.turnId!) ?? 'accepted';
                            else { row.status = 'queued'; delete row.turnId; }
                        } catch { row.status = 'unknown'; state.status = 'blocked'; state.error = 'hosted_steer_unconfirmed'; }
                        persist();
                    }
                }
                if (!active && state.status !== 'blocked') {
                    const row = state.inputs.find(r => r.status === 'queued');
                    if (row) {
                        row.beforeTurns = state.inputs.filter(r => r.epoch === state.epoch).flatMap(r => r.turnId ? [r.turnId] : []);
                        row.status = 'dispatching'; state.status = 'running'; persist();
                        active = client.sendTurnAndWait(row.text, { model: config.model, sandbox: 'read-only', approvalPolicy: 'never' }).then(() => {
                            if (['dispatching', 'accepted'].includes(row.status)) { row.status = 'unknown'; state.status = 'blocked'; state.error = 'hosted_input_unconfirmed'; }
                        }).catch(() => { row.status = 'unknown'; state.status = 'blocked'; state.error = 'hosted_input_unconfirmed'; })
                            .finally(() => { if (state.status !== 'blocked') state.status = 'ready'; persist(); active = undefined; });
                    }
                }
                relay.alive(Boolean(active));
                if (!page.hasMore) await delay(150);
            } catch (error) {
                state.error = error instanceof Error && /^hosted_[a-z0-9_]+$/.test(error.message) ? error.message : 'hosted_relay_unavailable'; persist();
                await delay(1000);
            }
        }
        if (active) { await client.abortTurnWithFallback({ gracePeriodMs: 3000, forceRestartOnTimeout: true }); await active; }
        await flush(); state.status = 'stopped'; persist();
    } catch (error) {
        state.status = 'blocked'; state.error = error instanceof Error && /^hosted_[a-z0-9_]+$/.test(error.message) ? error.message : 'hosted_start_or_recovery_failed'; persist();
        throw new Error(state.error);
    } finally {
        clearInterval(heartbeat);
        try { relay?.close(); await client?.disconnect(); } finally {
            closeSync(fd); process.off('SIGTERM', onStop); process.off('SIGINT', onStop); signal?.removeEventListener('abort', onStop);
        }
    }
}
export async function main(): Promise<void> {
    if (process.argv.length !== 3) throw new Error('hosted_config_path_required');
    await runHostedDot(readPrivate(process.argv[2]));
}
