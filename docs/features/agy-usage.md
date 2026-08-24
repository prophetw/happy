# Antigravity (agy) Quota & `/usage` Slash Command Support

Feature document for `/usage` slash command and Antigravity (`agy`) quota & rate limit tracking across Happy CLI, daemon, and mobile/web clients.

## 功能目标

在 Happy 客户端（iOS / Web / Desktop / Terminal）中支持 `/usage` 特殊指令及 `happy usage` CLI 命令，实时查询并展示当前登录账户的 Antigravity (`agy`) 剩余额度，重点包括：
1. **5 小时滚动额度 (5-Hour Rolling Quota)**：按模型或模型阶梯（Flash, Pro, Claude Thinking, GPT-OSS 等）展示剩余百分比与重置倒计时（Reset In）。
2. **账户与套餐信息**：展示账户邮箱、会员等级（如 Google AI Pro / TEAMS_TIER_PRO）、可用额度与积分（Available Credits）。
3. **零 Token 损耗**：在 Happy CLI 会话层拦截指令，不作为 LLM 提示词输入，不消耗任何模型 Token。

## 核心入口

| 组件 | 文件 | 角色 |
|---|---|---|
| 指令解析 | `packages/happy-cli/src/parsers/specialCommands.ts` | 解析 `/usage` 指令并标记为特殊系统命令类型 |
| 额度采集与格式化 | `packages/happy-cli/src/agy/usage.ts` | 探测本地 Language Server 与 Google Cloud Code API 采集配额并格式化为 Markdown / Terminal 输出 |
| 运行时拦截与响应 | `packages/happy-cli/src/agy/runAgy.ts` | 在会话层拦截 `/usage` 指令，调用采集模块并直接向客户端下发模型输出与状态信封 |
| CLI 独立命令 | `packages/happy-cli/src/index.ts` | 提供 `happy usage [--markdown | --json]` 终端直接查询能力 |
| 客户端自动补全 | `packages/happy-app/sources/sync/suggestionCommands.ts` | 将 `usage` 纳入全端 Slash Command 补全与提示列表中 |

## 架构关系与数据流

```
Happy App (iOS / Web / Desktop)
   │
   ├─► 用户输入 /usage 并发送
   │        │
   │        ▼
   ▼
Happy CLI (runAgy.ts)
   │
   ├─[1] parseSpecialCommand(text) -> { type: 'usage' }
   │     消息入队 messageQueue.pushIsolateAndClear(...) 
   │
   ├─[2] fetchAgyUsage({ log })
   │        │
   │        ├─► [优先] 探测本地 Language Server
   │        │     ps aux 提取 PID & --csrf_token -> lsof 扫描本地监听端口
   │        │     POST http://127.0.0.1:<PORT>/exa.language_server_pb.LanguageServerService/GetUserStatus
   │        │
   │        └─► [兜底] 探测 Google Cloud Code API
   │              读取 ~/.gemini/antigravity-cli/antigravity-oauth-token
   │              POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
   │
   ├─[3] formatAgyUsageMarkdown(status)
   │     生成包含 5 小时滚动额度、剩余百分比、已用比例、重置倒计时的 Markdown 报表
   │
   └─[4] sendEnvelopes(...)
         下发 Session Protocol 消息至 Happy 客户端（无需唤起 LLM）
```

## 关键数据结构

```typescript
export interface ModelQuotaInfo {
  modelId: string;
  label: string;
  remainingFraction?: number; // 0.0 ~ 1.0 (1.0 = 100% 剩余)
  usedPercentage?: number;    // 0 ~ 100
  resetTime?: string;         // ISO 时间戳
  resetsInMinutes?: number;   // 剩余分钟数
  resetsInFormatted?: string; // 人类可读倒计时，如 "1h 30m"
  maxTokens?: number;
  isRecommended?: boolean;
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
  source: 'language-server' | 'cloudcode-api' | 'none';
  error?: string;
}
```

## 外部依赖与 API

- **本地 Language Server RPC**：
  - URL: `http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus`
  - Headers: `X-Codeium-Csrf-Token: <csrf_token>`, `Content-Type: application/json`
  - Body: `{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en"}}`
- **Google Cloud Code API (Fallback)**：
  - URL: `https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`
  - Headers: `Authorization: Bearer <access_token>`, `Content-Type: application/json`

## 异常路径

1. **Language Server 未启动且无有效 OAuth Token**：
   - `fetchAgyUsage` 返回 `source: 'none'`，格式化输出提示用户检查 Antigravity 登录状态，会话保持稳定不崩溃。
2. **API 限流 (HTTP 429)**：
   - 捕获错误并平滑降级，提示限流并显示已知重置建议。
3. **指令在离线或本地模式执行**：
   - TTY 终端模式下直接通过终端彩色视图呈现，同时向远端协议发送 Markdown 渲染块。

## 测试验证方式

1. **单元测试**：
   - `packages/happy-cli/src/agy/usage.test.ts`：验证倒计时计算、时间格式化、用户状态解析与降级。
   - `packages/happy-cli/src/parsers/specialCommands.test.ts`：验证 `/usage` 特殊指令精准解析。
   - `packages/happy-app/sources/sync/suggestionCommands.test.ts`：验证前端自动补全包含 `usage` 指令。
2. **全量回归测试**：
   - `pnpm --filter happy test`
   - `pnpm --filter happy-app test -- --run`
3. **CLI 实时验证**：
   - `happy usage`
   - `happy usage --markdown`
   - `happy usage --json`

## 变更记录

- `2026-08-24`:
  - 新增 `packages/happy-cli/src/agy/usage.ts` 实现本地 Language Server 与 CloudCode API 双通道额度采集。
  - 在 `specialCommands.ts` 中注册 `/usage` 指令解析，并在 `runAgy.ts` 中实现拦截与 Markdown 报表下发。
  - 在 `packages/happy-app/sources/sync/suggestionCommands.ts` 中将 `usage` 加入默认斜杠命令补全列表。
  - 在 `happy-cli` 根入口 `index.ts` 中增加 `happy usage` 命令。
  - 编写相关单元测试并全部通过。
