# Dot 持久队列与项目级并行任务

本功能涉及 Happy Control gateway、机器 Worker/CLI、Dot 宿主和 App/Web。2026-11-10 的自主推进调整已按授权发布到本机 Worker、Control、Dot 宿主/恢复服务和私网 Web，功能源为 Happy `dcb5150a`、TestLoop `389a939`；手机 App 的本次提示更新尚未发布 OTA。任务派发本身不自动修改服务或调度配置，不随任务完成自动集成、push、部署或 OTA。

## 受理契约

`happy_create_task` 只创建真实执行会话，不接收交办正文。`happy_send` 用稳定 requestID 持久受理未来轮次，先返回 `state=queued`、queueID 和真实 sessionID；有消息序号后才返回 `submitted`。二者都不表示执行完成。同会话的交办严格按受理顺序发送，等待期间不会 steer 正在执行的轮次。create 会启动空闲会话进程；并发限制计算活跃交办而非长期存活的空闲 PID。第一版没有 lazy session、立即 steer 或空闲会话自动回收。

创建示例（保持用户原 permissionMode，不能因并行提高权限）：

```json
{"requestID":"task-A-create","machineID":"approved-machine","projectID":"approved-project","title":"修复会话列表标题","execution":{"mode":"worktree","resources":[]}}
```

收到 confirmed 和真实 sessionID 后，另用 `happy_send` 发送完整需求、验收条件、允许修改的文件，以及“在任务分支提交并报告 commit，集成另行授权”。回执未知时先 `happy_request_status` 查询原 requestID；禁止换 ID 重派。相同 ID/内容返回原记录，内容冲突拒绝。

create 的可选 `title` 是去空白后1–200字的初始展示标题，不代替 send 正文，也不改变权限、worktree/branch ID 或执行资源；它属于该 create 的幂等负载。Worker 只从已授权项目派生 origin root，在创建调用内将标题、root 和任务 ID 传给 CLI，写入加密会话的 `happyTask` 元数据，不改变 Worker 队列持久结构。App/Web 据此把外部 worktree 归到原项目下，以实际执行 path 区分工作区；现有 summary/change_title 重命名优先于初始标题。真实 `metadata.path` 始终是执行 cwd，resume/reconnect 保留该扩展。缺少此元数据的旧会话仍按原路径显示，不猜测或迁移其归属。该展示能力不改变下述保留和清理策略。

执行阶段为 queued、waiting-resource、preparing、running、canceling、completed、failed、cancelled；blocked 表示执行/回执证据不足，不是可自动重试的失败。宿主还保留 created、awaiting_user 和历史 canceled 拼写。业务验收独立于 Agent turn 完成。

## 自主推进与资源（2026-11-10）

Worker 使用系统 Git worktree 和 Linux flock，复用既有 MetadataStore、Journal 和权限检查。明确需要相互独立且同时启动的写任务时，调用方选 `worktree`，受理 create 时冻结可独立开发的已提交 HEAD。普通写入用原目录，后续追问向原 session 发送新轮次。准备阶段禁用 Git checkout hooks 和 fsmonitor。Git 候选和 worktree 以授权的 Git 仓库顶层为项目边界。路径身份使用 canonical realpath 和 Git common-dir。

分配的分支名（`dot-task/<workspaceID>`）只是创建时的名字，不是分支锁：任务可以按自己的要求在仓库内新建、改名或切换分支并在那里提交，只要记录的 `baseCommit` 仍是 HEAD 的祖先，交付内容就仍然可达。`execution.branch` 始终报告创建时的分配名，`workspaceBranch()` 才返回实际检出的分支，避免把审阅者引到任务已经离开的分支。两种切换会被拒绝为 WORKTREE_BINDING_CHANGED：detached HEAD（没有任何可 fetch/审阅的分支），以及切到 root 检出目录当前所在的分支（只有 `checkout -f -B` 能绕过 Git 自身的占用保护，此时等于改写用户分支，不能静默继续）。改动背景见 2026-11-10 的 Console 修复会话：任务在 worktree 内 `git switch -c fix/console-tag-thumbnail-crash` 完成后，旧校验把每次观察都判为 403，任务只能停在「执行中 + 原始错误码」直到进程结束。

