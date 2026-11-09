# Dot 持久队列与机器级并行任务

本功能需要联合升级 Happy Control gateway、机器 Worker/CLI、Dot 宿主和 App/Web。源码实现不代表线上已启用；不自动修改现有服务或调度配置，不随任务完成自动集成、push、部署或 OTA。

## 受理契约

`happy_create_task` 只创建真实执行会话，不接收交办正文。`happy_send` 用稳定 requestID 持久受理未来轮次，先返回 `state=queued`、queueID 和真实 sessionID；有消息序号后才返回 `submitted`。二者都不表示执行完成。同会话的交办严格按受理顺序发送，等待期间不会 steer 正在执行的轮次。create 会启动空闲会话进程；并发限制计算活跃交办而非长期存活的空闲 PID。第一版没有 lazy session、立即 steer 或空闲会话自动回收。

创建示例（保持用户原 permissionMode，不能因并行提高权限）：

```json
{"requestID":"task-A-create","machineID":"approved-machine","projectID":"approved-project","execution":{"mode":"worktree","resources":[]}}
```

收到 confirmed 和真实 sessionID 后，另用 `happy_send` 发送完整需求、验收条件、允许修改的文件，以及“在任务分支提交并报告 commit，集成另行授权”。回执未知时先 `happy_request_status` 查询原 requestID；禁止换 ID 重派。相同 ID/内容返回原记录，内容冲突拒绝。

执行阶段为 queued、waiting-resource、preparing、running、canceling、completed、failed、cancelled；blocked 表示执行/回执证据不足，不是可自动重试的失败。宿主还保留 created、awaiting_user 和历史 canceled 拼写。业务验收独立于 Agent turn 完成。

## 隔离与资源

Worker 使用系统 Git worktree 和 Linux flock，复用既有 MetadataStore、Journal 和权限检查，没有引入新队列服务。工作树基于受理 create 时的 HEAD commit，保留 root projectID、grant 和目录绑定。准备阶段禁用 Git checkout hooks 和 fsmonitor，避免 create 阶段触发仓库脚本；不自动安装依赖、构建或执行交办。worktree/read-only 首版只接受授权 Git 仓库顶层目录；子目录项目明确返回 WORKTREE_REQUIRES_REPOSITORY_ROOT，避免把兄弟目录扩大进执行 cwd。路径必须规范化且 realpath 不变；每次执行校验 Git common-dir、分支及基线祖先。非 Git 只支持 legacy/integration，worktree/read-only 明确拒绝，不复制未知目录。

| mode | cwd | 默认资源 |
| --- | --- | --- |
| legacy（省略时） | 授权原目录 | machine 排他，保守串行 |
| worktree | 任务独立 worktree | machine 共享、repo 共享、session 排他 |
| read-only | 任务独立 worktree | 同 worktree，且原始权限必须为 read-only，Worker/daemon allowlist 仍须允许 |
| integration | 授权原目录 | machine 共享、repo 排他、session 排他 |

`resources` 为机器范围的排他名字，如 `service:relay`、`database:orders`、`port:3000`。不同项目/Dot 使用相同名字会串行；资源等待不会阻塞无冲突任务。ready FIFO，并防止后到的冲突任务饿死前面的等待者。集成任务应显式声明服务、迁移或 push 的资源；不声明资源的 shell 行为不受资源锁拦截。worktree 是文件隔离，不是权限沙箱。

每个 worktree 拥有独立索引和目录；不复制/链接 node_modules 或共享可写 dist。Worker 给创建会话提供独立 TMPDIR/TMP/TEMP、HAPPY_TASK_ID、HAPPY_TASK_PORT。任务需要自行显式使用端口变量，其他固定端口需声明资源；端口号是任务间互异的建议值，不保证不会被外部程序占用。包管理器可复用下载缓存，但应在本 worktree 安装/构建，包源遵循仓库 npmmirror 规则。

## 机器总额度与恢复

Worker 调度依赖 Linux/WSL 的内核 flock；其他平台未验证。生产机器账本固定在系统用户数据库所确定的 OS 用户目录 `~/.local/state/happy-control/machines/<sha256(machineID)>`，不依赖 Dot、grant、项目、工作目录、HOME 环境覆盖或 HAPPY_HOME。账本采用 AES-256-GCM；同目录 `.payload-key` 为本机0600密钥，需与密文一起协调备份。密钥丢失、密文认证失败或合法 JSON 结构损坏均拒绝启动，不能变成空队列。当前最多保留1000条任务、40MiB解密状态，不自动删除去重历史；到容量上限是存储故障，不能称已安排。注册配置 `registration.maxConcurrency` 默认为 2，范围 1–4（首版保守上限，保持现有限流配置；实际 HTTP 验证默认2，资源并行夹具另验证3）；同机各进程共用账本和同一 flock，冲突配置启动失败。未执行任务的 owner 就绪心跳为10秒，仅用于跨 Worker 的 FIFO/资源预留；绝不用它释放 active 任务或重派未知写入。跨机器或不同 OS 用户不共享账本。本功能不统计绕过 Worker 的手工 shell/Agent。

