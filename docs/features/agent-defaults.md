# Agent Defaults

## 功能目标

集中管理每个 code agent（Claude、Codex、Gemini、OpenClaw、Agy）的默认运行配置，包括：

- `permissionMode`：agent 请求人类确认的方式（如 `auto`、`bypassPermissions`、`default` 等）。
- `modelMode`：默认使用的模型 key（如 `claude-sonnet-5`、`gpt-5.6-sol`）。
- `effortLevel`：默认推理/努力级别（如 `medium`、`high`），仅部分 agent 支持。

这些默认值在新会话创建、会话恢复、以及用户未显式覆盖时生效，确保跨设备、跨版本的一致性。

## 核心入口

- **`packages/happy-app/sources/sync/agentDefaults.ts`**
  - `getCodeAgentDefaults(flavor, cliVersion?)`：返回指定 agent 的 code 默认配置。
  - `resolveAgentDefaultConfig(overrides, flavor, cliVersion?)`：合并用户覆盖后的最终配置。
  - `setAgentDefaultOverride(...)`：用于设置/清除用户覆盖。

- **`packages/happy-app/sources/components/modelModeOptions.ts`**
  - `getDefaultModelKey(flavor)`：代理到 `getCodeAgentDefaults(flavor).modelMode`。
  - `getDefaultPermissionModeKey(flavor)`：代理到 `getCodeAgentDefaults(flavor).permissionMode`。
  - `getDefaultEffortKey(flavor)`：代理到 `getCodeAgentDefaults(flavor).effortLevel`。

## 架构关系

```
┌─────────────────────────┐
│ agentDefaults.ts        │  <- 唯一真实来源（code defaults）
│  - codeAgentDefaults    │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ modelModeOptions.ts     │  <- 对外提供默认 key 查询
│  - getDefaultModelKey   │
│  - getDefaultPermissionModeKey
│  - getDefaultEffortKey  │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ AgentInput / HomeDock   │  <- UI 选择器、新会话向导
│ new session wizard      │
└─────────────────────────┘
```

用户通过 UI 设置的覆盖值持久化在 `LocalSettings.agentDefaultOverrides` 中，由 `persistence.ts` 读写。

## 数据流

1. 新会话创建或 composer 初始化时，调用 `resolveAgentDefaultConfig(state.agentDefaultOverrides, flavor, cliVersion)`。
2. 若用户没有覆盖某字段，则使用 `codeAgentDefaults` 中的值。
3. 对于 `permissionMode === 'auto'` 的 Claude/Codex，如果远端 CLI 版本低于 `CLI_VERSION_WITH_AUTO`（`1.2.1-beta.2`），会降级为 `'default'`，避免发送不被旧 CLI 解析的模式导致整条消息被丢弃。
4. 最终配置写入新会话的 `Session.modelMode`、`Session.permissionMode`、`Session.effortLevel`。
5. 发送消息时，`sync.ts` 读取会话上的值并写入 `message.meta.model` / `message.meta.permissionMode`。

## 关键数据结构

```typescript
export type AgentDefaultConfig = {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
};

const codeAgentDefaults: Record<AgentKey, AgentDefaultConfig> = {
    claude: { permissionMode: 'auto', modelMode: 'claude-sonnet-5', effortLevel: 'medium' },
    codex:  { permissionMode: 'auto', modelMode: 'gpt-5.6-sol',    effortLevel: 'medium' },
    gemini: { permissionMode: 'default', modelMode: 'gemini-2.5-pro', effortLevel: null },
    openclaw: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
    agy:    { permissionMode: 'default', modelMode: 'Gemini 3.1 Pro (High)', effortLevel: null },
};
```

## 外部依赖或 API

- 依赖 `happy-cli` / 远端 agent 对 `permissionMode` 和 `modelMode` key 的解析能力。
- `CLI_VERSION_WITH_AUTO` 必须与 `happy-cli` 实际支持 `auto` 的版本保持一致。
- 模型 key 必须与 CLI 的模型别名表或 API 可接受的模型 ID 对齐（参见 `modelModeOptions.ts` 中的注释）。

## 异常路径

- **远端 CLI 版本未知或不可解析**：`resolveCodeDefaultPermissionMode` 对 `auto` 采取保守策略，降级为 `'default'`，避免消息被旧客户端拒绝。
- **用户保存了已退役的 permission mode**：`retirePermissionMode` 会把旧 key 映射为新 key（例如 `dontAsk` → `acceptEdits`）。
- **用户覆盖值与 code default 相同**：`setAgentDefaultOverride` 会清理掉冗余的覆盖，保持存储最小。

## 测试验证方式

```bash
cd packages/happy-app
pnpm test -- agentDefaults.test.ts
pnpm test -- modelModeOptions.test.ts
```

关键测试覆盖：

- `getCodeAgentDefaults('claude')` 返回 Auto 权限模式。
- 旧版 CLI 自动降级 `auto` → `default`。
- `resolveAgentDefaultConfig` 优先采用用户覆盖。
- `getDefaultModelKey('claude')` 与 `codeAgentDefaults.claude.modelMode` 一致。

## 变更记录

- **2026-08-28** 将 Claude 默认模型从 `claude-opus-5` 调整为 `claude-sonnet-5`，以降低默认首 token 延迟和整体生成耗时，同时保留 5 代模型的能力水平。
- **之前** Claude 默认使用 `opus`（Opus 4.8），后随 5 代模型上线改为 `claude-opus-5`。