| mode | cwd | 默认资源 |
| --- | --- | --- |
| legacy（省略时） | 授权原目录；可接续已有未提交改动的开发和测试 | machine/repo 共享、实际 checkout 排他、session 排他 |
| worktree | 任务独立 worktree | machine/repo 共享、实际 checkout 排他、session 排他 |
| read-only + `candidate.kind: commit` | 会话临时目录，通过完整提交 ID 读 Git tree、diff 和 blob | 指定项目与会话，另计声明资源 |
| read-only + `candidate.kind: checkout` | 执行者同一目录，包含未提交和新增文件 | 共享原 checkout、会话排他及声明资源 |
| read-only + `candidate.kind: test` | 指定提交的临时 detached checkout | 独立 checkout、会话排他及声明资源 |
| integration | 授权原目录；保留未提交改动 | machine/repo 共享、实际 checkout 排他、session 排他 |

`resources` 为机器范围的排他名字，如 `service:relay`、`database:orders`、`port:3000`。不同项目/Dot 使用相同名字会串行；资源等待不会阻塞无冲突任务。ready FIFO，并防止后到的冲突任务饿死前面的等待者。集成任务应显式声明服务、迁移或 push 的资源；不声明资源的 shell 行为不受资源锁拦截。worktree 是文件隔离，不是权限沙箱。

新建 `read-only` 会话须选定 `candidate`，并经 Worker 与 Agent 核实 `read-only` 权限。提交审查使用 `{ "kind": "commit", "commit": "<完整提交 ID>", "baseCommit": "<可选完整基线 ID>" }`。Worker 冻结 commit 和 tree，发送时附上限定对象的 Git 命令。缺失对象返回 `CANDIDATE_UNAVAILABLE`。已有只读工作树仍按其原记录核验。

原目录验收时，执行侧在 create 声明 `execution.handoff: true`。Worker 以终态轮次中的 HEAD 和实际文件生成 `checkoutDigest` 并保留该 checkout。验收侧用 `{ "kind": "checkout", "requestID": "<执行 send 的原请求 ID>", "digest": "<回执 checkoutDigest>" }` 创建独立会话。内容在派发前和验收轮次结束时均核验，变化返回 `CANDIDATE_CHANGED`。验收结束释放 checkout，较早排队的写任务继续。取消已完成的指定执行交办可释放其待验收保留。

需要在固定提交独立跑测试时，使用 `{ "kind": "test", "commit": "<完整提交 ID>", "command": "<实际测试命令>" }`。脱离分支的测试目录随执行进程组停止、Git 检出干净且工作区为空闲后清理。存在未提交、未跟踪或被忽略的产物时保留目录，并在回执中给出清理结果。只有绑定轮次中、在候选目录执行的指定 Codex 命令有实际退出码时，回执才提供 `testResult`。

每个 worktree 拥有独立索引和目录；不复制/链接 node_modules 或共享可写 dist。Worker 给创建会话提供独立 TMPDIR/TMP/TEMP、HAPPY_TASK_ID、HAPPY_TASK_PORT。任务需要自行显式使用端口变量，其他固定端口需声明资源；端口号是任务间互异的建议值，不保证不会被外部程序占用。包管理器可复用下载缓存，但应在本 worktree 安装/构建，包源遵循仓库 npmmirror 规则。

## 项目额度、可选机器上限与恢复

Worker 调度依赖 Linux/WSL 的内核 flock；其他平台未验证。生产机器账本固定在系统用户数据库所确定的 OS 用户目录 `~/.local/state/happy-control/machines/<sha256(machineID)>`，不依赖 Dot、grant、项目、工作目录、HOME 环境覆盖或 HAPPY_HOME。账本采用 AES-256-GCM；同目录 `.payload-key` 为本机0600密钥，需与密文一起协调备份。密钥丢失、密文认证失败或合法 JSON 结构损坏均拒绝启动，不能变成空队列。当前最多保留1000条任务、40MiB解密状态，不自动删除去重历史；到容量上限是存储故障，不能称已安排。注册配置 `registration.projectConcurrency` 默认 2；`registration.machineConcurrency` 默认 null（没有隐式全机上限），均接受正整数，不再限制最大 4。同机各进程共用账本和同一 flock，冲突配置启动失败。项目身份由可信路径的 realpath / Git common-dir 确定；同仓库的不同项目 ID、Dot、grant、Worker、授权 worktree 均共用项目额度。项目等待不占其他项目名额，机器硬上限若配置则统计所有项目。未执行任务的 owner 就绪心跳为10秒，仅用于跨 Worker 的 FIFO/资源预留；绝不用它释放 active 任务或重派未知写入。跨机器或不同 OS 用户不共享账本。本功能不统计绕过 Worker 的手工 shell/Agent。

