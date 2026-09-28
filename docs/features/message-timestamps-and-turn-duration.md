# Message Timestamps & Turn Duration

## 功能目标

在 iOS / Web / macOS App 消息列表中清晰展示每条消息的发送/回复时间戳，以及单次 Agent 任务（Turn）的总执行耗时：
1. **用户消息时间戳**：展示在用户气泡外侧右下方，低饱和度展示发送时间（如 `14:32`）。
2. **Agent 回复时间戳与任务总耗时**：展示在 Agent 文本消息底部的元信息栏（与 Copy 复制按钮同一行），展示单次任务的总耗时与完成时间戳（如 `⏱ 4.8s · 14:32`）。

## 核心入口

- **`packages/happy-app/sources/utils/messageTimestamp.ts`**
  - `formatMessageTimestamp(timestamp, now?)`：格式化消息时间戳（当天 `HH:mm`、跨天 `M/d HH:mm`、跨年 `YYYY/M/d HH:mm`）。
  - `formatTurnDuration(durationMs)`：格式化任务总耗时（`<0.1s`、`0.5s`、`4.8s`、`14s`、`1m12s`）。
  - `formatWorkDuration(durationMs)`：基础工作时长格式化器。

- **`packages/happy-app/sources/utils/agentTurnDuration.ts`**
  - `buildAgentTurnDurationByMessageId(messages, options)`：按 Turn 轮次分析消息列表（newest-first），计算用户输入到 Agent 最终回复完成的端到端耗时，映射至该轮次 final agent message ID。

- **`packages/happy-app/sources/components/MessageView.tsx`**
  - `UserTextBlock`：渲染用户气泡并在右下方附带时间戳。
  - `AgentTextBlock`：在底部 `agentFooterRow` 渲染 Copy 按钮与 `[⏱ duration · time]` 元信息。

- **`packages/happy-app/sources/components/ChatList.tsx`**
  - 计算 `agentTurnDurationByMessageId` 并注入 `MessageView` 的 `durationMs` 属性。

## 架构关系

```
┌────────────────────────────────────────────────────────┐
│ ChatList (Session Messages: newest-first)              │
│  ├─ buildAgentTurnCopyTextByMessageId                  │
│  └─ buildAgentTurnDurationByMessageId                  │
└───────────────────────────┬────────────────────────────┘
                            │ (durationMs, copyText, message)
                            ▼
┌────────────────────────────────────────────────────────┐
│ MessageView / RenderBlock                              │
│  ├─ UserTextBlock -> [Bubble] + [userTimestampText]    │
│  └─ AgentTextBlock -> [MarkdownView]                   │
│                       └─ [agentFooterRow]              │
│                            ├─ [MessageCopyButton]      │
│                            └─ [agentMetaRow]           │
│                                 (⏱ duration · time)   │
└────────────────────────────────────────────────────────┘
```

## 数据流

1. `ChatList` 接收来自会话存储的 `messages: Message[]`（倒序排列，最新消息在最前）。
2. `useMemo` 调用 `buildAgentTurnDurationByMessageId(messages, { currentTurnComplete })`：
   - 划分轮次（以 `user-text` 作为分界点）。
   - 取该轮次初始用户消息（或轮次最早消息）的 `createdAt` 作为 `startedAt`。
   - 取该轮次最新 visible `agent-text` 消息的 `createdAt` 作为 `completedAt`。
   - 得到 `durationMs = completedAt - startedAt`，关联到该 final message 的 `id`。
   - 若当前轮次仍在运行中（`currentTurnComplete === false`），跳过第 0 轮，避免流式过程中闪烁或产生不准确耗时。
3. `ChatList.renderItem` 渲染 `MessageView` 时，将 `durationMs` 传递给子组件。
4. `MessageView` 格式化时间与耗时，优雅渲染在用户气泡外侧和 Agent 消息底部。

## 关键数据结构

```typescript
export type TurnDurationMessage = {
    id: string;
    kind: string;
    createdAt: number;
    text?: string;
    isThinking?: boolean;
};

// 轮次耗时映射表: MessageId -> duration (ms)
type TurnDurationMap = Map<string, number>;
```

## 外部依赖或 API

- `@expo/vector-icons`（`Ionicons.time-outline` 时钟图标）。
- `react-native-unistyles`（主题响应式样式，适配浅色与深色模式）。

## 异常路径与边界条件

1. **会话首条消息为 Agent 发送（如欢迎语/Fork恢复）**：
   - 没有对应的 `user-text`，且 `completedAt <= startedAt` 时不显示耗时图标，仅显示消息自身的时间戳。
2. **耗时小于 100ms**：
   - 格式化展示为 `<0.1s`，防止出现异常负数或歧义。
3. **时钟微小漂移导致 `completedAt < startedAt`**：
   - `Math.max(0, completedAt - startedAt)` 保证非负。
4. **Slash Command / Goal 任务消息**：
   - `command-run` / `goal-run` 均正常渲染在包装容器底部右对齐。

## 测试验证方式

- 单元测试：
  - `packages/happy-app/sources/utils/messageTimestamp.test.ts`（时间戳跨天/跨年与各种时长范围）。
  - `packages/happy-app/sources/utils/agentTurnDuration.test.ts`（多轮次、进行中轮次、无用户消息轮次）。
- 整体测试：
  - `pnpm --filter happy-app test -- --run`
  - `pnpm --filter happy-app typecheck`

## 变更记录

- **2026-08-29**:
  - 新增 `formatMessageTimestamp` 与 `formatTurnDuration` 工具函数。
  - 新增 `buildAgentTurnDurationByMessageId` 轮次耗时计算函数与单元测试。
  - 更新 `MessageView`（`UserTextBlock`、`AgentTextBlock`）支持展示时间戳与单次任务耗时。
  - 更新 `ChatList` 注入 `durationMs`。
