# Dots 工作区管理

Happy 设置和 Dots 工作台有 **项目工作区** 入口。Dot 的原工作项也可以按同一个 send requestID 打开工作区。
“待合并 / 待处理”使用持久队列、Workspace Owner 记录和本机 Git 登记，每页最多核对 5 个工作区。
即使关联执行会话已退出，列表仍能显示工作区及原任务或会话。每张卡分别标明目录、Git 登记、归属、脏状态与下一步。
测试记录显示实际对应的提交和结果。选配远端可查询分支 SHA 和目标 SHA，无法读取远端或相关历史时显示未知。

如果目录缺失，保留原工作项、分支、候选及已有保留引用。新建的托管工作区在准备完成时保存一份仅含创建身份的独立记录。
队列映射缺失时，服务用项目、grant、工作区 ID 和 Git 登记或剩余任务核对归属，提供只读恢复入口。
老目录仅在项目根或策略显式批准的 `inventoryDirectories` 下盘点，缺乏托管证据时显示“待认领”。
如果缺失的资料不足以确认账号、项目或目录，保持未知，不新增可写归属。

1. 打开“详情与证据”，核对提交、结果来源和占用。
2. 旧登记可明确“核对并纳管”；服务端仍验证机器/UID、管理根、Git登记、分支/base等。不会自动纳管。
3. “核验已合入 main”或“核验无代码改动”由服务端核查历史/patch等价和当前目录，记录保留引用。
   这不是提交、合并、推送、停止任务或放弃成果。“保留 Git 归档”只有原策略明确允许时出现；不会代存未提交文件。
4. 生成计划，核对具体单个目录、阻拦条件、60秒期限与保留资料。只有无阻拦的计划才允许明确确认并回收。
5. 查看实际回执。未知结果应“核对原请求回执”，必要时沿原编号重试，不换编号重复发送。
6. “回收记录”提供持久操作记录、保留提交/ref和重建目标资料。当前没有自动重建API，不显示假恢复按钮；旧任务不会重放。

账号、工作台或项目变化会清除当前选中计划；未决编号仅按账号/机器/项目/工作台本地保存，刷新后可恢复。
界面不会将“已受理”、task completed、进程消失或未知返回当成目录回收成功。

## 已授权候选的交付

在项目私有 Owner 策略配置 `remote`、目标 `mainRef` 和 `delivery` 后，候选详情出现“交付当前候选”。
`delivery.remoteURL` 固定实际读写远端，`delivery.test` 是管理员批准的自测命令参数数组，在该候选的隔离目录执行。
授权绑定项目、原请求、候选 SHA 和当时的策略。已知脏内容需先保全，待交付候选来自原任务的已提交结果。
如同时提供业务验收证据且原任务选了收尾，Owner 通过既有的独立归档、活动探测和回收流程释放目录。

- `strategy: "direct"` 用已自测的 SHA 快进远端目标。推送以本次读取的目标 SHA 为前置条件。主干前进、候选分支已占用或自测失败时保留现场。
- `strategy: "pr"` 可配置 `github`，其中含 `repository`（`owner/repo`）、`mergeMethod`、`requiredChecks`、`minimumApprovals`。
  使用宿主已配置的 GitHub CLI 和匹配的 github.com Git 远端，按同仓分支及精确 SHA 对账 PR。
  自动合入需要读到严格且适用于管理员的分支保护，通过必需 CI 和审批。缺证据、需要其他平台的 PR 或检查失败时显示具体阶段。
- 远端回读确认祖先、从同一可达基线计算的精确内容，或已验证 PR 的合入 SHA。合入后在另一个目录归档候选测试、远端与验收证据，再走原回收检查。
- 同一操作的自测、推送、合入意图及回执持久化。重开授权账号的工作区页时核对可继续的操作，明确阻塞的操作可用“对账并继续交付”。
  长期关闭页面期间尚无独立 CI 唤醒。掉线和状态变化后先读远端及原回执，再考虑执行下一步。

## 专属任务的后台回收