配置示例（Worker 与 host 的对应 registration 保持一致）：

```json
{
  "projectConcurrency": 2,
  "machineConcurrency": null,
  "projectConcurrencyOverrides": { "/trusted/repo-a": 3 }
}
```

覆盖配置的路径在 Worker 启动时转成 canonical Git common-dir / 非 Git root；同仓库别名不能获得第二份名额，别名配置冲突拒绝启动。覆盖策略也持久化并跨进程核对。机器资源保护例如 machineConcurrency=6 是独立配置。不同项目普通 create/send 无需用户手写 execution 即可并行；同项目代码写入并行须用独立 worktree/session。默认继续原目录，保留已有改动；legacy/integration 不再要求派发时 Git status 干净。所有已知项目以 canonical repo 统计名额，写入互斥收窄到实际 checkout；同仓原目录和独立 worktree 可同时推进，同一目录的写入仍排队。服务、数据库、发布与维护按实际共享对象声明命名资源，不因同仓就默认阻止独立任务。锁是调度约束，不是安全沙箱。

回执/UI 分开显示 project-limit（本项目名额）、machine-limit（机器硬上限）、resource-wait（排他资源），另保留 session_turn 等顺序/恢复原因；创建空闲 session 不占执行槽。旧全局排他 turn 在缺乏归属证据时保留；取得原进程/turn强证据后可收窄自动租约。新受理普通交办按真实checkout调度。

旧会话通过 daemon 已持有的会话记录发现。本机进程所有者能确认退出的会话不参与新的执行接管，原有租约仍按历史核对其轮次结果。其他会话完整读过历史后才接管仍在运行的 turn。每个旧会话只保留一项在途读取，已经知道的 checkout 和声明资源在核对时仍受保护。任务派发与各自的回执收集独立推进。`legacy_observation` 表示当前任务等待相冲突的旧会话核对，`candidate_review` 表示在等原 checkout 的验收结束。回执的资源名称来自本任务的资源声明，会话链接按授权和 Dot 所属范围显示。

账本持久记录任务/request/session/worktree/branch/baseCommit/resource、dispatcher PID、真实会话 PID和派发状态。短同步事务持有内核 flock，无计时过期锁；claim 在启动前持久化，发送前另写不可自动重派标记。慢 checkout 先持久化 workspace preparing/baseCommit/preparationPID，再以异步 Git 和独立 workspace flock 创建；Git 继承锁fd，宿主死亡而 Git 尚活时不能启动第二次 checkout。它不占机器全局事务锁。create 回执尚未有会话时返回 pending 和真实任务入口；收敛到 confirmed 前不能 send，准备中断可查原回执后使用原ID恢复。调度器死亡后先查原 core/daemon 回执与完整分页消息；活会话重接，未知派发保留槽位与资源，不因 PID/租约超时重复执行。旧活跃 turn 以只读方式接管为 legacy 排他占用，完整读取到最新页；旧空闲 PID 和已完成 turn 不算永久占用。此迁移不重派任何旧任务。

新受理和每次真正执行都检查用户/机器/项目/grant/目录绑定；排队记录冻结原授权摘要，撤权、账号变化或权限目录变化不能继续派发。运行中失去读取授权时保留锁；本机 daemon 仍可独立证明进程停止后释放，但不会恢复远端权限。用户需从自己的机器会话入口确认/停止未知执行，不能直接改账本解锁。

回执 `executionDispatched=false` 明确证明交办尚未进入发送边界；不把“没有seq”单独当成未执行证据。completed 以所交办轮次结束且最新轮次没有正在执行为证据，允许保留空闲会话。失败/取消轮次还需进程确实停止，否则 blocked。queued 取消没有进程副作用；`happy_cancel.sendRequestID` 可只取消一个未来交办。running 取消先持久化意图、请求原 daemon 停止，再经独立 status 证明停止才释放。取消回执也持久化，可用原 requestID 查询。

旧宿主 blocked/not_sent（包括 fe79a2ee-aab6-4d40-bc60-864715a4c5c6）不会自动复活。旧记录和 memory move/Worker startup 成果均保留。新离线 create 仍可能返回 WORKER_UNAVAILABLE；第一版持久队列受理需要机器 Worker 在线，不能把未送达称为已排队。

