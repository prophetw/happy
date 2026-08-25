# Antigravity (agy) Quota & `/usage` Slash Command Support

Feature document for `/usage` slash command and Antigravity (`agy`) quota & rate limit tracking across Happy CLI, daemon, and mobile/web clients.

## 功能目标

在 Happy 客户端（iOS / Web / Desktop / Terminal）中支持 `/usage` 特殊指令及 `happy usage` CLI 命令，实时查询并展示当前登录账户的 Antigravity (`agy`) 剩余额度，重点包括：
1. **解耦双通道架构**：
   - `stream-json` 通道专门承载标准 Agent 对话交互（Turn、Tool Calls、Thinking、Text Deltas）。
   - `statusLine hook` 通道作为配额与额度同步的主通道，接收 Agy 实时下发的 Quota JSON。
2. **5 小时滚动与每周额度 (5-Hour Rolling & Weekly Quotas)**：
   - **Gemini 模型池**：5h 剩余百分比与 Weekly 剩余百分比，包含重置倒计时（Reset In）。
   - **Claude / GPT 模型池**：5h 剩余百分比与 Weekly 剩余百分比，包含重置倒计时。
3. **账户与套餐信息**：展示账户邮箱、会员等级（如 Google AI Pro / TEAMS_TIER_PRO）、可用额度与积分（Available Credits）。
4. **零 Token 损耗**：在 Happy CLI 会话层拦截指令，不作为 LLM 提示词输入，不消耗任何模型 Token。

## 核心入口

| 组件 | 文件 | 角色 |
|---|---|---|
| 指令解析 | `packages/happy-cli/src/parsers/specialCommands.ts` | 解析 `/usage` 指令并标记为特殊系统命令类型 |
| StatusLine 解析与配额存储 | `packages/happy-cli/src/agy/statusLine.ts` | 解析 `statusLine.quota` JSON（Gemini/Claude 5h & Weekly），维护实时 `AgyQuotaStore` |
| 额度采集与格式化 | `packages/happy-cli/src/agy/usage.ts` | 优先从 `AgyQuotaStore` 读取，回退探测 Language Server 与 Cloud Code API 并格式化输出 |
| 运行时拦截与响应 | `packages/happy-cli/src/agy/runAgy.ts` | 在会话层拦截 `/usage` 指令，调用采集模块并直接向客户端下发模型输出与状态信封 |
| CLI 独立命令 | `packages/happy-cli/src/index.ts` | 提供 `happy usage [--markdown | --json]` 终端直接查询能力 |
| 客户端自动补全 | `packages/happy-app/sources/sync/suggestionCommands.ts` | 将 `usage` 纳入全端 Slash Command 补全与提示列表中 |

## 架构关系与数据流

```
Agy 常驻进程
    │
    ├── [1] stream-json (Stdout)
    │     └── 正常 Agent 对话 (Init / Step Updates / Tool Calls / Thinking / Result)
    │
    └── [2] statusLine hook (Stdin/IPC)
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
                  AgyQuotaStore (实时单例缓存)
                          │
Happy App / CLI ◄─────────┴── [3] /usage 指令拦截或 Happy usage
```

### 配额优先级解析链

1. **P0 (Primary)**：`AgyQuotaStore.toUsageStatus()` (来自 Agy 进程的 `statusLine.quota` 实时推送，`source: 'statusline-hook'`)
2. **P1 (Fallback 1)**：本地 Language Server RPC (`GetUserStatus`，`source: 'language-server'`)
3. **P2 (Fallback 2)**：Google Cloud Code API (`fetchAvailableModels`，`source: 'cloudcode-api'`)

## 关键数据结构

