# Token 输出速度与首 token 等待

Expo App 在每轮最后一条可见 Agent 回复的底部显示
`生成 50.0 tok/s · 首 token 8.00 s`，与复制按钮、耗时和完成时间同行。
点击可查看采样的输出 token、生成阶段耗时、请求次数与统计口径。
输入框下方继续显示周用量和上下文占用，各轮独立保留自己的指标。

## 统计口径

两项指标独立测量，只使用提供方上报的输出 token，不根据字符数估算，
不加入输入或缓存 token。

- **生成阶段速度**：完整响应中可计时的输出 token 总数，除以这些响应从首个到最后一个
  非空内容片段的耗时总和（秒）。包含可观测的流式思考、正文和工具参数。
  不把请求开始至首个内容片段的等待、工具执行、人工确认或尾部用量上报计入生成时间。
  多个有效响应按 token 与生成耗时加权，不再固定使用 Codex 首个样本。
  Codex 没有思考流时，使用 `outputTokens - reasoningOutputTokens` 作为正文 token 数，
  与正文流的时间配对；完整输出用量和上下文占用保持原值。
  agy stream-json 也用 `output_tokens - thinking_tokens` 与正文片段配对；
  缺少可拆分的思考计数时不猜测正文 token，仍可保留可靠的首 token 等待。
- **首 token 等待**：从可靠请求边界到首个非空内容片段的时间，显示本轮有效请求的
  算术平均值。Codex 首段包含本地提示准备；Claude 从 UserPromptSubmit 或
  PostToolBatch 开始计时，也可能包含请求准备与输入处理。agy stream-json 从本轮发送前开始，
  工具结束后的请求从全部已开始工具结束时开始；首个 ACTIVE 已带正文时不把等待算为 0。
  它不是从用户发送到整轮完成的总耗时。

例如请求开始后等待 8 秒，再在 2 秒内收到 100 个输出 token，显示
`生成 50.0 tok/s · 首 token 8.00 s`。延迟到达的用量通知不改变内容流的起止时间。

这是客户端观察到的内容流吞吐量，不是服务端精确解码速度。
提供方分块、缓冲、思考 token 的上报方式和输入长度仍会影响比较。
只有一个内容片段或全部片段落在同一时刻时，不计算生成速度，但可靠的首 token 等待仍可显示。
有内容流计时但没有可靠请求起点时，可只显示生成速度。

准确性优先于覆盖率：不完整、计数异常或边界不可靠的片段不参与采样。
两项指标的有效请求集合可能不同；缺少对应计时就隐藏该项，不回退到整轮耗时。
首 token 指首个可观测内容，思考内容没有流式输出时，其生成时间包含在可观测首 token 的等待中。

## 引擎与边界

| 引擎 | 采样方式与限制 |
| --- | --- |
| Claude Code 远程模式（含 Kimi / CCS 路由） | UserPromptSubmit 为初始请求、原生 PostToolBatch 为工具结束后的请求建立起点。message_start 只建立响应身份，不作为首 token；非空 text / thinking / input_json 内容片段建立生成起止时间。message_stop 后以最终 message_delta.usage.output_tokens 结算，逐请求发布中途快照并加权。工具开始、确认、重试、压缩、切换模型和未完成流使当前片段失效，下一次可靠边界可恢复。子线程及重复响应 ID 不参与，混用主模型时隐藏。不依赖 num_turns === 1。 |
| Codex | task_started 为初始请求建立起点；token_count 可为后续请求建立边界，已开始的工具未结束时等全部结束再计时。原生 agentMessage / reasoning delta 和 legacy 内容 delta 记录实际内容到达时间。要求累计输出增量与 last.outputTokens 一致，首次恢复可对齐历史；历史快照和重复用量不移动起点。每个完整有效响应参与生成速度与等待统计。工具、查看图片、sleep、压缩和并行工具的时间不进入指标；无可靠边界的等待、未知事件和异常计数停止后续采样，保留已完成样本。没有思考流时，从 outputTokens 中扣除上报的 reasoningOutputTokens，以正文 token 数和正文时间计算速度；首 token 等待保留隐藏思考耗时。思考计数异常或扣除后没有正文 token 时只保留等待。 |
| agy stream-json | 通过原生 step_update 回调先记录 agent_response 正文片段时间，再处理同一帧的 usage 和最后一段正文。以 step_index 去重，DONE 结算，输出 token 扣除上报的 thinking_tokens；重复完成快照只更新计数，不拉长生成时间或移动下一请求边界。成对工具 / 子任务执行不进入等待；确认、取消、checkpoint 或未知活动使未完成采样失效。后续可靠工具边界可恢复。会话累计 result 不作为单请求计数或计时。 |
| agy SDK / legacy | 尚无可靠原生内容步骤回调，不生成新指标；保留已有用量 / 上下文行为。 |

