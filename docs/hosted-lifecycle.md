# Hosted Dot 本地生命周期接口 v1

本接口把 hosted Dot 的私有文件协议收回 Happy。它是同机、可信配置的包导出，不新增 HTTP 服务、凭据、数据库或远端控制权限。

## 包入口

`happy/codex/hostedDotLifecycle` 同时导出 CommonJS 和 ESM。
`HOSTED_DOT_LIFECYCLE_VERSION === 1`。同步调用使用构建后的
`dist/codex/hostedDotLifecycle.cjs`，不能指向源码或 CLI 主入口。

基础 binding 为 `{ directory, dotId, sessionId }`。directory 必须是绝对、规范、非符号链接路径；配置与 journal 必须绑定同一个 Dot/会话。当前与 hosted producer 一样仅支持 Linux `/proc` 与 `flock`。

- `statusHostedDot(binding)`：同步、只读。返回 version、dotId、sessionId、running、owner、status、threadId、epoch、error、controls、pendingInputs、clearPending。不存在目录不创建文件；不返回用户输入/输出正文。
- `startHostedDot({ config, entrypoint, settings?, authFile? })`：同步提交启动，返回即时状态，不承诺已经 ready。config 使用既有 HostedDotConfig。Happy 自己验证配置、复制缺失的独占 Codex auth、发布 settings/config、启动宿主并绑定 PID/start/boot。已活跃进程不重复启动。
- `recoverHostedDot(binding)`：同步返回 `{ recovered, reason? }`。只允许既有可恢复错误 `hosted_start_or_recovery_failed` / `hosted_mcp_refresh_failed`，运行中、未确认输入、未确认 bootstrap 和未知错误不恢复。退避保留原 0/30s/120s/600s/1800s 阶梯。
- `stopHostedDot({ ...binding, requestId, action?: 'stop'|'delete', timeoutMs? })`：异步。默认 stop，默认 15s；不同未确认控制不会被覆盖，超时/锁冲突保留不确定性，不发强杀信号。
- `prepareHostedDotClear({ ...binding, requestId, epoch, codexHome })`：异步。epoch 必须为当前值加一，home 必须匹配配置。先持久化 clear fence 并撤销公开 input authority，再停止宿主并确认运行锁释放。失败保留 fence，可用同一请求重试。
- `clearHostedDot(同一个 clear request)`：同步。仅在调用方完成 Relay 会话轮换后调用。Happy 保留 epoch floor，清除自身 journal/config/control/events/recovery/bootstrap 与该独占 home 的 sessions/archived_sessions，保留认证和记忆。清理 receipt 先于 fence 解除；崩溃重试沿用原请求。
- `assertHostedDotStopped(binding)`：供配置切换使用。调用方须持有共享 launch lock 直到其配置提交；校验 producer 不活跃、无待处理 clear、runtime lock 可获得。它不负责主动停止。

## 所有权和安全边界

私有布局暂不改名、不迁移，以便旧版本兼容。正式消费者不应再解析或改写上述生命周期文件。start/recover/clear 使用 launch 与 runtime 锁；控制遵循 control→launch 顺序。写入使用限制大小的原子文件发布并同步父目录。所有读写拒绝符号链接，JSON 读取限制 32 MiB 并校验 inode/字节快照；PID 同时绑定启动时间和 boot ID。

公开 authority 读取在快照前后检查 clear fence，不能用 clear 前的 active 输入恢复授权。clear 不把 task-result 变成用户输入，不改变已发送副作用或执行任务的回执。

`running: false` 是可核对的宿主身份状态，不是任意原生子孙进程、远端任务或已经发送副作用全部终止的证明。stop 完成要求宿主不活跃且运行锁可取得；沿用现有 producer 的断开/终止语义，没有新增完整进程树证明。clear 是显式用户操作，不是容量压缩或自动维护手段。

## 验证

正式构建仍使用仓库既有 `pnpm --filter happy build`。包 exports 会让 pkgroll 生成新入口。本次隔离源码环境没有完整 monorepo 依赖，因此未声称该正式构建已通过。

新增的 `packages/happy-cli/scripts/build-hosted-lifecycle-test.mjs` 只为离线测试转译实际 State/Authority/Publisher/Lifecycle 模块，不替代 pkgroll/typecheck。它不调用 Happy 服务、真实 Relay 或模型：

```sh
node packages/happy-cli/scripts/build-hosted-lifecycle-test.mjs .hosted-lifecycle-test
node packages/happy-cli/scripts/hosted-lifecycle.test.mjs
```

测试涵盖重复启动、正常停止/超时、控制冲突、未知输入、退避、PID 复用、活跃 producer 与 owner 矛盾、孤立 runtime lock、clear fence、清理重试、权限边界、symlink 和保留 auth/memory。


## 2026-11-12：停止回执与终态派发快照修复

本次不需要升级 Relay 或手机 App，也不改 TestLoop 账本；更新 Happy CLI 源码构建后，按维护窗口使目标 Dot 的实际 entrypoint 使用新产物。不要仅凭仓库 HEAD 判断运行中的进程已经更新。

- 对已经停止的 Dot 调用 `stopHostedDot`，在 launch/runtime 锁下复查静止后，确认该 stop 控制。返回成功不会再留下一条永远无法消费的 pending stop。无首次 journal 的情况仅移除当前 stop；delete 仍保留永久启动隔离。锁尚未释放时仍失败，不伪造停止成功。
- 持久化前，将 `completed/failed/interrupted` 输入的 `beforeTurns` 历史数组压缩为空数组。空数组仍是原 v1 格式的“曾派发”标记；原 thread、turnId、输入正文、状态、权限及回执全部保留。`queued/dispatching/accepted/unknown` 快照不变，不因此重发或推断成功。
- 该修改消除历史 turn ID 每轮累积导致的平方增长，并在正常启动的首次持久化时处理可读取的旧 journal。它不删除输出或事件，不提高 32 MiB/输入条数/事件条数限制，不声称无限期容量。已经超过读取上限的 journal 仍 fail closed，需要另行在停写冷备后的受控恢复，不能直接清空文件。

### 本地验收

1. 停写后冷备，核对实际 Happy entrypoint/module 构建；独立测试 Dot 先验证，再逐个切换。
2. 对正常停止、重复停止（同 requestId 与新 requestId）、启动前未有 journal、进程在 stop 前退出分别验证 stop/start；delete 后 start 仍必须被拒。
3. 使用有已完成历史输入的测试 Dot，记录 thread/turn/seq；更新并重启，确认原 thread 恢复、没有重派，已终态 `beforeTurns=[]`，未决快照原样。
4. 在隔离数据上验证大量已完成输入的 journal 增长趋于线性；未知结果、运行中输入和失败落盘的 fail-stop 必须继续生效。
5. 源码测试：`pnpm exec vitest run --config vitest.hosted-authority.config.ts`；生命周期离线测试按本文现有 build/test 命令运行。离线 fixture 不代表真实 Relay/模型已验收。

v1 数据格式不变。回退到旧构建仍能识别空数组派发标记，但旧代码会重新累积快照。回退前先停写并保留最新账本，不使用旧备份覆盖后续输入。
