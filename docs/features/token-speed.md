# Token 输出速度

Expo App 在每轮最后一条可见 Agent 回复的底部显示 `平均 50.0 tok/s`，
与复制按钮、耗时和完成时间同行。输入框下方仅保留周用量和上下文占用。
点击速度可查看统计口径。数值随该轮用量事件更新，各轮独立保留自己的速度。
App 与 CLI 都需要包含本功能；旧 CLI 或没有速度字段的历史消息不显示速度。

## 统计口径

速度是 **输出 token 数 / 对应统计区间的总耗时（秒）**，包含等待、输入处理和工具执行时间。
它是该轮 Agent 的平均输出吞吐量，不是整个会话的平均速度，也不能用作模型纯生成阶段的瞬时速度。
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
- **agy 默认 stream-json 引擎**：由于 agy 持续进程的 `result.usage.output_tokens` 与 `result.duration_seconds`
  为整场会话轨迹的累计值（耗时包含空闲停顿），速度按每轮基线差值 `output_tokens - baseline` 计算输出 token，
  始终使用本轮 `sendPrompt` 起止的单调时钟耗时，不采用提供方累计 duration。
  内部用量事件显式区分 `session`（stream-json result）、`step` 和 `turn`（SDK response）。
  恢复会话的首轮若没有历史基线，使用当轮 step 输出；按 `step_index` 保存最新快照，重复上报不累加。
  缺少最终 result 会使下一轮基线失效，再通过当轮 step 或新的 result 建立基线；
  无可靠计数、基线未知且没有 step、计数器回退或耗时无效时隐藏速度，不把历史 token 算入当前轮。
  **SDK 引擎**直接使用该次 `response.usage.output_tokens` 和本地回合计时，不扣除上一轮用量。
  上下文占用使用最近一次请求或状态栏快照，状态栏优先采用 `current_usage`；
  累计 result 仅更新速度，不能覆盖上下文大小。尚无上下文快照时不为发送速度而编造用量。
  结束时在最新上下文快照上附加最终速度。新回合清除速度，`/clear` 同时重置基线和上下文快照。
  不从字符数或配额百分比估算输出 token；旧 `legacy` 引擎尚未接入。

未提供速度、非正或非有限速度不显示；有效值保留一位小数，低于 `0.1` 显示 `<0.1 tok/s`。
同轮后续没有速度字段的用量更新会清除该轮旧值，不影响其他轮次；清空会话会重建 Codex 计时器。

## 数据链路

1. CLI 的 `utils/tokenSpeed.ts` 计算速度；Claude converter、Codex mapper 与 agy runner 将结果附加到
   现有 usage 快照的可选字段 `output_tokens_per_second`。
2. 继续使用空文本 `service` 用量事件。Codex 保持无 turn 的兼容格式，旧 App 不会多出空白消息。
3. App 的 `typesRaw.ts` 验证速度字段，异常值只丢弃速度，不影响其余上下文用量。
4. reducer 保留不可见用量快照，由 `utils/agentTurnTokenSpeed.ts` 复用 `assignTurns` 的轮次划分，
   将速度写入对应轮次最后一条可见文本的 `tokensPerSecond`。有 turn ID 时优先精确匹配；
   旧 CLI 没有 turn ID 时，根据快照之前最近一行的轮次关联。排队或失败的用户消息不切断轮次，
   没有足够归属信息的快照不显示。历史分页后重新关联，不将最新速度套用到旧回复。
5. `MessageView` 在回复底部复用 `OutputTokenSpeed` 渲染数值及说明。
   相同毫秒内按接收顺序应用用量更新，使最终速度快照生效。
   `latestUsage.tokensPerSecond` 继续保留最近快照供兼容使用，不再传给输入框。

## 验证

- CLI：`utils/tokenSpeed.test.ts`、Claude/Codex 的 `tokenSpeed.test.ts`，以及既有 converter / mapper 测试。
- agy：`agyStream/tokenSpeed.test.ts` 通过真实解析器重放多轮、恢复、重复 step、缺少 result 与计数器回退；
  SDK 测试串联桥接事件与速度计算，runner / 用量桥接测试验证上下文不被累计值覆盖和 `/clear` 重置。
- App：`sync/tokenSpeed.test.ts` 验证归一化、逐轮速度归属、历史分页、迟到用量、排队输入、异常值与无空白行；
  `components/MessageView.test.ts` 验证速度与耗时、复制按钮位于同一回复底部；
  `components/usage/OutputTokenSpeed.test.ts` 验证显示、隐藏与说明点击。
- App 与 CLI TypeScript 检查。
- 在线验收时检查 CLI → Relay → App 链路、速度数值与说明，以及无速度字段时的隐藏状态。
