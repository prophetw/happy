import { z } from 'zod';
import { apiSocket } from './apiSocket';

const project = z.object({ id: z.string(), directory: z.string() });
export const DotsConnectionsViewSchema = z.object({ revision: z.number().int().nonnegative(),
    connections: z.array(z.object({ id: z.string(), name: z.string(), endpoint: z.string(), grantID: z.string(), machineID: z.string(),
        projects: z.array(project), methods: z.array(z.string()), expiresAt: z.number().nullable(), enabled: z.boolean(),
        source: z.enum(['existing', 'configured']), checkedAt: z.string().nullable(), error: z.string().nullable(),
        credentialSource: z.enum(['environment', 'stored']), credentialConfigured: z.boolean(),
        status: z.enum(['disabled', 'expired', 'error', 'verified', 'unverified']) })).max(32),
    dots: z.array(z.object({ id: z.string().uuid(), name: z.string(), source: z.enum(['existing', 'explicit']),
        bindings: z.array(z.object({ connectionID: z.string(), projectIDs: z.array(z.string()) })) })).max(9),
});
export type DotsConnectionsView = z.infer<typeof DotsConnectionsViewSchema>;
export type DotsConnectionBinding = DotsConnectionsView['dots'][number]['bindings'];
type Mutation = { requestId: string; revision: number };
export type DotsConnectionRequest = { action: 'list' }
    | Mutation & ({ action: 'add'; name: string; endpoint: string; token: string }
        | { action: 'check'; connectionID: string }
        | { action: 'enable'; connectionID: string; enabled: boolean }
        | { action: 'bind'; dotId: string; bindings: DotsConnectionBinding });

export async function requestDotsConnections(sessionId: string, request: DotsConnectionRequest): Promise<DotsConnectionsView> {
    const reply = await apiSocket.sessionRPC<unknown, DotsConnectionRequest>(sessionId, 'testloop-rest-connections', request);
    const envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: DotsConnectionsViewSchema }),
        z.object({ ok: z.literal(false), error: z.string().regex(/^rest_[a-z_]+$/) })]).parse(reply);
    if (!envelope.ok) throw new Error(envelope.error);
    return envelope.data;
}

export function dotsConnectionError(error: unknown): string {
    const code = error instanceof Error ? error.message : '';
    const messages: Record<string, string> = {
        rest_revision_changed: '配置已变化，请刷新后重新选择。',
        rest_credential_unavailable: '服务令牌缺失或格式不正确，请检查后重新填写。',
        rest_credential_rejected: '服务令牌被拒绝，请检查是否已失效。',
        rest_grant_unavailable: '授权不可用，可能已到期或撤销，请在 Happy 中核对。',
        rest_connection_unavailable: '暂时无法连接 REST 服务，请检查地址和网络。',
        rest_connection_already_exists: '这份授权已经配置，请在列表中查看。',
        rest_scope_changed: '远端授权范围已变化，连接已阻止派工，请重新配置连接。',
        rest_scope_denied: '所选项目不在这份连接的授权范围内。',
        rest_project_limit: '每个 Dot 最多选择 16 个项目。',
        rest_connection_limit: '最多配置 32 个连接。',
    };
    return messages[code] ?? '未确认操作结果。请刷新核对；若宿主尚未提供连接管理，请先更新宿主。';
}
