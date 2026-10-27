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
2. 若用户没有覆盖某字段，则使用 `codeAgentDefaults` 中的值。Claude 的默认模型为 `default`，表示不传模型覆盖，由宿主机 Claude Code 配置决定。
3. 对于 `permissionMode === 'auto'` 的 Claude/Codex，如果远端 CLI 版本低于 `CLI_VERSION_WITH_AUTO`（`1.2.1-beta.2`），会降级为 `'default'`，避免发送不被旧 CLI 解析的模式导致整条消息被丢弃。
4. 最终配置写入新会话的 `Session.modelMode`、`Session.permissionMode`、`Session.effortLevel`。
5. 发送消息时，`sync.ts` 读取会话上的值并写入 `message.meta.model` / `message.meta.permissionMode`。

### Claude 宿主机模型

Claude 模型选择器使用宿主机配置，移除了固定的 Fable / Opus / Sonnet 型号列表。daemon 在心跳时通过已安装 Claude Agent SDK 的 `resolveSettings` 读取用户设置，将模型目录发布为机器元数据 `claudeModels: { options, currentCode, detectedAt }`。新建会话、首页输入框和 Agent Defaults 使用该目录；切换机器时切换目录。目录未到达时默认跟随 Claude Code，已保存的显式模型覆盖仍可显示。

目录读取 `ANTHROPIC_MODEL`、`model`、`ANTHROPIC_DEFAULT_OPUS_MODEL` / `SONNET_MODEL` / `HAIKU_MODEL`，并遵守 `availableModels` 的限制。使用 `CLAUDE_CONFIG_DIR` 指定的位置；模型别名会使用宿主机的映射，保留配置的上下文后缀。只发布模型字段，不发布 API Key、Token 或服务地址。目录表示本机配置，未调用网关 `/v1/models` 验证可用性。

配置了 `modelPicker`（例如 cc-switch 聚合模式）时，目录还会读取其中的 `options`，保留顺序、`label` 和 `description`，并将原始 `model` 作为选择时发送的模型 ID。`replaceBuiltInOptions: true` 时，使用聚合列表替换原有目录；未设置时追加不重复的条目。条目仍受 `availableModels` 限制；没有可用聚合条目时保留原目录。与 Claude Code 一致，`modelPicker` 仅接受用户、SDK / flag 和 managed 来源，使用最高优先级的整份配置，忽略项目和本地来源；managed 配置优先。Web 默认项继续使用 `default` 表示不覆盖宿主机选择。

会话创建后按工作目录重新读取项目和本地设置，通过会话 `models` 元数据发布，并在 SDK 初始化时更新 `currentModelCode`。默认选项显示配置的实际模型；选择它时新建会话不传 `--model`，已有会话发送 `meta.model = null` 清除覆盖。新建会话时，保存的旧模型若不在该机器目录中，回退到默认配置；已有会话保留显示目录外的当前模型，并允许手动切回默认配置。已有进程需加载新版 CLI 后才能发布目录。

### Codex 宿主机模型

Codex 选择器优先使用所选机器上 `codex app-server` 的 `model/list` 目录。daemon 启动后首次心跳探测，成功后每五分钟刷新；失败后一分钟重试，保留上次成功目录。探测只列模型，不创建线程或执行模型请求，结束后关闭探测进程。目录通过现有加密机器元数据 `codexModels: { options, currentCode, detectedAt }` 同步，不需要修改 Relay API。

读取完整分页，保留 Codex 返回的顺序与显示名称，过滤隐藏模型和重复 ID，同时同步各模型的 `thinkingLevels` 与 `defaultThinkingLevel`。新建会话、首页输入框、Agent Defaults 和已有会话使用该目录；已有会话按 `machineId` 跟随对应机器更新。每个 Codex 会话连接时也发布会话级 `models`，作为机器目录不可用时的数据来源。没有动态目录的旧 CLI 使用原有静态列表；保存的自定义模型仍保留。生效需要 App 和 CLI 均加载新版代码，已有旧会话进程不会自动替换 CLI 代码。

## 关键数据结构

```typescript
export type AgentDefaultConfig = {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
};

const codeAgentDefaults: Record<AgentKey, AgentDefaultConfig> = {
    claude: { permissionMode: 'auto', modelMode: 'default', effortLevel: 'medium' },
    codex:  { permissionMode: 'auto', modelMode: 'gpt-5.6-sol',    effortLevel: 'medium' },
    gemini: { permissionMode: 'default', modelMode: 'gemini-2.5-pro', effortLevel: null },
    openclaw: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
    agy:    { permissionMode: 'default', modelMode: 'Gemini 3.1 Pro (High)', effortLevel: null },
};
```

## 外部依赖或 API

- 依赖 `happy-cli` / 远端 agent 对 `permissionMode` 和 `modelMode` key 的解析能力。
- `CLI_VERSION_WITH_AUTO` 必须与 `happy-cli` 实际支持 `auto` 的版本保持一致。
- 模型 key 必须与宿主机配置或 API 可接受的模型 ID 对齐；Claude 的 `default` 是不覆盖本机模型的特殊值。

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

- **2026-10-22** 补齐 `modelPicker` 目录读取，使 cc-switch 聚合模式的全部模型、名称和描述可同步到 Happy 的机器和会话选择器。
- **2026-10-21** Claude 模型改为跟随宿主机配置，通过机器和会话元数据显示实际模型，默认不覆盖 Claude Code 的模型选择。
- **2026-08-28** 将 Claude 默认模型从 `claude-opus-5` 调整为 `claude-sonnet-5`，以降低默认首 token 延迟和整体生成耗时，同时保留 5 代模型的能力水平。
- **之前** Claude 默认使用 `opus`（Opus 4.8），后随 5 代模型上线改为 `claude-opus-5`。
