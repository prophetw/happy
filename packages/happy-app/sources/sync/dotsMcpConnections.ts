import { z } from 'zod';
import { apiSocket } from './apiSocket';

const config = z.record(z.string(), z.unknown());
export const DotsMcpViewSchema = z.object({ revision: z.number().int().nonnegative(), capabilities: z.object({ storedToken: z.literal(1), happyDelegation: z.literal(1).optional(), migrateRest: z.literal(1).optional() }).optional(),
    connections: z.array(z.object({ id: z.string(), name: z.string(), config, enabled: z.boolean(),
        tokenConfigured: z.boolean().optional(), credentialSource: z.enum(['stored', 'environment', 'none']).optional(),
        checkedAt: z.string().nullable(), error: z.string().nullable(),
        control: z.object({ grantID: z.string(), machineID: z.string(), projects: z.array(z.object({ id: z.string(), directory: z.string() })),
            methods: z.array(z.string()), expiresAt: z.number() }).optional(),
        tools: z.array(z.object({ name: z.string(), description: z.string() })) })),
    dots: z.array(z.object({ id: z.string(), name: z.string(), connectionIDs: z.array(z.string()), projectBindings: z.record(z.string(), z.array(z.string())).optional() })),
});
export type DotsMcpView = z.infer<typeof DotsMcpViewSchema>;
export type DotsMcpMutation = { action: 'save'; connectionID?: string; name: string; config: Record<string, unknown>; token?: string | null }
    | { action: 'bind'; dotId: string; connectionIDs: string[] }
    | { action: 'bind-projects'; dotId: string; connectionID: string; projectIDs: string[] }
    | { action: 'migrate-rest'; connectionID: string; restRevision: number }
    | { action: 'check' | 'delete'; connectionID: string }
    | { action: 'enable'; connectionID: string; enabled: boolean };
export async function requestDotsMcp(sessionId: string, request: { action: 'list' } | DotsMcpMutation & { revision: number; requestId: string }) {
    let reply: unknown;
    try { reply = await apiSocket.sessionRPC(sessionId, 'testloop-mcp-connections', request); }
    catch { throw new Error('mcp_transport_unconfirmed'); }
    const envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: DotsMcpViewSchema }),
        z.object({ ok: z.literal(false), error: z.string() })]).safeParse(reply);
    if (!envelope.success) throw new Error('mcp_response_unconfirmed');
    if (!envelope.data.ok) throw new Error(envelope.data.error);
    return envelope.data.data;
}
export function dotsMcpError(error: unknown) {
    const code = error instanceof Error ? error.message : '';
    return ({ mcp_revision_changed: '配置已变化，请刷新后重试。', mcp_environment_missing: '宿主缺少配置中引用的环境变量，请先配置并重启宿主。',
        mcp_connection_failed: 'MCP 连接或工具发现失败，请检查服务地址、启动命令、认证和网络。',
        mcp_tool_unavailable: '工具白名单含有服务未提供的工具，请检查 enabled_tools。',
        mcp_invalid_request: 'MCP 配置格式不正确，请核对字段。', mcp_catalog_limit: '工具目录超出上限（128 个）。',
        mcp_transport_unconfirmed: '未收到操作结果，请刷新核对，不会自动重发。',
        mcp_response_unconfirmed: '无法确认操作结果，请刷新核对。',
        mcp_credential_unavailable: '已保存的 Token 无法读取，请重新填写并保存。',
        mcp_token_endpoint_changed: '服务地址已变化，请重新填写 Token，或勾选清除已保存 Token。',
        mcp_token_http_only: 'Token 输入框用于 HTTP 服务；stdio 服务请使用高级配置。',
        mcp_control_scope_unavailable: '无法通过 MCP 核验 Happy 授权。请检查 Token、授权有效期及 Happy 服务版本。',
        mcp_control_credential_required: 'Happy 项目执行需要有效的服务 Token。',
        mcp_legacy_connection_unavailable: '旧连接不可迁移，请刷新状态；已过期的授权请在 MCP 中添加新 Token。',
        mcp_scope_denied: '项目选择超出当前连接授权范围，请刷新后重试。',
        mcp_project_limit: '每个 Dot 最多启用 16 个后台执行项目，请先取消其他项目。',
    } as Record<string, string>)[code] ?? 'MCP 操作未完成，请刷新核对后重试。';
}
