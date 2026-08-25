# Antigravity (agy) StatusLine Hook & Quota Channel

Feature document for Antigravity (`agy`) StatusLine Hook integration and real-time quota telemetry in Happy Agy Adapter.

## 功能目标

将 Happy Agy Adapter 升级为**解耦双通道架构**：
1. **`stream-json` 纯净通道**：专门处理 Agent 正常对话交互生命周期（初始化、Step 增量、工具调用、思考过程、最终执行结果），不再强行塞入或混杂使用量统计。
2. **`statusLine hook` 配额通道**：建立实时配额主通道，直接接收 Agy 进程下发的 `statusLine.quota` JSON 数据，支持：
   - **Gemini 模型池**：5 小时滚动额度 (5h %) 与每周额度 (Weekly %)，包含精确重置倒计时。
   - **Claude / GPT 模型池**：5 小时滚动额度 (5h %) 与每周额度 (Weekly %)，包含精确重置倒计时。
3. **实时响应与多源回退**：
   - 维护内存级 `AgyQuotaStore`，当 statusLine 数据更新时即时更新。
   - 当 statusLine hook 尚未收到数据时，自动平滑回退至本地 Language Server RPC (`GetUserStatus`) 及 Google Cloud Code API (`fetchAvailableModels`)。

## 核心入口

| 组件 | 文件 | 角色 |
|---|---|---|
| StatusLine 解析与配额缓存 | `packages/happy-cli/src/agy/statusLine.ts` | 解析 `statusLine.quota` JSON，维护 `AgyQuotaStore` 单例与订阅通知 |
| 配额采集与多源协调 | `packages/happy-cli/src/agy/usage.ts` | 统一 `fetchAgyUsage` 优先级调度（statusLine -> LS -> API），格式化输出 |
| 会话运行与交互 | `packages/happy-cli/src/agy/runAgy.ts` | 拦截 `/usage` 指令并下发实时配额 Markdown 报表 |
| 单元测试 | `packages/happy-cli/src/agy/statusLine.test.ts` | 验证多级窗口解析、分组格式、`AgyQuotaStore` 状态机 |

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
            fetchAgyUsage() (P0 优先级)
                          │
              Happy App & Terminal UI
```

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
- **Google Cloud Code API (Fallback)**：
  - URL: `https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`

## 异常路径

1. **statusLine hook 暂未上报**：
   - `fetchAgyUsage` 自动无缝回退至 Language Server 探测或 CloudCode API。
2. **所有配额渠道皆不可用**：
   - 优雅返回 `source: 'none'`，显示友好的配置与登录排查引导，不中断正常 Agent 对话。

## 测试验证方式

1. **单元测试**：
   - `pnpm --filter happy test src/agy/statusLine.test.ts`
   - `pnpm --filter happy test src/agy/usage.test.ts`
2. **全量编译与回归测试**：
   - `pnpm --filter happy test src/agy`

## 变更记录

- `2026-08-25`:
  - 初始设计与实现：创建 `packages/happy-cli/src/agy/statusLine.ts`。
  - 实现双通道解耦架构与实时 `AgyQuotaStore`。
  - 集成至 `usage.ts` 并完成全量自动化测试。
