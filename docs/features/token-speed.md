# Token 输出速度

Expo App 在每轮最后一条可见 Agent 回复的底部显示 `模型 50.0 tok/s`，
与复制按钮、耗时和完成时间同行。点击速度可查看采样口径。
输入框下方仅保留周用量和上下文占用，各轮独立保留自己的速度。

## 统计口径

速度用于比较模型响应：**有可靠计时的模型响应输出 token 总数 / 对应响应耗时总和（秒）**。
只使用提供方实际上报的输出 token，不根据字符数估算，不加入输入或缓存 token。
包含该响应的输入处理、请求等待、推理和响应传输；工具执行、人工确认等待和后续收尾不进入分母。
它是采样响应的平均吞吐量，不能解释为纯解码速度或整轮任务效率。
不同输入长度、推理设置和提供方的 token 口径仍会影响比较。

准确性优先于覆盖率：只统计能对应 token 与耗时的完整响应，可能只覆盖本轮首个响应。
没有可靠计时、边界不明、计数异常或引擎不支持时隐藏，不回退到整轮耗时。

| 引擎 | 采样方式与限制 |
| --- | --- |
| Claude Code 远程模式 | 仅在 SDK result 明确为单次主模型请求（`num_turns === 1`）、只观察到一个主响应 ID、没有子任务或多模型混用，并且主响应与 result 的输出计数一致时，使用 `result.usage.output_tokens / (result.duration_api_ms / 1000)`。不使用 `duration_ms`。多请求结果或缺少 API 耗时不显示；本地终端模式没有 SDK result 时不显示。 |
| Codex | 每轮保留首个可确认的完整响应样本。初始起点为 `task_started`，包含本地提示准备时间。工具先于用量到达时丢弃被打断的片段，但有效 `token_count` 可建立下一请求的起点；若此前开始的工具尚未结束，则等全部结束后才开始计时。用量之后才新开始的工具会再次中断采样，不猜测它属于哪个请求。要求总量增量与 `last.outputTokens` 一致；首次恢复可用 `total - last` 对齐历史。输出前的历史快照只建立基线，重复用量不移动起点。人工等待、压缩、重试、未知事件、多个未结算响应或异常计数使本轮剩余采样失效。原生 MCP 等工具也报告计时边界；未知原生活动不计入模型时间。采样后固定数值，后续工具、回合结束或迟到用量不会扩大分母。 |
| agy stream-json | 只采样 `step_type=agent_response`、`state=DONE` 且同时提供有效 `usage.output_tokens` 和独立 `duration_seconds` 的步骤。按 `step_index` 保存最新快照、去重，再按 token 和耗时加权。工具、reasoning/process 步骤、会话累计 result、没有独立耗时的步骤不参与。旧版 agy 缺少该计时字段时隐藏。 |
| agy SDK / legacy | 当前没有可确认的逐请求耗时，不显示速度；仍正常传递用量和上下文信息。 |

上下文占用继续使用原有请求或状态栏快照。Claude result 不会把累计 token 写成上下文大小；
agy 的会话累计 result 也不能覆盖上下文。发送速度时只在已有上下文快照上附加指标，不编造用量。

每个新回合清除当前采样；清空或切换会话时重置采样状态。
Codex 子线程或旧轮次的用量不会传入主线程采样；审批和提问等带外等待会使本轮尚未完成的采样失效，已确定的样本保留。
未提供速度、非正或非有限速度不显示；有效值保留一位小数，低于 `0.1` 显示 `<0.1 tok/s`。

## 数据链路与兼容性

1. CLI 的 `utils/tokenSpeed.ts`、Claude converter 和 agy tracker 生成采样速度。
   用量快照同时携带 `output_tokens_per_second` 与 `output_tokens_per_second_scope: "model_request"`。
2. 复用现有空文本 `service` 用量事件；Codex 和 agy 保持无 turn 的兼容格式，避免旧 App 显示空白消息。
3. App 的 `typesRaw.ts` 校验速度和 scope；只有 `model_request` scope 会进入展示与存储。
   旧 CLI、旧历史消息只含整轮吞吐量，没有该标记时隐藏，避免被重新标为模型速度。
   异常指标不影响其余上下文用量。
4. reducer 保留不可见用量快照，由 `utils/agentTurnTokenSpeed.ts` 复用 `assignTurns` 的轮次划分，
   将速度写入该轮最后一条可见文本的 `tokensPerSecond`。有 turn ID 时优先精确匹配；
   旧 CLI 没有 turn ID 时按快照之前最近一行关联。历史分页、迟到快照和排队输入沿用原有归属规则。
5. `MessageView` 在回复底部复用 `OutputTokenSpeed` 展示；同一毫秒内按接收顺序应用快照。
   `latestUsage.tokensPerSecond` 继续保留最近有效快照供兼容使用，不传给输入框。

CLI 与 App 都需要包含本次修改；手机更新不会更新电脑上的 CLI 或已有会话进程。

## 验证

- CLI：用可控事件与时间重放模型响应，再增加一分钟工具执行，验证已采样的模型速度不变。
  覆盖首次恢复、旧计数、重复上报、迟到用量、计数回退、工具先于用量、未知事件和多响应边界。
  Codex 增加真实会话日志的脱敏重放，以及工具先结束 / 后结束、并行工具全部结束后恢复的回归测试。
- Claude：验证单请求 API 计时、缺少或无效计时、多请求与计数不匹配时隐藏，以及 converter → mapper 的 scope 透传。
- agy：通过真实 parser 验证完整响应步骤、独立耗时、重复/更新快照、加权采样、累计 result 排除与 SDK 无计时隐藏；
  runner 验证采样经状态栏快照保留、新回合清除、上下文不被累计计数覆盖和 `/clear` 重置。
- App：`sync/tokenSpeed.test.ts` 验证 scope、旧指标隐藏、逐轮归属、分页、迟到用量、排队输入和无空白行；
  `components/usage/OutputTokenSpeed.test.ts` 与 `components/MessageView.test.ts` 验证显示及说明入口。
- 真实 CLI → Relay → App 链路与真机表现需另行验收；单元测试不代表已经完成线上验证。
