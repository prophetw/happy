# Worker 离线取证与启动失败恢复边界（2026-11-09）

本文保留发布前的原始取证和实现记录。随后经用户授权，系统 Worker 已切换到 `0d16e04d` 固定包，PID `3309144`；实际启动路径、连接、state/lock、心跳及会话存活已独立验证。发布事实、回退和未验证项见 [配套发布验收](memory-move-validation-20261109.md#配套发布验收2026-11-09)。底层机器校验失败原因及最早旧 state 来源仍未查明。

本次仅只读查询运行环境，在独立 worktree 形成代码补丁；没有重启 Worker、Docker、WSL 或升级服务，没有移动记忆、清理真实 daemon state/lock、重发旧任务或解除项目锁。以下时间均为 UTC+08:00。

## 可确认的故障链

| 时间 | 白名单证据 | 能支持的结论 |
| --- | --- | --- |
| 11-08 13:35:49 | 系统 Worker journal：`AUTOMATION_DAEMON_ALREADY_PRESENT`，栈指向 `assertNoAutomationDaemonState` | 当时已存在 daemon state；启动按保守策略拒绝。此前 state 的创建者和未清理原因没有查明。 |
| 11-08 13:35:52 | CLI PID 713 日志：`Daemon PID not running, cleaning up state`；`Daemon state file removed` | 此次普通 status 命令判定旧 PID 不存在并清理了旧 state。不是本次核查执行的动作。 |
| 11-08 13:36:00.439–.516 | PID 1242 日志五次 `deactivateSession failed`，均为 HTTP 502 | 同期 Relay 请求出现 502；不能据此确定现有机器查询失败的底层原因。 |
| 11-08 13:36:00.577 | PID 1242：`Daemon state written` | 此次 Worker 已创建自身 state。 |
| 11-08 13:36:00.579 | PID 1242：FATAL `AUTOMATION_EXISTING_MACHINE_UNVERIFIED`，退出码 1 | 现有机器校验失败，启动没有成功。 |
| 11-08 13:36:11 | PID 1982 再报 `AUTOMATION_DAEMON_ALREADY_PRESENT` | 前次失败留下的 state 再次阻止启动。代码的错误路径与日志顺序一致。 |
| 11-09 00:25:24 / :34 / :45 | PID 2416149、2418163、2420012 均报 `AUTOMATION_DAEMON_ALREADY_PRESENT` | 00:25:23 的手动 restart 未恢复 Worker。 |
| 11-09 00:41:23 | PID 2589143 日志：`Daemon started successfully, waiting for shutdown request`；journal 首次再次报告 `state=connected` | 实际恢复时间应以这次成功启动为准。恢复时采取的具体操作未核实。 |

原始日志位置仅列路径，不复制 Axios 请求对象或配置：

- `journalctl -q -u happy-automation-worker.service` 的上述时间窗口。
- `~/.happy/logs/2026-11-08-13-35-52-pid-713.log`。
- `~/.happy/logs/2026-11-08-13-36-00-pid-1242.log`。
- `~/.happy/logs/2026-11-09-00-41-22-pid-2589143.log`。

`getExistingAutomationMachine` 会把网络、HTTP、缺失机器或解密失败统一转换为 `AUTOMATION_EXISTING_MACHINE_UNVERIFIED`，没有保留底层分类。因此目前不能把失败归因于 Tailscale、某个 drop-in、具体 HTTP 状态、账号或密钥。不得根据同期 502 扩大结论。

代码中可确认的持续离线机制是：`run.ts` 先创建本地控制监听和写 state，再查询现有机器；原错误路径直接 `process.exit(1)`，没有释放本次启动的 state/lock。下一次启动只要看见 state 就拒绝。这是把一次启动校验失败转成持续离线的原因；最早那份旧 state 为何留下仍未查明。

## 当前恢复与稳定性核验

11-09 07:30:02 观测到：

- `happy-automation-worker.service` 为 `active/running`，`MainPID=2589143`，`NRestarts=0`，`Result=success`。
- daemon state 与 lock 均指向 PID 2589143；state 最近 mtime 距观测约 12.53 秒，`lastHeartbeat` 为 07:29:49。
- 07:30:20 对当前本地 daemon 的只读 `/status` 查询返回 HTTP 200、`connected=true`、CLI `1.2.5`，Relay 为既有 `/home-relay` 地址。
- 从 00:41:23 到 07:29 左右的可见 Worker journal，白名单汇总为 88,118 条 `connected`，没有 `unavailable` 事件。该事件在每次成功 poll 后上报，默认间隔 250ms；大量 connected 不是大量重连。

这确认当前进程、Relay 连接与控制面轮询已恢复；不能保证今后不会故障，也没有重放真实启动断网或线上崩溃。

`testloop-assistant.service` 与 `testloop-dot-recovery.service` 当前均为 active/running。`dot-recovery-upgrade-20261108.service` 在 11-08 22:38:34 因健康断言 `assistant_storage_metrics_unavailable` 退出，状态仍为 failed。该事件晚于首发故障约九小时，没有证据表明它导致 13:35 的故障，或足以解释 00:41 的恢复。

## 窄补丁与未解决边界

新增 `verifyManagedStartupMachine`，只包住现有机器的启动校验阶段。该阶段尚未创建 Relay 同步 client 或自动化 worker。校验失败时复用既有有界关闭流程，先确认本次 control listener 关闭，再依次执行已有的 `clearOwnedAutomationState`、`releaseOwnedAutomationLock`，并关闭凭据提供器和睡眠抑制。原错误仍抛出，成功路径保留 state/lock。

清理继续要求 state 的 PID/UID、state inode、锁的 PID/UID、原持有 FD 的 inode/device 与当前路径一致；他人 state、替换锁或未确认关闭的 listener 都保留所有权。没有放宽 `AUTOMATION_DAEMON_ALREADY_PRESENT` 检查，也没有自动抢锁或删除历史残留。

此补丁只解决该阶段失败留下自身 state 的问题。它没有覆盖所有启动阶段的崩溃/强杀，没有自动清理不明历史 state，没有增加身份校验重试，更没有绕过身份失败。

当前 systemd 为 `Restart=on-failure`、`RestartSec=10s`、`StartLimitBurst=3`、`StartLimitIntervalSec=5min`。即使部署此补丁，持续约三十秒以上、足以连续耗尽三次启动机会的依赖故障仍可能触发启动限速；限速后不会仅因依赖恢复就主动再启动。本次没有修改真实重试策略。后续若要求无人值守恢复，应独立评审更长退避/重试窗口和告警，保留身份及 owner 检查；不能通过自动删锁解决。

补丁尚未部署到实际 `/home/dev/.local/share/happy-automation/releases/persisted-stop-20261106`，也未重启当前执行通道。当前在线恢复不能归功于本次补丁。

## 隔离验证

在本次独立 worktree 复用既有依赖，使用不触发 CLI build/global setup 的 `vitest.automation.config.ts`：

```sh
vitest run --config vitest.automation.config.ts \
  src/daemon/automationBootstrap.test.ts \
  src/daemon/automationExistingMachine.test.ts \
  src/daemon/automationShutdown.test.ts --reporter=dot
tsc --noEmit --pretty false
git diff --check
```

结果：3 个测试文件、19 项通过；CLI TypeScript 检查通过；diff 格式检查通过。新增回归使用系统临时目录的真实 state 和原 FD 锁，验证校验失败后下一次可获取锁、成功时不清理、另一 PID state/替换锁不删除、control listener 关闭失败则保留所有权。没有读取测试之外的凭据或真实账本，没有进行线上故障演练。