```typescript
export interface AgyQuotaWindow {
  percentage?: number;         // 0 ~ 100
  remainingFraction?: number;  // 0.0 ~ 1.0
  usedPercentage?: number;     // 0 ~ 100
  resetTime?: string;          // ISO 时间戳
  resetInSeconds?: number;
  resetsInMinutes?: number;
  resetsInFormatted?: string;  // 人类可读倒计时，如 "3h 45m"
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

export interface AgyUsageStatus {
  accountName?: string;
  email?: string;
  planName?: string;
  teamsTier?: string;
  userTierName?: string;
  availableCredits?: Array<{ creditType: string; minimumCreditAmountForUsage?: string }>;
  availablePromptCredits?: number;
  availableFlowCredits?: number;
  models: ModelQuotaInfo[];
  groups?: Record<string, AgyQuotaGroup>;
  statusLineQuota?: AgyStatusLineQuota;
  fiveHourWindow?: {
    usedPercentage?: number;
    remainingPercentage?: number;
    resetsAt?: number;
    resetsInFormatted?: string;
  };
  sevenDayWindow?: {
    usedPercentage?: number;
    remainingPercentage?: number;
    resetsAt?: number;
    resetsInFormatted?: string;
  };
  source: 'statusline-hook' | 'language-server' | 'cloudcode-api' | 'none';
  error?: string;
}
```

## 外部依赖与 API

- **Agy statusLine hook Payload**：
  - 由 Agy 常驻进程在状态变更时下发，包含 `quota.gemini` 与 `quota.claude`（5h % 与 Weekly %）。
- **本地 Language Server RPC (Fallback)**：
  - URL: `http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus`
  - Headers: `X-Codeium-Csrf-Token: <csrf_token>`, `Content-Type: application/json`
  - Body: `{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en"}}`
- **Google Cloud Code API (Fallback)**：
  - URL: `https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`
  - Headers: `Authorization: Bearer <access_token>`, `Content-Type: application/json`

## 异常路径

1. **Agy 进程未就绪且无其它数据源**：
   - `fetchAgyUsage` 返回 `source: 'none'`，格式化输出提示用户检查 Antigravity 登录状态，会话保持稳定不崩溃。
2. **API 限流 (HTTP 429)**：
   - 捕获错误并平滑降级，提示限流并显示已知重置建议。
3. **指令在离线或本地模式执行**：
   - TTY 终端模式下直接通过终端彩色视图呈现，同时向远端协议发送 Markdown 渲染块。

## 测试验证方式

1. **单元测试**：
   - `packages/happy-cli/src/agy/statusLine.test.ts`：验证 `statusLine.quota` 解析、Gemini/Claude 分组与 `AgyQuotaStore` 状态机。
   - `packages/happy-cli/src/agy/usage.test.ts`：验证 P0 优先从 `statusLine.quota` 采集配额、分层表格 Markdown 与 Terminal 输出。
   - `packages/happy-cli/src/parsers/specialCommands.test.ts`：验证 `/usage` 特殊指令精准解析。
2. **全量回归测试**：
   - `pnpm --filter happy test src/agy`
3. **CLI 实时验证**：
   - `happy usage`
   - `happy usage --markdown`
   - `happy usage --json`

## 变更记录

- `2026-08-25`:
  - 架构重构：引入双通道解耦设计（`stream-json` 负责对话流，`statusLine hook` 负责配额 JSON）。
  - 新增 `packages/happy-cli/src/agy/statusLine.ts` 实现 `parseStatusLinePayload` 与实时 `AgyQuotaStore`。
  - 在 `packages/happy-cli/src/agy/usage.ts` 中将 `statusLine.quota` 提升为 P0 采集源，支持 Gemini 与 Claude/GPT 5h/Weekly 滚动额度展示。
  - 编写 `statusLine.test.ts` 与更新 `usage.test.ts`，全量测试通过。
- `2026-08-24`:
  - 新增 `packages/happy-cli/src/agy/usage.ts` 实现本地 Language Server 与 CloudCode API 额度采集。
  - 在 `specialCommands.ts` 中注册 `/usage` 指令解析并在 `runAgy.ts` 中实现拦截。

