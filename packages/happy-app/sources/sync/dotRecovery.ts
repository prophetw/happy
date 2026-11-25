import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';

const messages: Record<string, string> = {
    dot_recovery_auth_required: '登录已失效，请重新登录后恢复。',
    dot_recovery_account_denied: '当前账号无权恢复这个 Dot。',
    dot_recovery_binding_changed: 'Dot 的会话或归属已变化，请返回工作台刷新。',
    dot_recovery_runtime_blocked: 'Dot 存在待核对的运行状态，无法自动恢复。请在活动页查看原因。',
    dot_recovery_pending_delivery_queue_full: '待投递队列已满，请先排空',
    dot_recovery_relay_unavailable: '无法连接消息服务，请稍后重试。',
    dot_recovery_host_not_running: 'Dot 宿主尚未运行，请先恢复宿主。',
    hosted_restart_unsupported: '这台宿主的 Dot 运行时尚未支持单独重启。',
    hosted_restart_thread_unavailable: '这条线程还没有可恢复的聊天记录。完成一次对话后即可重启。',
    hosted_restart_runtime_unavailable: '这个 Dot 尚未就绪，请稍后核对。',
    hosted_restart_runtime_blocked: 'Dot 的运行状态待核对，请在活动页查看原因。',
    hosted_lifecycle_control_pending: '这个 Dot 已有待处理的生命周期操作。',
    hosted_lifecycle_clear_pending: '这条会话正在清空或切换，请返回工作台刷新。',
    hosted_lifecycle_deleted: '这个 Dot 已停用，请返回工作台刷新。',
};

type Binding = { workspaceId: string; dotId: string; sessionId: string };
type RestartStatus = 'waiting' | 'restarting' | 'ready';

/** Uses the selected Relay's authenticated host endpoint, never an executable or path from session metadata. */
async function postRecovery(input: Binding | (Binding & { action: 'restart'; requestId: string }), signal?: AbortSignal) {
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) throw new Error(messages.dot_recovery_auth_required);
    let response: Response;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        response = await fetch(getServerUrl().replace(/\/+$/, '') + '/v1/dots/recover', {
            method: 'POST', headers: { Authorization: 'Bearer ' + credentials.token, 'Content-Type': 'application/json' },
            body: JSON.stringify(input), signal: controller.signal,
        });
    } catch { throw new Error('无法连接恢复服务，请确认宿主电脑已开机并连接网络，然后重试。'); }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
    const result = await response.json().catch(() => ({}));
    if (response.status === 404) throw new Error('这台宿主尚未配置一键恢复服务。');
    if (!response.ok) throw new Error(messages[result.error] ?? '宿主未能启动，请稍后重试。');
    return { response, result };
}

export async function recoverDot(input: Binding) {
    const { response, result } = await postRecovery(input);
    if (response.status !== 202 || result.status !== 'starting' || result.sessionId !== input.sessionId)
        throw new Error('恢复服务返回了不匹配的会话，请返回工作台刷新。');
}

export async function restartDot(input: Binding & { requestId: string }, signal: AbortSignal): Promise<RestartStatus> {
    const { response, result } = await postRecovery({ ...input, action: 'restart' }, signal);
    if (response.status !== 202 || result.sessionId !== input.sessionId || result.requestId !== input.requestId
        || !['waiting', 'restarting', 'ready'].includes(result.status))
        throw new Error('宿主未返回匹配的重启状态，请核对原请求。');
    return result.status;
}
