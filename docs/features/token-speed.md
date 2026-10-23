# Token 输出速度

Expo App 的输入框下方用量栏显示 `平均 50.0 tok/s`，与周用量、上下文占用并列。
点击速度可查看统计口径。数值随用量事件更新，最近一次有效上报会保留到后续用量更新。
App 与 CLI 都需要包含本功能；旧 CLI 或没有速度字段的历史消息不显示速度。

## 统计口径

速度是 **输出 token 数 / 对应统计区间的总耗时（秒）**，包含等待、输入处理和工具执行时间。
它是 Agent 的平均输出吞吐量，不能用作模型纯生成阶段的瞬时速度。
直接使用提供方的输出 token 计数，不将输入和缓存 token 加入分子，也不根据字符数猜测。

- **Claude Code 远程模式**：SDK `result.usage.output_tokens / (result.duration_ms / 1000)`。
  分子与分母来自同一份 SDK result，遵循它的统计范围，可能包含多个请求和子任务。
  原有上下文用量仍来自最后一条主助手回复，不将 result 的累计 token 写成当前上下文大小。
  速度在 result 到达后更新；本地终端模式没有 SDK result 时隐藏。
- **Codex**：以该回合 `total.outputTokens` 相对起点的增量，除以主线程
  `task_started` 到当前用量事件或回合结束的单调时钟耗时。
  首次恢复旧线程时，用首个事件的 `total - last` 建立历史基线；后续回合沿用上一份总量。
  重复用量事件不会累加 token；结束后冻结耗时，迟到的最终用量仍使用该结束时间。
  未知基线、计数器回退或缺少计时依据时隐藏该回合的速度，下一回合可重新开始统计。
- **agy 默认 stream-json 引擎**：使用同一份 `result.usage.output_tokens / result.duration_seconds`，
  在回合结束时更新；不累加重复的 step 用量与最终汇总。缺少有效提供方耗时时，使用当前回合
  `sendPrompt` 起止的单调时钟耗时。**SDK 引擎**使用该次 `response.usage.output_tokens`
  和相同的本地回合计时。状态栏上下文快照保留本回合的有效速度，新回合与 `/clear` 重置统计；
  恢复会话时不把历史用量计入当前回合。缺少输出计数时隐藏，不从字符数或配额百分比估算。
  旧 `legacy` 引擎尚未接入。

未提供速度、非正或非有限速度不显示；有效值保留一位小数，低于 `0.1` 显示 `<0.1 tok/s`。
后续没有速度字段的用量更新会清除旧值；清空会话会重建 Codex 计时器。

## 数据链路

1. CLI 的 `utils/tokenSpeed.ts` 计算速度；Claude converter、Codex mapper 与 agy runner 将结果附加到
   现有 usage 快照的可选字段 `output_tokens_per_second`。
2. 继续使用空文本 `service` 用量事件。Codex 保持无 turn 的兼容格式，旧 App 不会多出空白消息。
3. App 的 `typesRaw.ts` 验证速度字段，异常值只丢弃速度，不影响其余上下文用量。
4. reducer 将速度写入 `latestUsage.tokensPerSecond`，SessionView 传给 AgentInput，
   `OutputTokenSpeed` 渲染数值及说明。相同毫秒内按接收顺序应用更新，使最终速度快照生效。

## 验证

- CLI：`utils/tokenSpeed.test.ts`、Claude/Codex 的 `tokenSpeed.test.ts`，以及既有 converter / mapper 测试。
- agy：`agyStream/tokenSpeed.test.ts`、stream-json / SDK 事件映射与 runner 用量桥接测试。
- App：`sync/tokenSpeed.test.ts` 验证归一化、用量存储、异常值与无空白行；
  `components/usage/OutputTokenSpeed.test.ts` 验证显示、隐藏与说明点击。
- App 与 CLI TypeScript 检查。
- 在线验收时检查 CLI → Relay → App 链路、速度数值与说明，以及无速度字段时的隐藏状态。
