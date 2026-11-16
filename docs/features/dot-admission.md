# Dot 本机维护准入 v1

`hostedDotAdmission` 是本机 OS owner 管理协议，不增加模型/MCP 权限，不改变业务 journal 或存储格式。绑定 directory/dot/session/epoch；私有配置、进程 PID/start/boot、operation ID、CAS revision 与最长一小时的 lease 共同限定请求。生产 runtime.lock 持有者才产生 ACK。

`requestHostedAdmission({directory,dotId,sessionId,epoch,operation:{id,action:'pause',expectedRevision,leaseUntil}})` 提交意图；`readHostedAdmission(binding)` 读 desired/status/supported/acknowledged。`draining` 表示现有 native turn 未结束，`paused` 表示已关闭新 dispatch/steer。Relay 用户输入与后台事件仍耐久保存，输出 ACK 与现有工具回执继续处理；不 abort 或取消独立业务 Agent。每次异步 binding 刷新后、真正 dispatch 前再次检查。

显式 `action:'resume',leaseUntil:0` 恢复；租约超时、崩溃或重启保持关闭，不能自动创建第二个 owner。相同 operation/参数重试只查询原意图；参数变化、revision/epoch 不符拒绝。历史最多64项，为 resume 预留最后一项；满额后拒绝新维护操作，不静默覆盖幂等证据。故障只读查询后由操作者处理，不删元数据强行放行。

旧 producer 没有能力声明，pause 必须返回 legacy_or_offline；不能把新磁盘 flag 当旧进程 ACK。用户明确允许决策 turn 中断时可走原来的正式 stop，保留 interrupted/unknown 与原 requestID，停止后确认 runtime.lock 可取得，才可用 `bootstrapStopped:true` 写 pause 意图。新 producer 持锁启动返回自己的 ACK 后再核验/显式 resume。此路径不重派未知请求、清空 thread/epoch、SIGKILL 或停止业务 Worker。

本机官方操作入口由 TestLoop `assistant-maintenance-cli.js` 提供，分别管理 scanner 和全量已登记 active runtime producers；两层准入不能互相冒充。需要保持已部署 SQLite、authority、lifecycle 兼容模块时，可以先只升级 TestLoop、保留旧 producer，使用受控冷停路径；此时 producer pause 尚未在线启用。代码测试不代表真实模型恢复 E2E 或线上 GC 已启用。
