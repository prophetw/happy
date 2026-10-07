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
  - `buildAgentTurnDurationByMessageId(messages, options)`：按 Turn 轮次分析消息列表（newest-first），计算用户输入到该轮次最后一行消息（含收尾工具执行）的端到端耗时，映射至该轮次 final agent message ID。

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
   - 划分轮次（以 `user-text` 作为分界点；pending 用户消息既不计入轮次起点也不计入终点——它尚未开启新轮次）。
   - 取该轮次初始用户消息（或轮次最早消息）的 `createdAt` 作为 `startedAt`。
   - 取该轮次所有消息行 `createdAt` 的最大值作为 `completedAt`。会话协议的 turn-end 标记被 reducer 过滤、不会成为聊天行，而很多轮次在最后一条可见文本之后还有工具执行，因此"最新一行消息"才是可见数据里最接近真实轮次结束的近似；只取最新 agent-text 的 `createdAt` 会把耗时测成"提示 → 末条文本"，看起来就像相邻两条消息的间隔。
   - 得到 `durationMs = completedAt - startedAt`，连同 `completedAt` 一起关联到该 final message 的 `id`。
   - 若当前轮次仍在运行中（`currentTurnComplete === false`），跳过第 0 轮，避免流式过程中闪烁或产生不准确耗时。
3. `ChatList.renderItem` 渲染 `MessageView` 时，将 `durationMs` 与 `turnCompletedAt` 传递给子组件。
4. `MessageView` 用 `turnCompletedAt`（缺省回落到消息自身 `createdAt`）格式化完成时间戳，保证元信息栏中"耗时"与"完成时间"指向同一时刻，并渲染在用户气泡外侧和 Agent 消息底部。

## 关键数据结构

```typescript
export type TurnDurationMessage = {
    id: string;
    kind: string;
    createdAt: number;
    text?: string;
    isThinking?: boolean;
    pending?: boolean;
};

// 轮次耗时映射表: MessageId -> { durationMs, completedAt }
type AgentTurnDuration = { durationMs: number; completedAt: number };
type TurnDurationMap = Map<string, AgentTurnDuration>;
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

- **2026-10-07**:
  - 修复耗时算法：`completedAt` 从"最新可见 agent-text 的 `createdAt`"改为"轮次内所有消息行 `createdAt` 的最大值"。此前以工具执行收尾的轮次（如回复"好的"后跑 3 分钟工具）显示耗时≈相邻消息间隔，明显偏小。映射值形状从 `number` 改为 `{ durationMs, completedAt }`；`MessageView` 新增 `turnCompletedAt` 属性，元信息栏完成时间与耗时的停止时刻保持一致。pending 用户消息排除在轮次起止之外。
- **2026-10-05**:
  - 将 `durationMs` 接入 `ChatList`（与 `agentCopyTextByMessageId` 同一 `useMemo` 模式注入 `MessageView`）。
  - `MessageView` 的 `UserMessageFrame` 底部右对齐渲染用户消息时间戳；`AgentTextBlock` 底部 `agentFooterRow` 在 Copy 按钮同行渲染 `⏱ 耗时 · 完成时间`。
- **2026-08-29**:
  - 新增 `formatMessageTimestamp` 与 `formatTurnDuration` 工具函数。
  - 新增 `buildAgentTurnDurationByMessageId` 轮次耗时计算函数与单元测试。
  - 更新 `MessageView`（`UserTextBlock`、`AgentTextBlock`）支持展示时间戳与单次任务耗时。
  - 更新 `ChatList` 注入 `durationMs`。
