# Dot 并行任务实现与验证记录

状态：可评审实现已完成，隔离纵向链路已验证；整体验证为**部分验证**。未部署、未 OTA、未更新全局 CLI、未重启实际 Worker/scanner、未推送或合入 main。真实手机、生产 Web/Relay、付费 Agent 和跨 OS 用户机器额度未验证。

## 源码、工作区与现状取证

- Happy 基线 `78c0f2d5`（`fork/main`），候选 `/home/dev/code/happy-dot-parallel-20261109`。
- TestLoop 基线 `4915e33`（`origin/main`），候选 `/home/dev/code/testLoop-dot-parallel-20261109`。
- 两候选分支均为 `feat/dot-parallel-20261109`。开始与结束都 fetch 核对 main；保留近期 memory move、Worker startup cleanup 和部署记录。两个原 main 工作区的既有暂存/未跟踪文件没有纳入本任务提交。
- 真实 managed Worker 只读回读仍为 PID `3309144`、active，systemd 的 `ExecMainStartTimestamp` 为 2026-11-09 08:23:26 +08；没有为测试切换这个 Worker。

原机制的代码证据（用基线 `git show` 复查，避免把改后已删除的 guard 当现状）：

1. `testLoop@4915e33:src/assistant-hosted-tasks.ts:66–72,200–210,237`：create/send/实际派发前调用项目独占检查；同会话已有非终态 send 时另抛 session_busy。
2. `src/assistant-delegation-contract.ts:123–139` 的原 `delegationProjectAvailable`：同 endpoint/machine/project 的 hosted 非终态及未完成 delegation/cleanup/followup 都阻塞，没有按实际最新 turn 或未发送回执释放项目 guard。
3. `assistant-hosted-tasks.ts:50–53` 的 `authorizeTarget`：当前 target 与冻结 target 摘要不一致即 authorization_changed。并行没有绕过该检查；具体旧会话哪项配置发生变化，本轮未确认。
4. `happy-agent/src/automation/rest/worker.ts` 原 scope 校验只接受批准 root path，`automation/control.ts` 的 session 校验又要求 journal 目录精确匹配。新实现以持久 root/grant/project→worktree 绑定扩展这条映射，并持续核验真实 cwd、Git common-dir、分支和基线，不直接批准任意新路径。
5. CLI `daemon/automationControl.ts` 的原 durable receipts 与 `observeOwnedProcess/observePersistedProcess` 保留；未知 PID/组/权限错误不能当 stopped。机器队列基于完整当前 turn、原回执和实际停止证明释放，不把 idle session PID 作为永久 busy。

本轮只读取证中，testLoop project ID 精确匹配 `dir_32ca73a83bc2f5cc8501116575a68032c63c460ec80c1b980c4cbf5d38abd175`；fe79a2ee-aab6-4d40-bc60-864715a4c5c6 为 blocked / WORKER_UNAVAILABLE / send not_sent，lastObservedProcess=unknown。它**足以触发原宿主逻辑 guard**。未证明它是唯一持锁者或还有真实执行；没有读取私人会话最新消息页，因此不把历史 running 当作当前状态。没有强行解锁、取消、重派旧任务或移动真实记忆。

## 验证命令与结果

Happy 使用 Node 22.22.0 / pnpm 10.11.0，TestLoop 依包内约定使用 pnpm 10.34.5。安装只用 npmmirror；没有改锁文件或发布包。

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Control 全相关子系统 | `pnpm --filter happy-agent exec vitest run src/automation --maxWorkers=1 --minWorkers=1 --reporter=dot` | 156/156，14 文件，0 跳过 |
| 实际 Git / 子进程 / HTTP 场景 | `pnpm --filter happy-agent exec vitest run src/automation/rest/parallelTasks.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot` | 17/17；包含准备阶段禁用 hooks 与迁移容量边界 |
| CLI 控制/启动/停止/环境 | `pnpm --dir packages/happy-cli exec vitest run --config vitest.automation.config.ts --reporter=dot` | 97/97，8 文件 |
| App / Web 共用 RN 事件与契约 | `pnpm --filter happy-app exec vitest run sources/components/dots/DotSessionContent.test.ts sources/sync/testloopDots.test.ts sources/components/dots/DotObservationPanel.test.ts sources/components/dots/DotsWorkspaceHome.test.ts --reporter=dot` | 65/65，4 文件 |
| 宿主队列 / 旧委派兼容 | `node --test --test-concurrency=1 test/assistant-delegation.test.mjs test/assistant-hosted-tasks.test.mjs` | 60/60，0 跳过；覆盖 queued、取消、原ID收敛与实际 SIGKILL/scanner 重接 |
| 宿主工作台相关 | `node --test test/assistant-hosted-tasks.test.mjs test/assistant-delegation.test.mjs test/assistant-dots.test.mjs` | 90/90；后续委派专门新增取消/崩溃用例单独复验 |
| 宿主核心/记忆保留 | `node --test test/assistant-hosted-tasks.test.mjs test/happy-control-client.test.mjs test/assistant-mcp-connections.test.mjs test/assistant-delegation.test.mjs test/assistant-dot-runtime.test.mjs test/assistant-memory-move.test.mjs` | 105/105；与其他行有重叠，不累计为独立用例总数 |
| 扩展 goal 回归 | `node --test test/assistant-goals.test.mjs test/assistant-goal-conversation.test.mjs test/assistant-delegation-feedback.test.mjs test/assistant-delegation-focus.test.mjs` | **47/48，1项失败，详下** |
| Happy shared/agent/CLI 构建 | `pnpm --filter @slopus/happy-wire run build`；`pnpm --filter happy-agent run build`；`pnpm --dir packages/happy-cli exec tsc --noEmit --pretty false`；`pnpm --dir packages/happy-cli exec pkgroll` | 已通过；构建日志含 bin 路径忽略和空 chunk 警告，不称日志无警告 |
| App 类型 | `pnpm --filter happy-app exec tsc --noEmit --pretty false` | 已通过 |
| 宿主前后端 | `pnpm run check`；`pnpm run build` | 已通过；编译与三个 Vite 页面构建完成 |

