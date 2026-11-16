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

## 隔离复现

从仓库根执行（Node 22 支持 `node:sqlite`）：

```sh
node packages/happy-cli/scripts/bench-hosted-stream.mjs \
  --output=/tmp/hosted-stream-results \
  --storage-source=/absolute/reviewed/hostedDotStorage.ts \
  --baseline=51d4287c4c21fc59905f4bce442490ad48e864a4 \
  --variants=main,candidate --backends=json,sqlite \
  --history=23000 --count=64 --interval=1 --latency=5 --repeats=3
```

`storage-source` 是显式提供的 Happy-owned 存储兼容模块，仅用于临时合成目录。
脚本不会读取真实 journal 或向真实 Relay 发消息。比较使用真实 Main、原生客户端、
publisher、加密 API 和 HTTP；只有认证接入/socket 元数据 ACK 为 fake。
测试覆盖层将两版 Main 接到同一存储 reader/writer，以免把存储格式差异当作性能改善。
兼容模块 hash、配置、每轮指标和进程日志保存在 output 中。
`--variants=deployed --deployed-root=/absolute/release` 可额外比较固定旧源码。

`--variants=candidate --history=0 --repeats=1 --fault=durable`、`--fault=post`、
`--fault=ack` 在临时子进程注入三个崩溃边界，然后以同一 journal/native thread 重启。
其中 post 故障只杀脚本刚创建的夹具子进程；不会查询、停止任何真实 producer。
验证最终 snapshot 正文、原有稳定 ID、唯一 Relay 行、同 thread/epoch、输入只派发一次。
fixture 的 native rollout 在通知前完整保存，证明的是此恢复契约下的行为，
不是对真实模型 rollout fsync 或线上所有崩溃形态的验收。

设置 `HAPPY_HOSTED_STREAM_STATS=1` 可在退出时记录提交次数/耗时、帧计数和运输计数、
队列峰值；默认关闭，不记录正文、token、密文或认证信息。生产灰度前必须保留现有
SQLite/authority/lifecycle 兼容模块与 reader；此改动不引入存储迁移或发布在线产物。

SQLite 当前仍会全量编码与摘要比较每条历史记录，本次减少调用次数和线程饥饿，
没有改变磁盘格式，也没有将尚未通过恢复审查的 storage WIP 纳入主线。
后续若优化该成本，应单独提供兼容的增量提交接口及崩溃/恢复证明。