## 保留、清理与集成

### 会话密钥过期与进程核验（2026-11-17，已部署）

会话密钥的 14 天保留期不再决定队列能否核验旧进程。daemon 启动时、持久会话写入前，将本机 daemon 启动记录的最小字段保存到 `<sessionsFile>.processes/<sha256(sessionID)>/`：sessionID、machineId、hostPid、savedAt 和原 daemon 启动标记，不保存密钥、正文或路径。复用现有私有 MetadataStore，目录 0700、文件 0600；每次启动代次独立、原子写入，旧版本会话继续重写 `sessions.json` 不会删除这些记录，迟到旧记录也不能覆盖新绑定。相同时间但不同身份、损坏或不安全权限均拒绝核验。

状态读取仍由原 `observePersistedProcess` 检查机器绑定、启动时间与当前 PID/进程组；只有启动早于本次开机，或 PID 和进程组均为 ESRCH，才确认 stopped。活 PID、残留组和权限错误保持 unknown，不新增停止或重发权限。队列在旧会话已无法解密/列出时，仍能直接向绑定机器查询原 session 的停止状态；确认后按既有 `execution_stopped` 归约，保留原任务、请求、资源和失败历史，后续任务继续原队列。

发布与回滚备份必须同时包含 `sessions.json.processes/`、原会话文件、机器队列及其密钥。进程记录不跟随会话保留期自动删除；旧可执行程序可以忽略该目录，但回滚不能删除新记录或恢复旧账本覆盖新任务。首次更新前已丢失且没有可核对备份的记录仍会 unknown，不能用猜测补造 stopped。

部署验收除 connected/ready 外，须核对所有未终态的 `machine/exclusive` 占用、原排队任务的 reason/seq/派发状态；重启 Worker 后再次核对。真正存在的目录或命名资源占用仍需等待，不能为了清除提示而取消其他工作。

### Happy Dot 服务更新指南

本机 WSL 把 `/home/dev/.happy` 交给 `happy-automation-worker.service` 管理。这个进程同时提供普通 Happy 会话和 Dot 派发。全局 CLI 与 Worker 各有固定入口，更新时须分别核对。

开机清理复用系统的 `systemd-tmpfiles-setup.service`。将 `deploy/automation/happy-automation-worker.tmpfiles.conf` 安装为 `/etc/tmpfiles.d/happy-automation-worker.conf`，其中两条 `r!` 规则在早期开机阶段移除上次留下的 daemon state 和 PID 锁。安装到运行中的宿主只复制规则，真实 home 上的 `--remove --boot` 会移除当前持有者的文件。可用 `node --test deploy/automation/worker-boot.test.mjs` 在临时根目录验证两种模式。

将同目录的 `happy-automation-worker-boot.conf` 安装为该 Worker 的 `service.d/50-boot-recovery.conf`（完整目录为 `/etc/systemd/system/happy-automation-worker.service.d/`），执行 `systemctl daemon-reload`。Worker 在开机清理后即可取得 Happy home 的 PID 锁，Docker 可以同时启动。Relay 的 HTTPS 连接暂时中断或网关返回 502/503/504 时，同一 Worker 持续持锁，每 5 秒重试当前未完成的机器记录或账号读取。旧 CLI 可通过本地 `/list` 识别持有者。机器和账号均通过验证后才连接 Relay 并开放本地会话操作，等待期间会话操作返回 503。认证被拒、证书不受信任或机器记录无效时，Worker 按原流程退出，由 systemd 每 30 秒重新启动。用 `systemctl show happy-automation-worker.service -p After -p RestartUSec -p StartLimitIntervalUSec -p StartLimitBurst` 和本次启动日志核对配置与实际持有者。

开机验收包括受管 PID 与 state/lock 一致、原机器连接、签名轮询和原 Dot 授权的 `happy_options`。若实际派发仍为 `waiting-resource`，用 `scripts/check-worker-queue.mjs` 核对占用；普通 daemon 交接来的活会话可用切换前登记、冷备和当前进程身份补齐其任务归属证明。

会话恢复后，Relay 可能仍保留原 PID。调度器用它关联已登记的 turn 和队列记录。校验当前进程时，Worker 从同一会话、机器和目录的本机 daemon 启动记录读取 PID，并复核 Linux 启动标识、进程启动时间、用户、目录和进程组等身份信息。这样 Worker 交接时可以保留真实的目录占用，其他项目也能继续派发。

