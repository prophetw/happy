# Hosted Dot 流式投递

Hosted 路径将一个原生 JSONL 通知产生的 raw、计时、文本和终态回调作为一个同步事务。
只有显式改变 journal 的回调才标记需要提交；不通过重新序列化整个 journal 来判断变化。
输入接纳、dispatching/accepted 绑定、控制和恢复仍有独立持久边界。
普通 Happy 客户端的通知处理和 latest-first/backfill 队列行为保持原样。

Hosted 原生输出通过 readline 的有界异步迭代器消费，在帧之间让出 I/O。
每个帧先完成 journal 提交，再开始下一帧，不等待文本拼字或定时落盘。
Node 的 readline 行迭代器高水位为 1024 行，会暂停上游读取；当前原生读取缓冲区仍可能包含额外行。
它提供背压，不是一个无限 Promise 队列；单条原生消息的既有大小限制没有在此改动。

`HostedOutputDelivery` 只合并已持久化记录的运输和确认事务，不拼接正文、不改变 localId、
Unicode/UTF-16 offset、snapshot 替换或跨 epoch 恢复语义。首段、item/turn/channel/epoch
变化、snapshot、工具与终态立即触发投递；后续相邻文本最多等待 20ms 的调度窗口。
事件循环繁忙或网络在途时，实际延迟可能超过这个窗口，不能把它当成端到端延迟承诺。
每批最多 50 条、64KiB envelope（单条超过 64KiB 时单独发送，仍受 journal 总大小限制）。
只有一个 flush 在途；历史队列继续保留在 journal 中，没有额外未持久化文本缓冲。

API 通过既有 v3 多消息 POST 投递，并以 POST receipt 的 localId/seq 和 GET 解密正文匹配
逐条确认。一页通常可验证整批；稀疏 seq 每次最多读四页。部分确认只提交确认子集，
其余仍保持相同 ID 等待核对。POST 成功但响应未知、读回不符、relay generation 改变、
12 秒确认等待超时都不视为发送成功。Relay 必须继续按 localId 幂等；不能换 ID 重放。
ACK 提交失败沿用宿主 fail-stop，重启读取原 journal 并核对相同 ID。
已核实 ACK 可以并入下一个原生帧/输入/控制事务；没有事务时用 20ms 定时提交。
运输 pump 等这次提交成功后才推进下一批，因此不会在内存确认后无界积累未落盘 ACK。

## SQLite 增量提交

原生帧仍同步持久化。运行中的 authority publisher 使用 `createHostedStorageWriter`，
只编码新增输出与发送状态改变的记录；inputs、controls 和小型 header 仍按当前状态编码。
输出正文及 localId 在接纳后冻结，发送状态通过受跟踪的 setter 更新，避免修改绕过缓存。
缓存只在完整事务提交和文件身份核对成功后推进；失败保留 dirty 记录，不能把未落盘 ACK
当作已确认。另一写者改变 generation、数据库被替换或 backend 改变时拒绝继续覆盖。

磁盘继续使用原来的 v1 records/metadata、UTF-8 字节上限和摘要格式。
历史输出的 SHA-256 前缀每 256 条缓存一次；追加与靠近尾部的 ACK 从最近前缀继续计算，
不重新编码已确认正文，也不查询全部历史行摘要。较早记录的 ACK 仍需重算其后的摘要，
但不重新编码这些正文。首次提交及重启重新建立缓存，成本仍随历史量增长。
行、header、authority revision 和 ACK 仍在同一个 `synchronous=FULL` 事务中原子提交。

JSON 会话继续使用原有快照写入，不自动转换存储；大 JSON 文件的完整写盘成本仍存在。
此次优化针对已有 SQLite runtime，不增加迁移 API。生命周期、清空和离线 stop 继续使用
完整快照边界；原 reader 可以直接读增量写入后的数据库。

## 隔离复现

从仓库根执行（Node 22 支持 `node:sqlite`）：