新版 Worker 创建的独立写入 worktree 会记录创建来源。任务结束后，宿主的 Workspace Owner
沿已有账户和项目授权核对正确远端主干。已合入的候选或无新增工作的已合入基线具备回收条件。
使用交付策略中的固定 URL，或 Owner 进程环境中按项目 ID 配置的 `HAPPY_WORKSPACE_RECLAIM_REMOTE_PINS`。当前 Git 远端必须仍与该 URL 一致。
当远端对象尚不在本机时，Owner 在独立的临时对象库只读获取证明。Squash 或 rebase 可以由
已绑定候选与目标的已合并 PR，或从可信共同基线精确匹配的内容变更证明。

待释放目录必须无新增提交、未保存文件、未知临时资料、其他任务或恢复租约。专属 Codex
会话通过原进程核对唯一已完成回合与独立保存的线程历史，再正常结束；无法核实则等待。
托管执行禁止已知的 Node 与 TSX 临时缓存落入任务产物目录；其他临时文件保留供核对。

Owner 保存归档、Git 恢复引用和操作编号，回读后才使用普通 Git 回收。后台可在页面关闭和
服务重启后恢复。目录与 Git 登记都已消失才回写完成。列表提供等待原因与自动继续提示，
或需处理的内容，也能经“回收记录”返回原请求。回收不发起合入、推送或重新派活。
未标记的历史目录仍可只读盘点，沿用既有授权的处理途径。

列表、原任务卡及详情通过项目授权显示当前回收条件。红色提示列出需要保全的改动、
临时资料和待核实占用；自动等待另有状态。临时文件名只在详情提供有限预览，
缓存式命名仍需核实来源，列表只提供数量。重新检查只使用 Owner 的只读查询，
更新该项证据后才可重新生成计划。未纳入自动回收的历史目录仍走手动核对和确认。

## 对受管工作区的一键回收

从列表、详情或原任务卡点「回收」，Owner 按工作区绑定记下同一操作。宿主会等待正在
使用该位置的任务，支持协作退出的单轮专属会话会保存历史后退出。外部占用和无法证实
的退出继续保护。旧工作区只有被选择后才进入这条流程，已有业务验收继续走原入口。

归档在 Owner 独立目录保存原工作文件、临时目录与 Git 暂存树。普通文件、删除、
二进制与链接按原状态保留，链接目标保持原样。来源未证实的缓存式目录也按普通资料
保留。部分失败时可以从原回执看到保留位置。Git 正常注销并核实目录与登记均消失后才
显示成功。原任务卡可进入回收记录，在执行电脑按存档内的 RECOVERY.txt 恢复效果。
未确认合入的提交只有项目现有策略允许归档时才可释放，分支及恢复引用保留。

## 授权与责任

`WorkspaceLifecycle`与Worker `TaskQueue`仍是唯一成果/目录权威。新增本机owner管理API，浏览器不拼shell或调用CLI。
使用与 Control 相同的 Happy 账号验证。读列表时核对 Control 持久注册的机器与项目范围，可在 Worker 离线时查询。写操作还核验当前 Worker 能力与授权。
不会创建或扩大真实grant，不接受HappyProof/HappyService作为页面owner授权，不新增MCP或模型工具。
配置的project/policy白名单进一步收窄到本机批准范围。合法目录选择使用原 `directoryAllowed/directoryProjectID` 规则，
不需改真实Worker registration。原CLI静态项目验证规则保持原样。

检查通过固定可信子进程执行，最多2个；每页5项，不在HTTP请求主线程同步扫描Git/proc。
账号Bearer仅用于服务器内存、固定后台进程的私有IPC及Control的最终核验，不写入状态、日志、argv/env或交给模型。
写操作在起始和最后检查前复核Control授权；网络检查之后再复核文件/占用、本地注册/policy和原计划期限。
TaskQueue retiring fence阻止新的合法派发，普通非force Git删除拒绝发生变化的目录。不会kill、force、unlock、clean、reset或删除branch/ref。

计划ticket和owner操作意图是有界UI协议元数据；实际处置、回收与重建证据仍存于既有lifecycle。
相同操作编号/参数幂等，不同参数冲突；旧未知操作的重试被拒绝不能结清原操作。已提交后撤权导致回执被隐藏，
API明确返回dispatch=unknown，页面保留原编号。正常前置拒绝才会标not_started，允许重新检查。
策略、HEAD、revision、任务/会话/恢复引用、dirty/ignored、保留ref、进程/挂载、计划期限均不能由前端确认绕过。

## 本地服务接入

