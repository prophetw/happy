# Dots 工作区管理

在 Dots 工作台顶部打开 **工作区 / Workspaces**。选择机器中的授权项目，查看目录、分支、关联任务/会话标识、
成果状态、最后检查和保护原因。分页每次最多5个目录，同一目录不因多条任务引用重复计数；不显示任务正文。

1. 打开“详情与证据”，核对提交、结果来源和占用。
2. 旧登记可明确“核对并纳管”；服务端仍验证机器/UID、管理根、Git登记、分支/base等。不会自动纳管。
3. “核验已合入 main”或“核验无代码改动”由服务端核查历史/patch等价和当前目录，记录保留引用。
   这不是提交、合并、推送、停止任务或放弃成果。“保留 Git 归档”只有原策略明确允许时出现；不会代存未提交文件。
4. 生成计划，核对具体单个目录、阻拦条件、60秒期限与保留资料。只有无阻拦的计划才允许明确确认并回收。
5. 查看实际回执。未知结果应“核对原请求回执”，必要时沿原编号重试，不换编号重复发送。
6. “回收记录”提供持久操作记录、保留提交/ref和重建目标资料。当前没有自动重建API，不显示假恢复按钮；旧任务不会重放。

账号、工作台或项目变化会清除当前选中计划；未决编号仅按账号/机器/项目/工作台本地保存，刷新后可恢复。
界面不会将“已受理”、task completed、进程消失或未知返回当成目录回收成功。

## 授权与责任

`WorkspaceLifecycle`与Worker `TaskQueue`仍是唯一成果/目录权威。新增本机owner管理API，浏览器不拼shell或调用CLI。
使用与Control相同的Happy账号验证，并读取Control既有owner options验证当前机器、项目/目录范围及在线Worker能力。
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

仅本机8989开发入口启用同源 `/api/workspace-owner/v1/` 代理；其他Web/OTA不会因此发布或启用。
管理服务的私有配置包括已核验worker配置、批准的policy文件、机器项目显示名、精确Origin、loopback监听与独立协议元数据目录。
policy每次请求重新读取；allowApply由原策略控制，不改allowArchive/allowDiscard，不启用定时GC。
服务入口为 `happy-agent/bin/happy-workspace-owner.mjs --config <private config>`，它是运维入口，用户正常流程无需终端。
该服务复用队列兼容版本，不必为新页面升级或重启现有Worker/Control/producer。若Control或Worker授权无法证实，显示错误并保留目录。

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