```sh
node packages/happy-cli/scripts/bench-hosted-stream.mjs \
  --output=/tmp/hosted-stream-results \
  --variants=deployed,candidate \
  --deployed-root=/absolute/current-happy-release --backends=sqlite \
  --history=23000 --count=64 --interval=1 --latency=5 --repeats=3
```

`storage-source` 缺省使用当前 checkout 的 Happy-owned 存储模块，也可显式提供兼容源码。
脚本不会读取真实 journal 或向真实 Relay 发消息。比较使用真实 Main、原生客户端、
publisher、加密 API 和 HTTP；只有认证接入/socket 元数据 ACK 为 fake。
两版 Main 接到同一存储模块：基线走完整快照，候选走正式增量 writer，保持相同磁盘格式。
兼容模块 hash、配置、每轮指标和进程日志保存在 output 中。
`--variants=deployed --deployed-root=/absolute/release` 可额外比较固定旧源码。

`--variants=candidate --history=0 --repeats=1 --fault=durable`、`--fault=post`、
`--fault=ack` 在临时子进程注入三个崩溃边界，然后以同一 journal/native thread 重启。
SQLite 只在新建的合成目录通过 pending marker 初始化，不调用存储迁移接口。
其中 post 故障只杀脚本刚创建的夹具子进程；不会查询、停止任何真实 producer。
验证最终 snapshot 正文、原有稳定 ID、唯一 Relay 行、同 thread/epoch、输入只派发一次。
fixture 的 native rollout 在通知前完整保存，证明的是此恢复契约下的行为，
不是对真实模型 rollout fsync 或线上所有崩溃形态的验收。

设置 `HAPPY_HOSTED_STREAM_STATS=1` 可在退出时记录提交次数/耗时、帧计数和运输计数、
队列峰值；默认关闭，不记录正文、token、密文或认证信息。生产灰度前必须保留现有
SQLite/authority/lifecycle 兼容模块与 reader；此改动不引入存储迁移或发布在线产物。

相关回归位于 `hostedDotStorageWriter.test.ts`，覆盖不再编码已确认历史、真实 authority
调用点、旧 reader/Unicode/摘要前缀、部分 ACK、事务失败重试、外来 revision、大小上限与
只读投影。性能和三个进程崩溃边界使用上面的真实 JSONL/加密 HTTP 夹具验证；
它们不能替代生产账号、真机或真实模型的验收。

2026-11-17 隔离验证：12 文件 263 项相关回归及 CLI 类型检查通过；SQLite 三个进程崩溃
边界恢复通过。实际 Chromium、隔离 Relay 和脚本 App Server 的 7 组聊天/流式/中断/
重启/清空/删除流程通过，页面、Console、非预期 HTTP 和清理错误集合为空。
隔离 Relay 在 SIGTERM 清理后重现既有 PGlite session-timeout 关停异常，信号前未出现，
Relay 退出码 0；这项现存问题保留，不将其表述为后端全程没有错误。

同机顺序对照两次：2.3 万条历史、约 13 MiB、64 个字符片段、模拟请求延迟 5ms。
尾段生成至本地模拟 Relay 收到终态的两次中位数从 9.31s 降到 4.12s，进程 CPU 从
9.11s 降到 1.53s；原正文、全部稳定 ID、唯一 Relay 行和输入只派发一次均核验通过。
仍有逐帧同步落盘成本；以上不是生产模型、手机渲染或真实网络的端到端延迟承诺。
上述验证在部署前完成；同日随后从提交 `2b6cc7da7` 部署 5 个 Dot 宿主，未迁移用户数据。
上线核对、维护失败记录和回退边界见[部署记录](../../DEPLOY.md)。

| 隔离验收节点 | 截图 |
| --- | --- |
| SQLite 流式聊天、清空后继续对话 | [查看](http://100.116.89.36:3210/img-bed/images/3d52e60c-b741-40f1-a272-428df1d61032.png) |