构建的命令数组、退出码和原日志存于两候选的 `.e2e-artifacts/dot-parallel-20261109/build-results.json`。原始测试日志、最终源码 SHA 清单同目录保存。以上是相关子系统验证，没有运行全仓测试、Expo 全量导出或原生构建。

### 保留的失败

扩展 goal 测试 `assistant-goal-conversation.test.mjs:161` 的 frozen V1 prefix 长度期望 12154，实际 12155。已在额外干净 worktree `/tmp/testLoop-parallel-baseline-20261109`、固定 `4915e33`、同依赖下编译并执行：

```sh
node --test --test-name-pattern='legacy frozen V1 turns' test/assistant-goal-conversation.test.mjs
```

基线同样失败为 12155 != 12154。未改该用例、预期字节/哈希或提示词实现来放行。这是已解释的主线已有失败，不能报告 goal 扩展或全仓全绿。

开发中出现的循环依赖加载、缺 shared dist/agent bundle、旧 submitted 断言、CLI 测试缺 @ 别名、异步夹具清理及人工高频轮询超时均保留失败日志，修复后按原业务断言复验。测试用轮询从2ms改25ms，线上配置未变；实际 Worker 扫描独立1秒节拍，授权保留在受理/开始/Git准备/真实副作用及返回边界，没有上调线上限流。一次执行观察窗口的 startedAt/deadline 分别取时产生1ms越界，已改为同一时间基准，未放宽24h上限。

## 场景与真实程度

17项用隔离 Git 仓库、真实分支/索引/工作树和实际 Node 子进程。执行夹具真的在工作树写文件并 git commit；释放 gate、kill/exit、主目录 dirty 文件和 HEAD 都是实际文件/进程行为：

- 同仓库两任务同时运行，各自提交不同文件；第三项先 queued，槽释放后自动启动；原主工作区内容、原 HEAD 和预存 dirty 文件不变。
- 同服务资源排他、独立资源并行、A+B 等待者不被 A/B 后来任务饿死；同 session 的后续输入未提前写入或 steer。
- 同 registration 多进程和不同 Worker owner 共用机器上限，别的 owner 不会把合法队列误标撤权失败。
- 同 requestID 幂等、冲突拒绝；实际消息写入后丢 ACK，再恢复原回执不多发第二条。
- queued 与 running 取消区分，停止未确认不释放；撤权后不启动；实际执行进程死亡不重跑；调度器 SIGKILL 后重接仍活的 session 进程。
- 旧 live turn 原子收养，超过100条的分页归约到最新 completed；已有 queued followup 不能遮蔽旧 running 占槽；idle PID 不永久 busy。
- 默认并发、非法/冲突配置、idle 才可改额度；有效密文中的非法 JSON 结构与损坏密文都失败关闭；旧执行迁移触及容量上限时拒绝写入，原账本仍可重新打开。
- 子目录/symlink 授权拒绝，dirty/失败现场保留；显式干净清理仍需真实 PID/进程组退出证明，保留分支。
- 慢 worktree 准备期间其他交办可受理，准备阶段不运行 checkout hooks；集成目录 dirty 时仅等待，不改用户文件、不阻塞独立工作树。
- 签名 loopback HTTP、owner consent、MCP工具映射、出站 HTTPWorkerRunner 与实际 Node/Git 夹具贯通；另有现有真实 SDK MCP→签名 REST 的协议回归。