本机8989 Web使用同源 `/api/workspace-owner/v1/` 代理。原生 Happy 使用已配对机器的加密 Relay RPC。设置和 Dots 工作台可选择启用 Workspace Owner 的电脑；从原任务进入时，若关联执行会话已确认机器，则使用该机器及原项目、请求编号。
在同一台机器的 Happy daemon 服务配置 `HAPPY_WORKSPACE_OWNER_RPC_URL`（Owner 的 HTTP 回环监听地址）和 `HAPPY_WORKSPACE_OWNER_RPC_ORIGIN`（Owner 已允许的本机 Web origin）。仅在两者有效时登记 `workspace-owner-v1`。App 无需输入宿主地址。
daemon 只接收既有 Owner 路径与协议，使用它当前 Relay 账号的凭据调用本地服务。Owner 继续核验账号、机器、项目、策略与每次操作。换账号或机器后重新读取清单；手机端的长操作超过 Relay 等待窗口时可能显示结果未知，可通过原工作区与回执续查。
管理服务的私有配置包括已核验worker配置、批准的policy文件、机器项目显示名、精确Origin、loopback监听与独立协议元数据目录。
policy每次请求重新读取；allowApply由原策略控制，不改allowArchive/allowDiscard，不启用定时GC。
服务入口为 `happy-agent/bin/happy-workspace-owner.mjs --config <private config>`，它是运维入口，用户正常流程无需终端。
该服务复用兼容队列读写格式。新工作区的独立创建身份记录由 Worker 写入。Control 无法确认项目、或写操作无法验明 Worker 授权时，显示错误并保留目录。

8989的Metro只有在配置合法loopback `HAPPY_WORKSPACE_OWNER_URL` 时转发API；缺少配置明确报不可用，不伪装空列表。
配置代理需重启8989，但不清浏览器storage/认证或修改Relay目标。HMR仍由原Metro处理。

### Linux 占用核验权限

`workspace-owner.json` 可配置 `processProbeSocket`。管理服务验证已有会话进程凭据，再将工作区 ID 和进程范围交给本机探针。探针与 CLI 共用 `/proc` 扫描，单独检查当前目录、进程组、打开文件和挂载。连接、协议或扫描失败会使计划保留阻塞。

通过 `deploy/automation/workspace-probe/` 的系统级 socket 单元按请求启动探针。填入管理服务的 Linux 用户、`/run` 下的专用 socket，以及该机器的固定 `worktrees` 根路径。将 `packages/happy-agent/src/automation/production/workspaceProcessProbeMain.ts` 用 `esbuild --bundle --platform=node --target=node22 --format=esm` 打包为单个 `.mjs` 文件。单元引用的 Node 运行时与探针产物由 root 持有，socket 只允许该管理用户连接。只有扫描子进程具备 `CAP_SYS_PTRACE` 和 `CAP_DAC_READ_SEARCH`，并禁止代码调用进程内存读写接口。

启动并核对 socket 后，将路径写入上述可选字段并重启 `happy-workspace-owner.service`。原来的 8989 页面沿用同源代理。回退时恢复旧服务入口与配置，并停止对应 socket 单元。

隔离浏览器回归脚本是 `packages/happy-app/scripts/test-workspace-manager-browser.mjs <private output>`：
使用实际Dots Home和管理组件，注入虚构账号/theme/locale/storage适配；HTTP、队列、Git删除、持久回执和重建真实执行，
与真实账号/业务模型验收分开。临时夹具仅监听20082，截图不包含真实机器目录或用户内容。
设置 `HAPPY_WORKSPACE_FIXTURE_ROOT` 与 `HAPPY_WORKSPACE_FIXTURE_SOCKET` 可通过仅指向该夹具的独立 socket 验证真实进程核验。夹具根为新建的 `/tmp/happy-owner-ui-*`，单元的工作区根对应夹具内的 `fixture-machine`。

设置 `HAPPY_WORKSPACE_RESTART_FIXTURE=1` 测试恢复列表。专用浏览器入口、Owner 服务进程和 SQLite 之外的队列文件都在隔离目录中，远端为本地 bare Git。脚本强制重启 Owner，验证未提交、已推、已合入待收尾、目录和归属缺失，再执行一次实际自测、推送、合入、归档释放和回执丢失后的读取。