这次修复覆盖会话保留期、旧版本会话写入和 Worker 重启导致的停止证据丢失。它不保证所有 resource-wait 都消失：真实目录/命名资源冲突、未确认的存活进程、撤权、存储损坏和修复前已丢失的记录仍需分别处理。

1. **确定实际更新对象。** 仅改 Worker/调度时只切 Worker，不顺带停 Dot producer、宿主、Relay 或 Web。用 `systemctl show happy-automation-worker.service -p MainPID -p ExecStart -p DropInPaths -p KillMode` 核对实际 release，不能从源码目录或 CLI 版本号推断。保留 `KillMode=process`，独立业务会话继续运行。
2. **发布前保存状态。** 同一 OS 用户运行下面的只读检查，把结果存入私有发布目录。逐项核实整机排他、blocked/未知进程、原排队 requestID/sessionID/seq；已存在的真实占用应记录预期，不用改锁掩盖它。若有无法解释的整机排他，先调查，不能把它带过发布验收。

   ```bash
   node scripts/check-worker-queue.mjs \
     --config /etc/happy-control/worker.json \
     --runtime /absolute/path/to/actual-release \
     --require-no-global-holders > /private/release/queue-before.json
   ```

   检查只读机器账本，不输出任务正文或凭据；退出码 0 表示读取成功且严格模式无整机排他，2 表示仍有整机排他，1 表示读取/配置失败。0 不代表业务任务全部结束，必须阅读 waiting/uncertain 及其 blockers。
3. **准备可回退的固定产物。** 从当次 fetch 一致、干净的个人 main 构建；验证本次相关测试及 CLI 内联依赖。保存实际 argv、PID/startTicks、配置与 drop-in 哈希，以及存活业务会话的 PID/startTicks/cgroup。候选文件名必须排在现有覆盖配置之后，并在启动前检查最终生效 argv。
4. **由独立维护单元切换。** 使用经过审阅的现有 Worker 发布协调器，正常停止旧 Worker，确认 daemon owner/lock 释放。保持业务会话不被终止；停写段备份 Worker journal/receipts、机器队列和 `.payload-key`，同时保存 `sessions.json` 与 `sessions.json.processes/` 的一致快照和哈希。活跃 worktree 保留原位，不把活动目录叫冷备。快照发生变化或校验失败则停止切换并恢复原入口，不能跳过备份。用新不可变 release/drop-in 启动，保留所有原请求与当前数据。
5. **验收恢复能力。** 核对新 PID/真实入口/哈希、Control connected、原业务会话身份不变，确认最小进程档案已从原会话注册表初始化。再次执行上面的队列检查（runtime 换成新 release），逐原 ID 对比；等待至少一个实际调度/收集周期，原排队任务应开始或显示可解释的真实 blocker，不能新增不明的 machine/exclusive。观察健康日志中的 unavailable、Exception、FAILED；错误必须解释或回退。不能用新 requestID 重发来“验收恢复”。
6. **升级/重启的专项验证。** 发布回归必须覆盖旧密钥过期并被旧 CLI 写入删除、Worker 重建后 owner status 可查、PID/组仍活及权限错误时不放行、停止后原消息只发送一次。生产可以用自然排队的原任务验证；无合适任务时使用隔离实际子进程测试，不为验收发未经用户交办的付费模型任务。
7. **需要回退时只退可执行入口。** 先保存最新账本和进程档案，核对旧 reader 能读当前格式，再由独立协调器撤销本次所属 drop-in。保留新消息、回执、进程档案与 worktree，不用发布前备份覆盖上线后的数据。回退后重复状态与原任务验收。

遇到本文提示时，先看只读报告：`globalHolders=[]` 而 waiting.blockers 指向同 checkout/命名资源，通常是正常等待；有历史 legacy 整机占用时，核对原 machine/session/PID/启动时刻和当前内核证据。修复前记录已被删掉时，只能使用可验证的原备份或原 owner 状态做受限归约，并保留证据；没有证据就保持 unknown，不删锁、不伪造 completed、不取消别人的真实工作。scanner/producer 也需要更新时，另遵循 TestLoop 的 `docs/features/dot-maintenance-admission.md`：先取得各自 pause ACK，切换后只 resume 本次持有的 pause，不能把 scanner 暂停当成所有输入已冻结。

