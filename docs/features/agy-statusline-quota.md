# Antigravity (agy) StatusLine Hook & Quota Channel

Feature document for Antigravity (`agy`) StatusLine Hook integration and real-time quota telemetry in Happy Agy Adapter.

## 功能目标

将 Happy Agy Adapter 升级为**解耦双通道架构**：
1. **`stream-json` 对话通道**：处理 Agent 对话生命周期，并将原生 `token-count` 事件转换为标准会话用量信封。
2. **`statusLine hook` 配额通道**：接收 Agy 进程下发的 `statusLine.quota` JSON 数据，支持：
   - **Gemini 模型池**：5 小时滚动额度 (5h %) 与每周额度 (Weekly %)，包含精确重置倒计时。
   - **Claude / GPT 模型池**：5 小时滚动额度 (5h %) 与每周额度 (Weekly %)，包含精确重置倒计时。
3. **实时响应与多源回退**：
   - 维护内存级 `AgyQuotaStore`，当 statusLine 数据更新时即时更新。
   - `/usage` 优先查询 Google Cloud Code API (`fetchAvailableModels`)，失败后依次尝试本地 Language Server RPC (`GetUserStatus`) 和 24 小时内的 statusLine 缓存。
   - API / Language Server 的实时结果可补充 statusLine 中的每周额度与账户信息。

## 核心入口

| 组件 | 文件 | 角色 |
|---|---|---|
| StatusLine 解析与配额缓存 | `packages/happy-cli/src/agyStream/statusLine.ts` | 解析 `statusLine.quota` JSON，维护 `AgyQuotaStore` 单例与订阅通知 |
| 配额采集与多源协调 | `packages/happy-cli/src/agyStream/usage.ts` | 统一 `fetchAgyUsage` 优先级调度（API → LS → statusLine），格式化输出 |
| 用量协议桥接 | `packages/happy-cli/src/agyStream/usageBridge.ts` | 生成会话用量信封和 `agentState.usageLimits`，校验上下文快照的会话身份 |
| 会话运行与交互 | `packages/happy-cli/src/agyStream/runStreamJsonAgy.ts` | 订阅配额更新、轮询已有 statusline 文件，拦截 `/usage` 并下发报表 |
| 单元测试 | `packages/happy-cli/src/agyStream/statusLine.test.ts` | 验证多级窗口解析、分组格式、`AgyQuotaStore` 状态机 |

## 架构关系与数据流

```
Agy 常驻进程
    │
    ├── [Channel 1] stream-json (Stdout)
    │     │
    │     └── 正常 Agent 对话
    │           ├── init
    │           ├── step_update (agent_response / tool / reasoning)
    │           └── result (SUCCESS / ERROR)
    │
    └── [Channel 2] statusLine hook (Stdin/IPC Payload)
          │
          └── quota JSON
                ├── Gemini
                │    ├── 5h % (Remaining & Reset In)
                │    └── Weekly % (Remaining & Reset In)
                │
                └── Claude / GPT
                     ├── 5h % (Remaining & Reset In)
                     └── Weekly % (Remaining & Reset In)
                          │
                          ▼
                  AgyQuotaStore (实时单例)
                          │
                          ▼
            usageBridge / fetchAgyUsage() (补充每周额度或离线回退)
                          │
                  Happy App & Terminal UI
```

`/usage` 的实时查询链为 CloudCode API → Language Server → statusLine 缓存；上图展示 statusLine 的本地同步路径。

上下文快照仅在 `conversation_id` / `session_id` 与当前会话匹配时上报。常规文件读取限制为 5 分钟内，`/usage` 离线回退最多接受 24 小时；倒计时根据绝对重置时间重新计算。

## 关键数据结构

```typescript
export interface AgyQuotaWindow {
  percentage?: number;         // 0 ~ 100
  remainingFraction?: number;  // 0.0 ~ 1.0
  usedPercentage?: number;     // 0 ~ 100
  resetTime?: string;          // ISO 时间戳
  resetInSeconds?: number;
  resetsInMinutes?: number;
  resetsInFormatted?: string;  // 例如 "3h 45m", "Now"
}

export interface AgyQuotaGroup {
  name: string;
  fiveHour?: AgyQuotaWindow;
  weekly?: AgyQuotaWindow;
}

export interface AgyStatusLineQuota {
  gemini?: AgyQuotaGroup;
  claude?: AgyQuotaGroup;
  models?: ModelQuotaInfo[];
  raw?: Record<string, unknown>;
  updatedAt: number;
}
```

## 外部依赖与 API

- **Agy statusLine hook Payload 协议**：
  - 输入：JSON 对象或 JSON 字符串。
  - 核心字段：`payload.quota.gemini`、`payload.quota.claude`、`payload.model`、`payload.context_window`。
- **本地 Language Server RPC (Fallback)**：
  - URL: `http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus`
- **Google Cloud Code API (Primary for `/usage`)**：
  - URL: `https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`

## 异常路径

1. **CloudCode API 不可用**：
   - `fetchAgyUsage` 回退至 Language Server 探测，再尝试 24 小时内的 statusLine 缓存。
2. **所有配额渠道皆不可用**：
   - 优雅返回 `source: 'none'`，显示友好的配置与登录排查引导，不中断正常 Agent 对话。

## 测试验证方式

1. **单元测试**：
   - `pnpm --filter happy test src/agyStream/statusLine.test.ts`
   - `pnpm --filter happy test src/agyStream/usage.test.ts`
2. **全量编译与回归测试**：
   - `pnpm --filter happy test src/agy`

## 变更记录

- `2026-08-25`:
  - 初始设计与实现：创建 `packages/happy-cli/src/agyStream/statusLine.ts`。
  - 实现双通道解耦架构与实时 `AgyQuotaStore`。
  - 集成至 `usage.ts` 并完成全量自动化测试。