宿主新增真实 `assistant-worker.js` SIGKILL→scanner 重启，只读恢复新 queue-blocked 的原回执；旧 blocked/not_sent 不进入该恢复条件。queued_canceled 有真实空闲会话，明确未派发，不伪报 stopped。

这些夹具不是真实 Codex/Claude/AGY 付费模型，不是生产 Happy Relay/手机验收。RN 事件检查 queued/waiting-resource/running/canceled 展示、branch/cwd 和“在对话中取消此工作”准确带入指定 ID，不自动假称后端已取消。没有执行本轮真实浏览器或真机验收。

## 支持边界与集成发布

实际支持 Linux/WSL、同一系统账号和同 machineID 账本内的机器总额度；普通进程/手工 shell 和不同 OS 用户不共享这份调度账本。Git worktree 不是权限沙箱。初版 eager create 会保留空闲会话，受理需要 Worker 在线；没有 lazy session、立即 steer 或自动空闲回收。

默认 legacy 串行，新代码任务显式 worktree；旧 goal/DAG 保守串行但正确识别新 queued 回执。read-only 必须继承可用的原只读权限；没有把并行切成 yolo。端口只分配互异建议值，需项目实际使用变量或声明固定资源。

结果带 baseCommit/branch/resultCommit/dirty，保留现场；completed 是 turn 结束，仍需业务验收。集成是另一个明确授权、repo 排他的任务，dirty 主目录会等待。无自动 merge/push/deploy。发布前先将两隔离提交审入各自 main，再按 [运行与发布说明](dot-parallel-tasks.md#集成发布顺序) 准备构建、核验身份/最近发布、协调备份队列/密钥/journal/worktree，依次升级 gateway/MCP、CLI/Worker、宿主和 App/Web；手机更新另按个人 preview 检查并授权执行。不能重启承载当前任务的 Worker 做上线试验。

## 变更文件

Happy：

```text
docs/api/automation-control.openapi.json
docs/features/dot-parallel-tasks-validation.md
docs/features/dot-parallel-tasks.md
docs/features/dots-mcp.md
packages/happy-agent/examples/rest-fixture.ts
packages/happy-agent/skills/happy-control/SKILL.md
packages/happy-agent/src/automation/control.ts
packages/happy-agent/src/automation/production/caller.test.ts
packages/happy-agent/src/automation/production/config.ts
packages/happy-agent/src/automation/production/production.test.ts
packages/happy-agent/src/automation/rest/directories.test.ts
packages/happy-agent/src/automation/rest/execution.ts
packages/happy-agent/src/automation/rest/fixtures/parallelTaskHarness.ts
packages/happy-agent/src/automation/rest/gateway.test.ts
packages/happy-agent/src/automation/rest/gateway.ts
packages/happy-agent/src/automation/rest/index.ts
packages/happy-agent/src/automation/rest/mcp.ts
packages/happy-agent/src/automation/rest/multiProject.test.ts
packages/happy-agent/src/automation/rest/openapi.ts
packages/happy-agent/src/automation/rest/options.test.ts
packages/happy-agent/src/automation/rest/parallelTasks.test.ts
packages/happy-agent/src/automation/rest/projection.ts
packages/happy-agent/src/automation/rest/schema.ts
packages/happy-agent/src/automation/rest/serviceTokens.test.ts
packages/happy-agent/src/automation/rest/store.ts
packages/happy-agent/src/automation/rest/taskQueue.ts
packages/happy-agent/src/automation/rest/taskScheduler.ts
packages/happy-agent/src/automation/rest/taskWorkspaces.ts
packages/happy-agent/src/automation/rest/worker.ts
packages/happy-app/sources/components/dots/DotSessionContent.test.ts
packages/happy-app/sources/components/dots/DotSessionContent.tsx
packages/happy-app/sources/sync/testloopDots.ts
packages/happy-cli/src/daemon/automationControl.test.ts
packages/happy-cli/src/daemon/automationControl.ts
packages/happy-cli/src/daemon/run.ts
packages/happy-cli/vitest.automation.config.ts
```

TestLoop：

```text
docs/features/dots-parallel-tasks.md
src/assistant-daemon.ts
src/assistant-delegation-contract.ts
src/assistant-delegation.ts
src/assistant-dots-view.ts
src/assistant-hosted-mcp-gateway.ts
src/assistant-hosted-tasks-contract.ts
src/assistant-hosted-tasks.ts
src/happy-control-client.ts
src/happy-control-mcp-client.ts
test/assistant-delegation.test.mjs
test/assistant-hosted-tasks.test.mjs
test/fixtures/hosted-happy-mcp.mjs
```