账本持久记录任务/request/session/worktree/branch/baseCommit/resource、dispatcher PID、真实会话 PID和派发状态。短同步事务持有内核 flock，无计时过期锁；claim 在启动前持久化，发送前另写不可自动重派标记。慢 checkout 先持久化 workspace preparing/baseCommit/preparationPID，再以异步 Git 和独立 workspace flock 创建；Git 继承锁fd，宿主死亡而 Git 尚活时不能启动第二次 checkout。它不占机器全局事务锁。create 回执尚未有会话时返回 pending 和真实任务入口；收敛到 confirmed 前不能 send，准备中断可查原回执后使用原ID恢复。调度器死亡后先查原 core/daemon 回执与完整分页消息；活会话重接，未知派发保留槽位与资源，不因 PID/租约超时重复执行。旧活跃 turn 以只读方式接管为 legacy 排他占用，完整读取到最新页；旧空闲 PID 和已完成 turn 不算永久占用。此迁移不重派任何旧任务。

新受理和每次真正执行都检查用户/机器/项目/grant/目录绑定；排队记录冻结原授权摘要，撤权、账号变化或权限目录变化不能继续派发。运行中失去读取授权时保留锁；本机 daemon 仍可独立证明进程停止后释放，但不会恢复远端权限。用户需从自己的机器会话入口确认/停止未知执行，不能直接改账本解锁。

回执 `executionDispatched=false` 明确证明交办尚未进入发送边界；不把“没有seq”单独当成未执行证据。completed 以所交办轮次结束且最新轮次没有正在执行为证据，允许保留空闲会话。失败/取消轮次还需进程确实停止，否则 blocked。queued 取消没有进程副作用；`happy_cancel.sendRequestID` 可只取消一个未来交办。running 取消先持久化意图、请求原 daemon 停止，再经独立 status 证明停止才释放。取消回执也持久化，可用原 requestID 查询。

旧宿主 blocked/not_sent（包括 fe79a2ee-aab6-4d40-bc60-864715a4c5c6）不会自动复活。旧记录和 memory move/Worker startup 成果均保留。新离线 create 仍可能返回 WORKER_UNAVAILABLE；第一版持久队列受理需要机器 Worker 在线，不能把未送达称为已排队。

## 保留、清理与集成

默认保留所有 worktree、分支、日志和改动。失败、取消、dirty 或停止证据不足时不清理。`cleanCompletedWorkspace` 只用于操作者明确请求的本机维护：所有关联任务 completed、Git status 完全干净、调用方提供真实进程停止证明，才允许 `git worktree remove`；不删除分支。completed 回执显示 resultCommit 和 dirty；没有新提交或仍有 dirty 不得称代码已按 commit 交付。保存目录、任务 ID 和分支即可由用户继续检查；不能重放未知副作用任务作为“恢复”。

integration 在开始执行前检查授权原目录的 Git status；含暂存、未暂存或未跟踪改动时保持 waiting-resource/integration_worktree_dirty，不发送执行指令，其他独立 worktree 可继续。集中集成要作为另一个明确授权的 integration 任务排队：核验最新 main 与远端，确认集成工作目录干净，依次 merge/cherry-pick 各任务 commit；冲突保留并处理，运行组合验证。未获 push/发布授权时只交付集成分支。禁止覆盖带未提交修改的主目录、盲推 main 或把所有 completed 自动部署。

## 集成发布顺序

1. 审查并集成两仓库独立提交到各自个人 main；fetch 核对远端并保留最近记忆移动、启动清理和已有发布配置。本文不授权合并/推送/发布。
2. 在隔离发布目录构建 happy-wire、happy-agent、CLI、宿主及 App/Web；准备所有候选产物，再选维护窗口。不能重启正在执行本任务的 Worker 来测试。
3. 核验机器身份与 root/grant 绑定，协调保存宿主账本、Worker journal/receipts、新机器队列及 worktree。配置 maxConcurrency 必须一致。改变额度时先停所有相关 Worker，确认没有未终态任务，使用旧额度打开 TaskQueue 并调用 configureConcurrency(新值)，再以新注册配置启动；禁止绕过 QUEUE_IN_USE。
4. 先升级 gateway/MCP（新增 worker/authorize 与执行/取消字段），再升级已构建的 CLI/Worker，再切换宿主和 Web；手机沿既有个人 preview 流程另行授权 OTA/原生发布。旧 gateway 不支持队列权限复查时，新 Worker 保留排队而不执行，不能降级跳过授权。
5. 用新授权的专用测试项目验证 queued/submitted/运行/取消与机器总额度，检查会话实际 cwd 和组合功能。不要重新派发历史需求。
6. 回滚前停止受理、确认活任务状态并协调备份；旧宿主不能解析新状态，旧 Worker 不认识新队列和 worktree 授权，禁止直接覆盖账本或丢弃排队任务后降级。

验证结果和边界见 [实现验证记录](dot-parallel-tasks-validation.md)；真实手机接收、线上升级、付费模型、任意外部 shell 的资源遵守均不能由隔离夹具代替。

旧 goal/delegation 入口继续采用原保守串行策略和预算，本轮没有改写其 DAG 规划器；它已能持久识别 queued、按原ID恢复回执。新 queue-blocked 的只读恢复有专门 scanner 条件，绝不放开历史 blocked/not_sent。queued_canceled 与旧 not_dispatched 分开：前者有真实空闲 session、明确 executionDispatched=false，不能宣称进程已停止。