默认保留所有 worktree、分支、日志和改动。失败、取消、dirty 或停止证据不足时不清理。`cleanCompletedWorkspace` 只用于操作者明确请求的本机维护：所有关联任务 completed、Git status 完全干净、调用方提供真实进程停止证明，才允许 `git worktree remove`；不删除分支。completed 回执显示 resultCommit 和 dirty；没有新提交或仍有 dirty 不得称代码已按 commit 交付。保存目录、任务 ID 和分支即可由用户继续检查；不能重放未知副作用任务作为“恢复”。

派发不再把原目录的暂存、未暂存或未跟踪改动作为拒绝条件。`integration` 保持原请求、原会话、原 cwd，不自动 stash/reset/commit，也不替换用户文件。实际 merge/push、测试服务操作由执行 Agent 按原授权和具体文件冲突处理；派发器不通过“清空工作区”解决问题。

升级时只将精确匹配旧版自动生成格式的仓库租约收窄到 checkout。托管 workspace 校验原 Git 绑定；旧会话交办另核对原授权与目录；旧 live turn 仍需真实进程所有权和原 turn/seq 证据。保留 requestID、session、dispatch 标记及全部命名资源。显式机器维护、身份变化、未知归属和被修改的租约不被盲目放宽。原队列可原地继续，不通过取消/新建任务恢复。

回执 `recovery` 说明等待哪个工作目录/命名资源、能否自动继续；同 grant 可显示占用执行会话，其他 grant 仅显示资源原因，不泄露其会话身份。仅确认的停止或结束才释放实际执行租约；未知写入继续核对原请求，不自动重发。

宿主临时读取失败保留最后确认的 queued/running 等执行状态；尚未确认的执行显示 observing。24小时/10000次检查是滚动观察窗口，达到后续期，不将任务改为永久 blocked。仍有原回执/会话可查的历史观察到期记录可恢复只读跟踪；从未发送且没有可观察对象的历史记录保持，不凭此复活旧任务。

已保存正文的 send 若原 mutation 明确证明 not_sent，且仅因执行端/传输暂不可用而失败，宿主按原 requestID 自动重试。它重新检查原授权、原生输入身份、epoch 和权限；较新用户消息、取消、清空或撤权会拦住重试。仅创建会话的 create 不会凭空补造交办正文，unknown 写入绝不进入此重试。每轮发送持久化独立 attempt ID，只有该轮拥有者可更新结果，防止并发失败回执把另一轮正在发送的请求降成 not_sent。

资源等待、状态待确认、暂时读取失败及恢复推进通过原有 HostedTaskEvent 通知 Dot。原因未变时去重，恢复后通知一次；事件 ID 继续为 task-加64位摘要，保持现有原生消费者兼容，事件仍是只读回报，不构成创建其他任务的授权。

## 集成发布顺序

### 派发、崩溃与容量的隔离验收

Control 按授权和 requestID 登记命令摘要。Worker 领取前，Control 先持久化领取编号。超时撤回与领取共用原有独占网关。撤回后才签发含原 requestID、`safeToRetrySameRequestID`、`worker_not_reached` 的回执。已领取、旧格式记录或存储结果不确定时，重复写入转为查询原回执。撤权、越权与有效载荷冲突继续拒绝。新登记的摘要带协议前缀，旧 Control 对这些 ID 的写入会报 `REQUEST_ID_CONFLICT`，仍可读取已有回执。

现场 Control `d5e0adc87` 的服务凭据记录早于 `lastUsedAt` 字段。它会拒绝打开含该字段的新版账本。隔离验收同时检查原样回读的结果，并在单独副本中使用切换前的测试凭据记录核验旧写入者对原 ID 的保护。

Linux 受管 Worker 在原 PID 锁旁记录本次开机、PID 命名空间、进程启动时刻和锁的设备号及 inode。同一次开机重启时，只有确认原 PID 已消失、状态属主与锁一致，启动者才可在独占 flock 内接管。PID 已复用、仍活跃或旧锁缺少身份信息时保留原文件。

机器队列最多接受 1000 条活跃任务，blocked 占名额，completed、failed、cancelled 保留在原加密账本供去重和迟到回执使用。TestLoop 宿主还有每工作区 1000 条任务、5000 条操作的独立总量限制。旧 Worker 读取超过 1000 条记录的新版账本会拒绝打开，回退前须核对账本兼容性并保留新写入。

