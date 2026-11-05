import { z } from 'zod';
import { apiSocket } from './apiSocket';

const project = z.object({ id: z.string(), directory: z.string() });
export const DotsConnectionsViewSchema = z.object({ revision: z.number().int().nonnegative(),
    capabilities: z.object({ credentialPreview: z.literal(1), replaceAuthorization: z.literal(1) }).optional(),
    connections: z.array(z.object({ id: z.string(), name: z.string(), endpoint: z.string(), grantID: z.string(), machineID: z.string(),
        projects: z.array(project), methods: z.array(z.string()), expiresAt: z.number().nullable(), enabled: z.boolean(),
        source: z.enum(['existing', 'configured']), checkedAt: z.string().nullable(), error: z.string().nullable(),
        credentialSource: z.enum(['environment', 'stored']), credentialConfigured: z.boolean(),
        status: z.enum(['disabled', 'expired', 'error', 'verified', 'unverified']) })).max(32),
    dots: z.array(z.object({ id: z.string().uuid(), name: z.string(), source: z.enum(['existing', 'explicit']),
        bindings: z.array(z.object({ connectionID: z.string(), projectIDs: z.array(z.string()) })) })).max(9),
});
export const DotsConnectionPreviewSchema = z.object({ endpoint: z.string(), grantID: z.string(), machineID: z.string(),
    projects: z.array(project).min(1).max(32), methods: z.array(z.string()), expiresAt: z.number().positive(), digest: z.string() });
export type DotsConnectionsView = z.infer<typeof DotsConnectionsViewSchema>;
export type DotsConnection = DotsConnectionsView['connections'][number];
export type DotsConnectionDot = DotsConnectionsView['dots'][number];
export type DotsConnectionBinding = DotsConnectionDot['bindings'];
export type DotsConnectionPreview = z.infer<typeof DotsConnectionPreviewSchema>;
type Mutation = { requestId: string; revision: number };
type Assignment = { dotId: string; projectIDs: string[] };
export type DotsConnectionRequest = { action: 'list' }
    | Mutation & ({ action: 'add'; name: string; endpoint: string; token: string; previewDigest?: string; assignment?: Assignment }
        | { action: 'replace'; connectionID: string; name: string; token: string; previewDigest: string; assignments: Assignment[] }
        | { action: 'rename'; connectionID: string; name: string }
        | { action: 'check'; connectionID: string }
        | { action: 'enable'; connectionID: string; enabled: boolean }
        | { action: 'bind'; dotId: string; bindings: DotsConnectionBinding });

class DotsConnectionError extends Error { constructor(code: string) { super(code); this.name = 'DotsConnectionError'; } }
async function rpc(sessionId: string, request: unknown): Promise<unknown> {
    let reply: unknown;
    try { reply = await apiSocket.sessionRPC(sessionId, 'testloop-rest-connections', request); }
    catch { throw new DotsConnectionError('rest_transport_unconfirmed'); }
    const envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: z.unknown() }),
        z.object({ ok: z.literal(false), error: z.string().regex(/^rest_[a-z_]+$/) })]).safeParse(reply);
    if (!envelope.success) throw new DotsConnectionError('rest_response_unconfirmed');
    if (!envelope.data.ok) throw new DotsConnectionError(envelope.data.error);
    return envelope.data.data;
}
export async function requestDotsConnections(sessionId: string, request: DotsConnectionRequest): Promise<DotsConnectionsView> {
    const result = DotsConnectionsViewSchema.safeParse(await rpc(sessionId, request));
    if (!result.success) throw new DotsConnectionError('rest_response_unconfirmed');
    return result.data;
}
export async function previewDotsConnection(sessionId: string, endpoint: string, token: string): Promise<DotsConnectionPreview> {
    const result = z.object({ preview: DotsConnectionPreviewSchema }).safeParse(await rpc(sessionId, { action: 'preview', endpoint, token }));
    if (!result.success) throw new DotsConnectionError('rest_response_unconfirmed');
    return result.data.preview;
}
export function dotsProjectName(value: { id: string; directory: string }) {
    return /^dir_[a-f0-9]{32,}$/.test(value.id) ? value.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? value.id : value.id;
}
export const dotsConnectionUsable = (connection: DotsConnection) => connection.enabled && connection.credentialConfigured
    && connection.status !== 'expired' && !connection.error;
export function dotsConnectionStatus(connection: DotsConnection) {
    if (connection.error === 'rest_grant_revoked') return '已撤销';
    if (connection.error === 'rest_grant_expired' || connection.status === 'expired') return '已到期';
    if (!connection.enabled) return '已停用';
    if (connection.error || !connection.credentialConfigured) return '不可用';
    return connection.checkedAt ? '可用' : '待检查';
}
export function dotsConnectionError(error: unknown): string {
    const code = error instanceof Error ? error.message : '';
    const messages: Record<string, string> = {
        rest_revision_changed: '连接或项目选择已被更新，请刷新后重新操作。',
        rest_invalid_endpoint: '服务地址不正确。请填写 HTTPS 域名或以 /happy-control/v1 结尾的地址。',
        rest_invalid_request: '填写内容不完整，请检查连接名称、地址和服务令牌。',
        rest_credential_unavailable: '服务令牌缺失或格式不正确，请重新粘贴完整令牌。',
        rest_credential_rejected: '令牌未通过认证，请检查是否复制完整或已被撤销。',
        rest_grant_revoked: '这份授权已撤销，请使用新的服务令牌。',
        rest_grant_expired: '这份授权已到期，请重新创建授权。',
        rest_grant_not_found: '此服务中找不到这份授权，请检查服务地址。',
        rest_grant_unavailable: '这份授权当前不可用，可能已到期或撤销。',
        rest_connection_unavailable: '暂时无法访问服务，请检查地址和网络后重试。',
        rest_invalid_response: '服务返回的授权信息不完整，本次没有保存，请核对服务地址。',
        rest_connection_already_exists: '这份授权已经保存，请返回选择已有连接。',
        rest_scope_changed: '授权范围发生变化，请重新验证并核对项目后保存。',
        rest_scope_denied: '所选项目不在新授权范围内，原连接选择未改变。',
        rest_binding_changed: '这个 Dot 的当前连接已变化，请返回并重新选择。',
        rest_project_limit: '每个 Dot 最多启用 16 个项目。',
        rest_connection_limit: '最多保存 32 个连接，请先整理已有连接。',
        rest_transport_unconfirmed: '未收到保存结果，请刷新核对。原操作不会自动重发。',
        rest_response_unconfirmed: '无法确认保存结果，请刷新连接列表核对。',
        rest_operation_failed: '连接操作未完成，请刷新核对后重试。',
    };
    return messages[code] ?? '连接操作未完成，请稍后重试。';
}