Claude result.duration_api_ms 的原有单请求兜底只生成旧的请求平均速度，
不会被解释为生成速度或首 token 等待。本地终端模式没有 SDK 内容流时不猜测。
Codex 也不从最终 agent_message 的到达时间推算首 token。

每个新回合、清空或切换会话会重置当前采样。子线程和旧轮次的用量不进入主线程统计。
中断的回合保留已发布的有效样本，不让后续工具或迟到通知扩大已完成样本的分母。
上下文占用仍使用原有请求或状态栏快照，不把会话累计 token 当作上下文大小。

## 数据链路与兼容性

1. CLI 复用现有空文本 service 用量事件，新增：
   - generation_tokens_per_second：生成阶段的加权速度。
   - generation_tokens_per_second_sample：{ tokens, duration_ms, requests }，只含生成阶段。
   - time_to_first_token_ms：有效请求的首个可观测内容平均等待时间，可以为 0。
2. 旧的 output_tokens_per_second、model_request scope 和 sample 保持原有请求平均口径，
   供旧客户端兼容。App 把这种数据明确标为“请求”，不把旧历史重新标为“生成”。
3. Claude 的 claudeRemote 将 SDK 的完整 stream_event（包括内容增量）交给 converter，
   在完整响应结束后发出快照，result 复用累计采样。内容增量只用于计时，
   不进入聊天消息队列或内容日志。Codex 原生适配器只发出不含正文的计时标记，
   runCodex 将其直接交给 tracker，不为每个原生内容片段新增日志或聊天行。
   agy 后端利用现有 parser.onStepUpdate 回调，将原始帧直接交给 tracker，
   避免 DONE 帧先发用量、后发最后正文时遗漏终点；回调不会新增聊天消息。
   runner 在用量、状态栏和回合结束快照上附加相同的新指标。
4. App 的 typesRaw.ts 分别校验新字段，异常指标不丢弃消息或上下文用量。
   reducer 将 generationMetrics（tokensPerSecond / sample / timeToFirstTokenMs）
   交给 agentTurnTokenSpeed，沿用 assignTurns 的归属规则，绑定该轮最后一条可见回复。
   历史分页、迟到快照、同毫秒接收顺序和排队输入沿用已有逻辑。
5. MessageView 和 OutputTokenSpeed 分别显示速度和等待。只有等待时也显示；
   没有新指标的历史消息仍可显示明确标为“请求”的旧速度。
   弹窗使用生成阶段 sample 解释计算，避免拿请求总耗时解释生成速度。
   latestUsage.tokensPerSecond 继续保留旧请求平均值供兼容使用，不传给输入框。

CLI 与 App 都需要包含本次修改。手机更新不会更新电脑上的 CLI 或已有会话进程。
旧历史没有内容到达时间，无法补算生成速度与首 token 等待。

## 验证

- CLI：可控时间重放验证 8 秒等待 + 2 秒生成的两项指标；后续响应加权、历史/重复用量、
  单片段、未流式输出的思考、无内容流、迟到用量和逐轮重置。
  增加真实 Codex 会话的脱敏重放：3,893 输出 token 减去 1,552 思考 token，
  得到 2,341 正文 token；正文流耗时 22.691 秒，速度约 103.2 tok/s，首 token 等待 28.886 秒。
- Codex：原生客户端 → mapper → tracker 验证正文与思考 delta；过滤空片段、子线程和旧轮次。
  工具多执行一分钟不改变两项指标，已完成样本不受后续等待影响。
- Claude：SDK 输入 → claudeRemote 真实转发 → converter → mapper 验证新增字段透传，
  确保内容增量不会在转发层被过滤，也不会产生重复聊天行或进入内容日志。
  内容片段独立于 message_start / message_stop，
  完整请求加权、重复响应、工具/确认中断、子线程隔离、未知起点和旧 API 计时兼容。
- agy：覆盖真实原生 stdout → AgyBackend → runner → 用量快照，验证最后一个 DONE 帧、
  思考 token 扣除、独立等待、单片段、加权去重、并行工具、确认中断 / 恢复、累计结果排除和逐轮重置。
  另用受控 Gemini 原生请求验证真实内容流与上报计数，探测后关闭临时原生进程。
- App：验证规范化 → reducer → 回合归属 → 消息底部展示，覆盖等待为 0、只有等待、
  非法指标不丢上下文、生成阶段计算说明和旧指标兼容。
- 真实 CLI → Relay → App、浏览器和手机表现需单独验收；单元测试不代表线上验证。