候选绑定和测试证据沿用 V2 队列的工作区扩展字段，在同一次加密落盘里保存。旧调度器把未释放的验收占用识别为现有阻塞记录，并以原 checkout 资源约束冲突写。未派发的候选回合等待支持该绑定的 Worker。新 Control 在原请求的持久回执中区分未领取与执行端已撤回，供宿主按原 ID 安全重试。

`sessions.status` 可附带 Codex 当前待答表单的匿名标识及原 turn ID。表单、选项和答案留在执行会话的现有通信通道。父 Dot 通知带回原会话入口，用户答复后继续核对同一轮次的实际输出或终态。

发布前在 TestLoop 执行 `pnpm test:dot-dispatch-release`，并将生成的隔离报告交给发布清单预检。脚本用隔离凭据和进程覆盖两组单边升级、双候选、掉线、领取边界、Worker 崩溃、容量及目标执行取消。运行入口和报告字段见 TestLoop 的 `E2Etest.md`。

### 集成步骤

1. 审查并集成两仓库独立提交到各自个人 main；fetch 核对远端并保留最近记忆移动、启动清理和已有发布配置。本文不授权合并/推送/发布。
2. 在隔离发布目录构建 happy-wire、happy-agent、CLI、宿主及 App/Web；准备所有候选产物，再选维护窗口。不能重启正在执行本任务的 Worker 来测试。
3. 核验机器身份与 root/grant 绑定，协调保存宿主账本、Worker journal/receipts、新机器队列及 worktree。新旧版本不可混跑。V1 → V2 的一次持久迁移将历史默认机器 2 改为项目 2、机器无默认硬上限；未知任务的保守资源保持到取得真实归属/结束证据；精确匹配的已知自动租约可按上述规则原地收窄。尚未执行的旧队列按新项目域调度。显式旧 registration.maxConcurrency（含 2）仍映射为机器硬上限；非默认持久额度 1/3/4 必须配置匹配的 machineConcurrency 才迁移，禁止无解释放宽。后续修改策略须停所有相关 Worker、确认没有未终态任务，以原策略打开 TaskQueue，调用 configureConcurrency(新策略)，再按新配置启动；禁止绕过 QUEUE_IN_USE。V2 密文和密钥须一起备份，旧 V1 reader 无法读取 V2，不可直接回退。
4. 先升级 gateway/MCP（新增 worker/authorize 与执行/取消字段），再升级已构建的 CLI/Worker，再切换宿主和 Web；手机沿既有个人 preview 流程另行授权 OTA/原生发布。旧 gateway 不支持队列权限复查时，新 Worker 保留排队而不执行，不能降级跳过授权。
5. 用新授权的专用测试项目验证 queued/submitted/运行/取消与机器总额度，检查会话实际 cwd 和组合功能。不要重新派发历史需求。
6. 回滚前停止受理、确认活任务状态并协调备份；旧宿主不能解析新状态，旧 Worker 不认识新队列和 worktree 授权，禁止直接覆盖账本或丢弃排队任务后降级。

2026-11-10 的本机发布已完成真实 MCP 独立只读任务派发、完成和测试进程停止验证；原验收任务按用户最后指示保持 failed/session_stopped、未发送，未恢复或重派。3 个 Dot 的原 session/thread、权限、输入历史与规范记忆保持，10 个既存 Happy 会话根进程的内核身份保持。源回归 201 项、固定 Worker 产物 6 项及隔离浏览器 7 组通过；生产 Web HTML/三入口 JS 与最终导出逐字节匹配，匿名浏览器通过。证据、冷备与本次边界见 [发布入口](../../DEPLOY.md#dot-自主推进派发修复2026-11-10)。既有实现验证另见 [实现验证记录](dot-parallel-tasks-validation.md)；真机、整机重启、长期稳定性与任意外部 shell 的资源遵守仍未验证。

旧 goal/delegation 入口继续采用原项目级保守 guard 和预算，本轮没有改写其 DAG 规划器；它已能持久识别 queued、按原ID恢复回执。新 queue-blocked 的只读恢复有专门 scanner 条件，绝不放开历史 blocked/not_sent。queued_canceled 与旧 not_dispatched 分开：前者有真实空闲 session、明确 executionDispatched=false，不能宣称进程已停止。
