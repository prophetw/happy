import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';

const messages: Record<string, string> = {
    dot_recovery_auth_required: '登录已失效，请重新登录后恢复。',
    dot_recovery_account_denied: '当前账号无权恢复这个 Dot。',
    dot_recovery_binding_changed: 'Dot 的会话或归属已变化，请返回工作台刷新。',
    dot_recovery_runtime_blocked: 'Dot 存在待核对的运行状态，无法自动恢复。请在活动页查看原因。',
    dot_recovery_relay_unavailable: '无法连接消息服务，请稍后重试。',
};

/** Uses the selected Relay's authenticated host endpoint, never an executable or path from session metadata. */
export async function recoverDot(input: { workspaceId: string; dotId: string; sessionId: string }) {
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) throw new Error(messages.dot_recovery_auth_required);
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        response = await fetch(getServerUrl().replace(/\/+$/, '') + '/v1/dots/recover', {
            method: 'POST', headers: { Authorization: 'Bearer ' + credentials.token, 'Content-Type': 'application/json' },
            body: JSON.stringify(input), signal: controller.signal,
        });
    } catch { throw new Error('无法连接恢复服务，请确认宿主电脑已开机并连接网络，然后重试。'); }
    finally { clearTimeout(timeout); }
    const result = await response.json().catch(() => ({}));
    if (response.status === 404) throw new Error('这台宿主尚未配置一键恢复服务。');
    if (!response.ok) throw new Error(messages[result.error] ?? '宿主未能启动，请稍后重试。');
    if (response.status !== 202 || result.status !== 'starting' || result.sessionId !== input.sessionId)
        throw new Error('恢复服务返回了不匹配的会话，请返回工作台刷新。');
}
