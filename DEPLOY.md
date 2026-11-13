# 个人 Fork 部署入口（prophetw/happy）

## Dot 任务命名与项目分组 P0（2026-11-13，已部署）

功能提交 `8ca54cde97d3fa2917bc403dbb78fba701fa21a3` 已推送个人 `fork/main`，从最新远端 main 独立提交，未带入其他工作区改动。Control、Worker/CLI、宿主和私网 Web 已切换；固定 Worker 包 `/home/dev/.local/share/happy-automation/releases/p0-task-title-20261113`，Control 镜像 `sha256:e5532ee3e2b281e079a88a799be546aac4699e3049b0cf9d334fb743c669abbf`。真实只读任务验证标题、可信 origin、完成回执和测试会话停止；固定 Web 手机分组与线上资源核验通过。健康仅保留原三项 attention。

preview OTA 更新组 `fd277973-51d7-40e4-aaa4-a76334af1fcb`，iOS/Android 均 runtime 21；preview/production manifest 与启动包 SHA256 `2662320e09bb09ae89d07afb55273ab5de3702642e73f81c0e6157e3cf73437b` 已核对，真机加载未验证。初次项目权限及 environment 参数失败未产生更新。宿主三次失败/回退、Web base path 修正、备份和最终验收证据统一保存在 `/home/dev/.local/state/happy-dot-p0-20261113/`。详见 TestLoop DEPLOY.md 同日期条目。

桌面 Web 最终在同一项目卡内呈现主目录及从属 worktree，worktree 于主干下缩进并可独立折叠/展开，主目录不折叠；折叠标题使用 worktree 原名，任务标题仅保留在任务行，不再重复。折叠偏好保存在本机。8989 和私网 Web 均已更新，实际折叠/展开与 mobile 浏览器验收通过，未为桌面调整重新发布 OTA。

## Hosted Dot 无变化持久化跳过（2026-11-13，已部署）

功能源 `e3f67eb2a9c9735e432657a800242484d5ede10b` 已普通推送个人 main。
未改变 journal 的通知和重复输出不再触发持久化；输入接收、输出、ACK、结束与错误状态的
必要落盘保留。构建来自当次核验干净且与 fork/main 一致的独立 main clone。
沿用线上 Happy SQLite 兼容补丁，补丁 SHA256
`677d405cee63f28a8d4c6fbff17305abaa04c1c952e3c9a39097f71d277a5eb3`；
该补丁尚未合入 main，本次没有切换 storage marker、迁移或压缩数据库。

正式产物位于 `/home/dev/.local/share/happy-releases/dot-noop-20261113-e3f67eb2a`。
原受信入口 `/home/dev/.local/share/happy-releases/full-chain-20261112-e2327a617/packages/happy-cli/bin/happy-hosted-dot.mjs`
通过原子替换包装文件加载新目录的 `dist/codex/hostedDotMain.mjs`，Main SHA256 为
`fa4fdf23711d63a3bd2b8b287dc50fb831798f0837040ed04e9464045ebdd720`。
旧目录其他正式模块保持原样；本次只滚动更新四个空闲 hosted producer。

09:04（UTC+8）只读验收：四个 producer 的 PID、启动标记与新产物摘要匹配，均 ready、
pending=0、unsent=0、error=null。四个原 thread、epoch、绑定、222 条输入及 32,217 条原输出
按原 ID 逐行摘要保持，控制回执保留、游标不回退；每个 Dot 另有一条已确认的新输出。
旧 producer 及其直属原生子进程退出已核验。TestLoop assistant/recovery 与执行 Worker
维持原 PID，含业务执行根在内的 45 个受保护进程身份不变。

CLI 正式类型检查、pkgroll 构建及 68 文件 bundle 验证通过；本轮定向测试 72 项通过，
SQLite 补丁环境覆盖 90 项、生命周期测试 29 项通过。补丁环境首轮的一项失败由测试启动
目录缺少 tsx 依赖造成，正确目录复验相关 7 项通过；原失败日志保留。未发送测试业务输入、
调用真实模型或进行浏览器、整机重启与长期运行验证。

独立维护单元 `happy-dot-noop-release-20261113-attempt2.service` 已成功完成，
`RemainAfterExit=yes`、`KillMode=process`。其中仍承载三个 producer，须保留，不能作为
已结束临时任务整组清理；后续自动拉起仍由现有 TestLoop scanner 负责。
首次激活因 `hosted_storage_file_invalid` 失败并恢复旧入口，首个停止请求随后正常完成，
旧版本已重新启动后才进行第二次激活。该错误具体触发文件未确定。
第二次另遇一次 `hosted_lifecycle_stop_unconfirmed`，通过同一停止请求回执、旧进程退出
及新版本启动证据确认接管，没有重发该停止请求。两次诊断均保留。

私有证据根 `/home/dev/.local/state/dot-journal-noop-release-20261113/` 保存构建清单、
激活状态、最终逐行回查、原入口及 `attempt-1/` 失败记录。`backup/` 是经校验的四库
一致性在线备份；配置等旁文件是逐文件快照，不宣称跨文件原子冷备。回退仅在核验当前
状态与旧 reader 兼容后恢复入口并受控重启，不得用备份覆盖上线后的账本。
原两仓其他暂存/未提交改动保持，真实样本与基准报告不入 Git；全局 CLI/daemon、
执行 Worker、Control、Relay、Web 和手机版本未更新。

## 宿主授权快照竞争修复（2026-11-11，已部署）

功能源 Happy `ab205e624dbe76a24328b111bc541f0633e812f3`、TestLoop
`066cd313b59ccf9e556fce65717b1349116d6e78` 已普通推送各自个人 main。
发布来自当次 fetch 一致、干净的独立 main clone；保留最新 clear fence 和项目内部派发边界。
Happy 仅替换原受信路径的正式 authority 模块及其新 hash chunk，原 hosted producer、
全局 CLI/daemon、执行 Worker、Control、Relay、Web/OTA 保持；没有修改 Dot 配置或执行 SQLite 迁移。

宿主和恢复服务使用 `/home/dev/.local/share/testloop-releases/hosted-authority-race-20261111-066cd31`，
PID 1184793 / 1184812，均 active、NRestarts=0；九个原生网关均来自新宿主。
三 Dot ready/error=null，两个有输入历史的 thread、所有原 Relay session、epoch、
75 条输入值/状态、权限和规范记忆保持。空 inputs 的 Dot 按原 CLI 规则轮换空 thread。
14 个原执行根和 Worker（合计 15 个）PID/startTicks/cgroup 保持；125 条操作和 65 个工作项
无新增、没有换 ID 重派或取消原业务。事故 Dot 原有 hosted_relay_unavailable 在重连后清除，
这不等于原业务已经恢复或重新派发。

正式 Happy CLI 构建及内联 agent 检查通过；Happy 定向 78 项、生命周期边界 22 项，
TestLoop 合并主线后 164 项及固定构建同字节套件 148 项通过（两组有重叠，不累加）。
两仓相关类型检查通过。线上正式 authority 模块 60 次新鲜只读校验、文件哈希、服务、
原请求和受保护进程核验通过。health 仍 degraded，仅原三项 attention。未用真实任务取消/重派验收，
未验证手机、浏览器或长期负载下竞争耗尽率。

冷备 `/home/dev/.local/state/testloop-backups/hosted-authority-race-20261111` 已校验，`-extras`
保存 native homes、用户记忆与原服务文件。旧宿主和旧 authority 文件保留，回退须先停写、
验证旧 reader 可读当前状态，恢复模块和原 unit；不得用冷备覆盖上线后的新账本。
证据 `/home/dev/.local/state/hosted-authority-release-20261111/` 中保留 manifest、
cold-backup、preflight、activation、input-order-proof 和 final-verification。

首次独立激活单元因两个验收断言失败退出 1，新服务本身已成功运行，未再次停启：
断言使用对键序敏感的 JSON.stringify 哈希，重启解析重排了 18 行对象键序；
已验证冷备每行匹配原 preflight 哈希，当前输入逐字段/状态完全一致，最终只读验收通过。
原 failed 单元与 activation-failure.json 保留，没有覆盖为成功。TestLoop 首次构建的本地
.pnpm 链接缺失也保留失败日志，补齐既有依赖链接后正式构建与类型检查通过。


## Dots 打开速度修复（2026-11-10，宿主 / Web / preview iOS 已发布）

已提交并普通推送个人 main。宿主功能源 `5dc3852e9912017773e5a145e93f0f6a88896bf7`；Happy 修复在保留远端主线后合入 `8a21f0c4`，App/Web发布源 `e6076e5104cc3bc98d644d5c75264d2482778db4`（包含手机更新说明）。原工作区其他任务的暂存 DEPLOY.md、CLI 和 Worker 改动保持，发布来自独立干净 checkout。

- 宿主运行 `/home/dev/.local/share/testloop-releases/dots-read-20261110`。相对原 workbuddy-wait 版仅5个运行JS变化：daemon、dots-presence、dots、store、workspace-rpc。scanner PID `1615922`、recovery PID `1618294` 均 active、NRestarts=0，7个原生工具/记忆网关使用新宿主。
- 冷备 `/home/dev/.local/state/testloop-backups/dots-read-20261110` 验证1412文件；`-extras` 保存三个Dot原生home、Happy profile、用户级记忆及旧服务文件。13个原执行会话的PID/startTicks/cgroup与执行Worker身份保持。原3个Happy session、输入历史、设置、权限和规范记忆保持；两个有历史的原生thread不变，已清空且无本轮输入的空thread按既有CLI启动规则重建，未重放旧输入。
- 私网 Web `https://desktop-8ut4p0p.taild92624.ts.net/happy/` 已发布；HTML、三个入口JS及WASM逐字节回读一致，并核对gzip首页。旧hash资产保留，完整旧Web在证据根 `previous-web/`，没有重启Relay或执行Worker。
- 个人 `@prophetwayen/happy`、preview环境/分支、iOS runtime21、bundle `com.prophetwayen.happy.preview`：[OTA更新组](https://expo.dev/accounts/prophetwayen/projects/happy/updates/ddaae9c9-750b-4b94-b1a0-dd778bf939dd)，update `01a1c4d5-c716-705c-8ed6-67f5900b751f`。preview/production原有共同preview映射保持；两渠道实际manifest的项目、bundle、runtime、源码和更新ID一致。实际启动包10,239,684字节，SHA256 `84ccf2d3223fc81ecb6dd4188b8e5682d2843035b58c64bbd1e3906c9497448c`，下载哈希与本地最终iOS导出一致。手机是否已下载/加载未验证。

线上真实加密RPC五次只读验证通过：列表263/498毫秒，三Dot详情1281/2483/658毫秒，commands/requests/outbox数量保持，真实模型0次。该样本经过本机访问实际私网Relay，不等于手机外部网络耗时。合入最新个人main后，App48项及类型/changelog检查通过；宿主此前同源码48项定向验证复用。最终固定Web导出包8组真实隔离浏览器检查通过，线上匿名登录及未认证Dots guard浏览器errors=[]、三个实际入口JS匹配。整体health保持degraded，仅原三项attention，scanner error=null；真机、整机重启和长期稳定性未验证。

发布准备的首次Web构建因workspace依赖链接解析失败而拒绝，修正发布副本的本地链接后重新导出成功；失败日志保留 `web-build.log`，成功日志为 `web-build-fixed.log`，未将失败写成通过。发布期间没有清理历史回执或旧业务数据。回退须协调宿主与App/Web查询协议，并保存发布后的消息与任务；不能直接用旧冷备覆盖当前账本。

证据根 `/home/dev/code/testLoop/.e2e-artifacts/dots-read-release-20261110/`：`host-manifest.json`、`cold-backup.json`、`host-activation.json`、`live-read.json`、`web-deployed.json`、`online-browser/report.json`、`ota-published.json`、`ota-served.json`、`final-readback.json`。固定导出包浏览器证据 `/home/dev/.local/share/testloop-releases/dots-read-20261110/.e2e-artifacts/dots-workspace-read/2026-11-10T09-35-40-376Z/`。

| 验收节点 | 截图 |
| --- | --- |
| 固定发布产物的隔离工作台（非私人账号） | [查看](http://100.116.89.36:3210/img-bed/images/fdcae1de-1f3e-42ed-a156-50c8746435ee.png) |
| 线上匿名手机尺寸登录页 | [查看](http://100.116.89.36:3210/img-bed/images/a952d407-85d2-48da-b738-ea5a475586d5.png) |


## Automation Worker 持久会话查询 CPU 修复（2026-11-10）

CPU 修复源 `6c9128cbf612fb641d34cbccca52087a35073275`、部署入口保护源 `e43a3604d85b174590abef7a8332106db6d77c79` 已推送个人 `fork/main`。固定包从当次 fetch 一致且干净的独立 `main` 准备。线上采样定位到 `observeLegacy → automationControl.observe → readPersistedSessions`：高频单会话查询反复读取约 1.13 MB、263 条记录的全表，并逐条计算系统启动时间。现在按文件代际复用解析索引，只重查目标会话的保留期限和进程存活；启动/写入的全量读取继续保留，启动时间每次全量读取只计算一次。没有新增依赖。

用户在普通 WSL 终端激活第二版维护包，独立维护单元 `happy-automation-maintenance-20261110T055951Z-worker-cpu-fix-e43a3604d85b.service` 为 success/0。系统 Worker PID `3008770`、active/running、NRestarts=0，实际入口为 `/home/dev/.local/share/happy-automation/releases/worker-cpu-fix-v2-20261110-e43a3604/packages/happy-cli/bin/happy-control-worker.mjs`。16 个受保护原会话根 PID/startTicks/cgroup 回查保持，注册配置 SHA256 不变；65 秒健康观察得到 3 条 connected、间隔约 30.0 秒，无 unavailable 或非预期 journal 错误。

切换前后各 3 次约 6 秒的主进程采样：CPU 单核均值 **56.01% → 31.14%**，下降 **44.40%**；`/proc/<pid>/io` 的逻辑读取量 `rchar` 均值 **68,608,307 → 8,243,551 B/s**，下降 **87.98%**。两侧物理磁盘读取均为 0，不能将逻辑读取下降称为磁盘吞吐下降。线上并发负载未受控，剩余 CPU 及长期性能未验证。

135 项定向回归（含 14 项新查询测试）、CLI 类型检查/构建及 18 项维护安全测试通过；固定包哈希、实际模块加载和激活预检通过。生产 MCP 独立只读会话 `cmwaahdhz1zyymm16nd96fwht`、turn `01a1c412-9b93-7ed3-8fa6-233835173d62` 返回精确标记 `WORKER_CPU_FIXED_V2_09da1113e0c7` 并 completed，随后只取消自有测试会话并确认 process=stopped。1 次真实模型输入，费用未测量；浏览器/手机、整机重启与长期稳定性未验证。

首次激活失败记录保留：候选 drop-in 文件名排在旧覆盖配置之前，reload 后仍启用了旧包，维护单元 `happy-automation-maintenance-20261110T054543Z-worker-cpu-fix-6c9128cbf612.service` 为 exit-code/1；旧包重启为 PID `2775734`，再次执行旧激活脚本因 PID/invocation 已变化报 `LIVE_WORKER_CHANGED`。该次 CPU 修复没有生效，原 15 个受保护根保持，未发送派工验收。修正后在停止前拒绝排序冲突，在 reload 后启动前核对完整生效 argv，回退也核对旧入口；第二版覆盖文件名排在所有现有覆盖配置之后。未清除首次失败单元或将其记为成功。

既有维护器在停止段执行冷备，私有维护目录 `/var/lib/happy-automation-maintenance/20261110T055951Z-worker-cpu-fix-e43a3604d85b`。旧包保留；普通终端的显式回退入口为 `sudo /usr/bin/python3 /var/lib/happy-automation-maintenance/20261110T055951Z-worker-cpu-fix-e43a3604d85b/rollback-release.py --launch`，核验旧 reader 可读取当前账本后仅撤回本次覆盖配置，不恢复旧账本覆盖新状态。本次未实际执行回退，也未绕过 Agent 的 NoNewPrivileges 读取 root 私有状态。

证据根 `/home/dev/code/happy-worker-optimization-release-20261110/.e2e-artifacts/worker-cpu-fix-v2-20261110/`：`deployment-validation.json.status=passed`，后台 `happy-worker-cpu-fix-v2-acceptance-20261110.service` 为 success/0，包含 CPU/读取量样本、原进程保持、真实派工清理和 `first-attempt-failure.json`。诊断采样保留在同级 `worker-cpu-diagnosis-20261110/`。本次仅替换受管 Worker 固定入口。

## Automation Worker 观察与健康日志优化（2026-11-10）

功能源 `608d9352d586c1f14ea97857d6bb0e073ab64dac` 已正常推送个人 `fork/main`，固定包从当次 fetch 核对一致、干净的独立 `main` 准备。增量观察普通会话历史，每页复用一次队列快照，减少任务分页中的重复进程标识更新；稳定健康日志改为每 30 秒一次，调度故障保留到实际恢复。依赖锁文件、注册配置、项目/权限、账本格式与 systemd 重试策略保持。

用户在普通 WSL 终端执行已校验的 root 激活，独立维护单元 `happy-automation-maintenance-20261110T045611Z-worker-optimization-608d9352d586.service` 为 success/0。系统 Worker PID `2247195`、active/running、NRestarts=0，入口 `/home/dev/.local/share/happy-automation/releases/worker-optimization-20261110-608d9352/packages/happy-cli/bin/happy-control-worker.mjs`；12 个受保护原会话根 PID/startTicks/cgroup 在切换后回查保持，注册文件 SHA256 不变。既有维护器在停止段冷备机器账本/密钥与 journal，私有维护目录 `/var/lib/happy-automation-maintenance/20261110T045611Z-worker-optimization-608d9352d586`；原包保留，回退入口在该目录 `rollback-release.py --launch`，会核验原 reader 可读取当前账本，不恢复旧状态覆盖新回执。

89 项功能定向回归、happy-agent 类型检查/打包和 16 项维护安全测试通过；文件哈希与固定包实际模块加载通过。已部署 Worker 的 65 秒观察得到 3 条 connected，间隔约 30.2 秒，无 unavailable 或非预期 journal 错误。生产 MCP 独立只读测试会话 `cmwa8agvf1sa9mm16pfnr4bng`，turn `01a1c3da-6b36-76d0-b02e-4a68df3155a6` 返回精确标记 `WORKER_OPT_OK_a7f44e254a55` 并 completed；随后只取消自有测试会话，独立确认 process=stopped。1 次真实模型输入，费用未测量；没有向用户已有会话发送验收消息。

性能边界：隔离的 24 会话 × 5 轮基准中，列表查询 125→5、消息读取 72,000→14,400、队列事务 140→25。线上两次 8.01 秒样本的主进程 CPU 为单核 44.59%→45.20%，没有观察到下降；样本负载未受控，不能声称 CPU 瓶颈已解决。浏览器/手机真机、整机重启及长期性能未验证。本轮没有发布 Web、OTA、宿主、Control 镜像或全局 CLI。

证据根 `/home/dev/code/happy-worker-optimization-release-20261110/.e2e-artifacts/worker-optimization-release-20261110/`，`deployment-validation.json.status=passed`，含真实派工与清理、日志时序、CPU 样本及原会话保持结果；后台验收单元 `happy-worker-optimization-acceptance-20261110.service` 为 success/0。首轮跨包测试缺少 CLI 依赖链接和 happy-agent 本地产物，补齐后受影响的两组 38 项通过，原失败记录保留。当前 Agent 的 sudo 被 NoNewPrivileges 拒绝，激活由用户普通终端完成，未绕过该边界。

## Dot 自主推进派发修复（2026-11-10）

功能源 Happy `dcb5150ae25d38e1d5a40218010f3b8422fb365c`、TestLoop `389a9399525983a7cf96bf0065bc42ba54f017da`，已普通推送个人 main，并从当次 fetch 核对一致的干净独立 main 发布。取消原目录脏状态派发闸门，按实际 checkout 收窄自动资源锁，原请求持续跟踪并自动重试明确未发送的暂时故障；等待原因和恢复通过活动记录、工作详情及只读事件通知 Dot。没有新增依赖或修改项目额度，机器策略仍为项目默认 2、无隐式全机上限。

用户在普通 WSL 终端执行已校验的 root 激活；维护单元 success/0，系统 Worker PID `1542929`、NRestarts=0、connected，入口 `/home/dev/.local/share/happy-automation/releases/dot-autonomous-20261110-dcb5150a`。10 个既存 Happy 会话根 PID/startTicks/cgroup 直接回查保持。机器密文/密钥、journal 与进程证明由既有独立维护器在停止段冷备，私有目录 `/var/lib/happy-automation-maintenance/20261110T033541Z-dot-autonomous-dcb5150ae25d`；未绕过当前 Agent 的 NoNewPrivs 限制。

Control 镜像 `sha256:3a413943d3b17b81dca6b12dd2fea745f200871a9960b8e15cde3502fc03e42b` healthy。宿主、恢复服务和 3 个实际 MCP 挂载网关切至 `/home/dev/.local/share/testloop-releases/dot-autonomous-20261110-389a939`；scanner PID `1554856`、recovery PID `1567062`，均 active、NRestarts=0。3 个 Dot 原 session/thread、输入历史、授权、规范记忆保持；health 保留原三项 attention，scanner error=null。冷备 `/home/dev/.local/state/testloop-backups/dot-autonomous-host-20261110-389a939` 及 `-extras` 已验证，旧严格 reader 不再混读新宿主账本。

私网 `/happy/` 已发布，HTML 和三入口 JS 与最终导出逐字节匹配，手机尺寸匿名登录页/未认证 Dot guard 浏览器 errors=[]。最终源回归 201 项、固定发布 Worker 6 项、隔离关键流程 7 组通过；固定 Control 镜像以实际 uid1000 通过真实 stdio MCP tools/list。生产独立只读测试会话 `cmwa65ui81lgdmm16mcfta187` 已派发，turn `01a1c3a4-4e7b-7792-a868-9a16c05aa87a` 返回精确标记并 completed，随后仅停止测试会话并独立确认 stopped；1 次真实模型调用，费用未测量。

用户最后指示为“原任务保持停止”。原验收工作项 `91e4f9fa-90ba-459d-b0a1-70c4b84fb4ba` 仍为 failed/session_stopped、executionDispatched=false、sentSeq=null；原 session `cmwa0ees01dkymm16usdgxdj1` 未恢复，未取消/重派该工作项。本轮没有写 bim-server 的已有文件，也未触碰原 TestLoop 主工作区预先暂存的 DEPLOY.md。

后续回查补充：切换验收后，12:10 的明确 clear 回执 `5d37c953-0988-4309-af13-d24e8f4d16f3` 将一个 Dot 轮换到新会话；本轮部署未调用清空入口，保留该后续操作。另外一个空闲 Dot 在13244条输出均已确认送达后仍残留旧托管 CLI 的 hosted_relay_unavailable 标记。未手改错误字段，通过既有运行时控制重连后，原thread、epoch及76条输入历史保持，错误清除；证据 idle-dot-reconnect.json。不能将回查前的异常记录称为从未发生，也不能将后续清空后的现状称为3个原会话始终未变。

总证据 `/home/dev/code/happy-dot-autonomous-release-20261110/.e2e-artifacts/dot-autonomous-release-20261110/`，`coordination-status.json.status=deployed`；包含原任务回查、实际 MCP 挂载/生产派发、Web 字节/浏览器、进程保持及最终报告。发布前 Control 首候选文件模式造成 EACCES，已在隔离容器预检拦截并修正；另保留入口文本断言和测试 SDK 依赖定位的夹具失败，最终改用镜像真实 stdio 握手通过。线上未启用这些失败候选。手机本次 OTA、原生包、真机加载、整机重启和长期稳定性未验证。

## Dot 派发与重启会话强证明修复（2026-11-10）

最终 Worker 功能源为 Happy `5ca49e93956b166189a65628a54289e80b3e5f10`，已正常推送个人 main。此前 `92599a0d` 的 legacy 锁缩域修复已实际部署，但线上仍被整机排他锁阻塞：真实 CLI 对重启后恢复的活进程返回 `unknown`，先前仅接受 `running` 的调度守卫无法缩域；该次上线不能作为问题已解决的证明。

本次在机器私有子目录保存会话与 canonical 仓库、UID、boot ID、PID/startTicks、cwd/cgroup 绑定的进程证明。恢复会话仅在既存强证明与当前内核身份完全匹配时获得调度内部的 `sessionOwnerVerified/dispatchable`；CLI 的 `unknown`、停止和取消权限契约保持原样。已知仓库普通活轮次使用 `machine/shared` 与 canonical repo 排他资源；未知身份、失效证明及显式整机维护继续保守，命名资源仍是字面合作锁。本机管理员根据成功维护前后及当前身份核验，由原 dev 身份为三个既存会话写入证明；没有改队列资源、清锁或重发未知写入。

真实 CLI 恢复接口回归 **10/10**、队列/项目调度与证明回归 **41/41**、管理员 bootstrap 安全回归 **3/3**，happy-agent 类型检查及子系统构建通过。未重建 CLI 或发布 App/OTA。新候选上线前经真实只读 RPC 验证，三个会话的进程态仍为 `unknown`，而强证明及调度标记有效；没有将 saved PID 直接视为 `running`。

系统 Worker 已切至 `/home/dev/.local/share/happy-automation/releases/dot-process-proofs-20261110`，PID `1920200`，active/running、NRestarts=0；切换前采集的 **12 个活会话根进程**身份保持。独立 root 维护目录为 `/var/lib/happy-automation-maintenance/20261109T223231Z-session-process-proofs-5ca49e93956b`；机器密文、密钥、journal 与私有证明目录在 Worker 停止后的静止段冷备，活跃 worktree 保留原位。注册配置、项目默认额度 2 与无全机并发上限均保持，没有恢复旧账本覆盖新状态。

真实生产 MCP 独立只读会话 `cmw9ueqe318ummm16yv2mzogf` 已受理并派发，turn `01a1c277-1d28-7701-9b97-6939545a8050` 返回精确标记 `DISPATCH_PROOF_OK_0d01e2e31a64` 并完成，测试会话进程已停止。此项证明真实 turn 完成，不将测试清理后的队列状态称为 completed，也不冒称向两个现有 Dot 主会话发过验收消息。

原 `5069415d…` 任务在本次部署前已完成，不计为本次修复成果。Bim `737e0c1c…` 当前仍为 `waiting-resource / integration_worktree_dirty`、`executionDispatched=false`，原因是 integration 目录中四个用户已暂存的 Java 文件；这些改动及原 requestID 均保留，已无 `machine/exclusive` 阻塞。两个 testLoop legacy 当前均为 `machine/shared` 加 repo 排他。原三项未知写入保持原证据且未重放；宿主已先行修复 receipt 查询失败不能推翻原写入未知结果的边界。

上线证据在 TestLoop `.e2e-artifacts/dot-dispatch-fix-20261110/` 的 `final-worker-maintenance-status.json`、`proof-before-worker.json`、`proof-after-worker.json`、`production-dispatch-smoke.json`；定向测试及构建证据在本发布 checkout `.e2e-artifacts/dot-process-proofs-20261110/`，真实 CLI 回归日志另保留在前述 TestLoop 证据目录。手机真机操作与整机重启恢复仍未验证；未将本次后端真实派发验收扩展为全仓或所有客户端全绿。

## Dot 按项目调度修正发布（2026-11-10）

功能源 Happy `b5e508c1e7323609c3fb956c6c3261899103695a`、TestLoop `505276e50204d8da5860cefe7d53b308d5671323`，已普通推送两仓个人 main；从当次 fetch、干净且与远端一致的 main checkout 准备并发布。未回写原主工作区已有修改，未扩展真实项目授权。

旧策略将默认2设在全机并让legacy整机排他，跨项目被压制。现已在线回读机器账本 V2：`projectConcurrency=2`、`machineConcurrency=null`、项目覆盖为空。项目按可信canonical路径/Git common-dir计数，同repo不同ID/Dot/grant/Worker共用额度；普通legacy仅repo排他，同项目代码并行使用独立worktree/session，跨项目无需额外execution参数。显式机器限制和命名服务/数据库资源继续生效。**回读仍有1个旧全局排他执行受保护，未提前释放；它真正结束前仍可能让新任务等待。** 不把资源锁称安全沙箱。

用户在普通WSL终端执行已审阅root激活，独立oneshot结果success/0；新系统Worker PID `1564545`、NRestarts=0、connected通过，运行 `/home/dev/.local/share/happy-automation/releases/project-concurrency-20261109-b5e508c1`。原执行session根PID `186256`、`4126455`的startTicks/cgroup在切换后保持。Control镜像 `sha256:1bd7dc28cc87a61e2734727cda99d5cdd32a06ffe43aa2a45fc7581b42923824` healthy。没有绕过NoNewPrivileges或通过当前会话前台停启Worker，未替换全局CLI、未重启Relay。

宿主与四个实际MCP/记忆网关使用 `/home/dev/.local/share/testloop-releases/project-concurrency-20261109-505276e`。scanner PID `1580549`、recovery PID `1582146`，原Dot session/thread、输入历史、权限与两层规范记忆均通过切换校验；两个挂载MCP入口用同参数独立tools/list核对了项目默认2/跨项目并行/legacy范围的新描述。health仍degraded，仅保留原三项attention，scanner error=null。旧工作项 `72f58408-16e7-4007-adc2-7aa71c64ccce` 仍blocked/delegation_message_limit，未取消、解锁、复活或重派；没有重启旧发布协调器。

私网 `/happy/` 已发布，HTML和三入口JS线上回读逐字节匹配；手机尺寸匿名页面/未认证Dot guard真实浏览器errors=[]。功能界面另由隔离Relay、实际Codex/MCP和脚本模型验证三类队列原因、branch与取消入口；不是生产真实用户五项目并发或原生手机验收。固定发布包的28项实际Git/子进程/HTTP回归通过，五独立项目真实子进程同刻running、原HEAD/暂存索引保持；同项目第三项等待而其他项目可启动。CLI97/97、宿主相关85/85及追加交办39/39、App组件5/5与相关类型/构建通过，计数有重叠不累计。冻结V1既有断言仍实际12155/预期12154，未改断言或报告全仓全绿。

个人 `@prophetwayen/happy`、preview环境/分支、iOS runtime21、bundle `com.prophetwayen.happy.preview`：[OTA更新组](https://expo.dev/accounts/prophetwayen/projects/happy/updates/ef3ca2da-217f-480d-b5bf-d3422febaa5d)，update ID `01a1c110-4e7d-7ccf-8fbc-731ef53eea49`，源码 `b5e508c1`。preview/production原有共同preview分支映射保持，两渠道实际manifest的项目/bundle/runtime/源码均匹配；preview启动包10,003,656字节、SHA256 `6d97a916b586b317f3fa19593e9125fdf90b22d0ddfcec471d35b919b8d345ad` 回读通过。手机是否接收/加载仍未验证；未发布新原生包、Android包或npm包。

协调器10个阶段完成，`coordination-status.json.status=deployed`。Happy证据根 `/home/dev/code/happy-project-scheduling-release-20261109/.e2e-artifacts/project-concurrency-release-20261109/`，包含fixed-artifact-tests.log、fixed-five-projects.jsonl、actual-ledger-migration.json、mounted-tools.json、web-deployed.json、ota-published.json、ota-served.json、live-policy.json；宿主activation.json/cold-backup.json在新宿主发布目录同名证据子目录。当前Dot只选中testLoop/happy两项目，另一个MCP连接配置五项目；本轮五项目测试均为隔离fixtures，没有扩大此Dot授权或派真实付费任务。

宿主冷备已验证1377文件，并保存7个native home、Happy profile、用户namespace/ledger及Hindsight冷归档：`/home/dev/.local/state/testloop-backups/project-concurrency-20261109-505276e` 及 `-extras`。系统Worker私有维护目录 `/var/lib/happy-automation-maintenance/20261109T143902Z-project-concurrency-b5e508c1e732` 由root保管；当前Agent未绕过权限读取其中私有状态。机器密文/密钥/journal由独立停机段备份，活跃worktree/temporary保留原位并记录，不伪称活动文件是冷快照。旧V1不能读取V2，禁止恢复旧账本覆盖新任务或直接降级；需保留新状态并采用兼容前向恢复。旧Web完整备份及旧产物保留。

## Dot 持久队列与 worktree 并行配套发布（2026-11-09）

两仓已正常合入并推送 main：Happy 功能发布源 `1361131889ddd756444181f0e99ee74af031d3fb`（合入 `8bd56c94`），TestLoop 源 `16a10047c769d8bdea0ceb459b3a186b23603142`（合入 `a0afac75`，追加有界长结果采集修复）。源码与依赖相同的最终合并版本通过 Control 156/156、CLI 97/97、RN/UI 65/65、宿主队列61/61，以及固定发布包17项真实 Git/子进程/HTTP隔离场景。相关类型检查、构建与changelog一致性通过。扩展goal仍47/48，冻结V1前缀12155 !=12154的既有基线断言保留，不称全仓全绿。

Control镜像 `sha256:dca89350a372f69eef58c91ff6b3ced71bcb17afca4a765cc839180f07cda75c` healthy；固定CLI/系统Worker `/home/dev/.local/share/happy-automation/releases/dot-parallel-20261109-13611318`，PID3486604、NRestarts=0、connected=true、state/lock已核验。系统切换由用户在独立WSL终端执行已审阅的新root协调器，没有绕过NoNewPrivileges；9个旧会话根进程的PID/startTicks/cgroup保持。机器账本实测maxConcurrency=2，同OS用户+machineID共享；配置范围1–4，修改额度须按功能文档的idle检查流程执行。

宿主与四个实际Dot MCP/记忆网关均在 `/home/dev/.local/share/testloop-releases/dot-parallel-20261109-16a1004`；scanner PID3498788、recovery PID3500307、心跳更新且error=null。原两Dot session/thread/输入历史、两层记忆与授权通过切换校验，health保留原三项attention。两个实际MCP挂载进程的入口/参数已核对，以同一入口独立tools/list握手验证create.execution、cancel.sendRequestID和worktree/queued提示；这不冒称真实Dot模型已选择新模式。代码任务显式传 `execution:{mode:"worktree",resources:[]}`，再对confirmed会话执行独立send；旧调用保守串行。

私网Web `/happy/` 已发布，HTML和三入口JS逐字节一致，手机尺寸线上匿名路由无页面/Console/HTTP错误。相同最终产物的隔离浏览器验证queued/资源等待/running/canceled、cwd/branch、取消入口和原编辑流程；任务行是隔离契约夹具，不是生产双任务执行。localhost:8989未更新。

个人 `@prophetwayen/happy`、preview环境/分支、iOS runtime21的[OTA更新组](https://expo.dev/accounts/prophetwayen/projects/happy/updates/62960448-e270-4cae-92b9-e2a5e7bd350d)，update ID `01a1c05c-0d99-71b1-a46b-f68ded84e948`。preview/production原有共同preview分支映射未改；两渠道实际manifest均匹配源码 `13611318`、项目、bundle和runtime。启动包10002516字节的SHA256已验证，手机实际接收/加载及原生操作仍未验证。

生产签名MCP→gateway→新Worker真实probe创建独立worktree/branch，send返回queued及queueID `a79dbb8b4cb7229b14441723c0c08e64ffb1d1c58c6be81cbc8cc40ac920064a`，原因execution_slot、executionDispatched=false；定向取消变为cancelled，原空闲会话进程另行停止并独立证明stopped，付费模型0次。授权原testLoop目录的旧HEAD及暂存DEPLOY.md保持，probe的baseCommit为该原目录的ebbd284，未把它当作最终源码验证。

**生产双任务真实并发、第三自动启动及付费模型验收仍待现有legacy活轮次空闲。** 独立用户协调器 `dot-parallel-release-20261109.service` 的自动验收只等待，不停止真实用户工作，不重派历史blocked/not_sent。状态见发布checkout `.e2e-artifacts/dot-parallel-release-20261109/coordination-status.json`、`live-parallel.json`，受理/取消见 `live-queued-cancel.json`，挂载契约见 `mounted-tools.json`。独立产物夹具已验证并发/顺序/资源互斥/取消/SIGKILL及丢ACK恢复，不能替代上述待完成的生产并发证据。

宿主协调冷备1375文件及native home、用户namespace/ledger、Happy profile、Hindsight冷归档在 `/home/dev/.local/state/testloop-backups/dot-parallel-20261109-16a1004` 及 `-extras`，已核验；旧产物和Web完整备份保留。系统Worker私密维护目录为 `/var/lib/happy-automation-maintenance/20261109T122544Z-dot-parallel-1361131889dd`，root状态/备份在普通会话不可读取，此项权限限制未绕过。当前已产生新队列/worktree，受限回滚入口会拒绝直接降级旧Worker，需兼容前向恢复；没有恢复旧账本或实际执行回滚。原失败恢复单元未重跑。

| 隔离最终Web产物验收 | 截图 |
| --- | --- |
| queued原因、独立目录与分支 | [查看](http://100.116.89.36:3210/img-bed/images/2a6647d0-743a-4313-86c2-e9315878e1c8.png) |
| running任务详情 | [查看](http://100.116.89.36:3210/img-bed/images/d1b85614-af1f-40fa-abe2-dd882e0d1995.png) |


## Dot ↔ 用户级记忆移动配套发布（2026-11-09）

功能来源 Happy `0d16e04d38c348822885e5d75010c9242700bab9`、TestLoop `6d3fc66bef9da2c99e16f9fc6fa37c070d524a73`，均在当次 fetch、干净个人 main、正常推送及最终验证后发布。隔离提交 `cf1d9e36`、`40a4e419`、`8a8a37d` 的历史均保留。原主工作区的未跟踪文件与已暂存 `DEPLOY.md` 未纳入提交。

宿主及四个 gateway 已更新；托管 CLI 和系统 Worker 均使用 `/home/dev/.local/share/happy-automation/releases/memory-move-20261109`，Worker PID `3309144`、连接/心跳/state/lock 核验通过，原五个会话根进程保持。Web `/happy/` 已更新，HTML/三入口 JS 字节及手机尺寸真实浏览器回读通过。

个人 `@prophetwayen/happy`、preview 环境/分支、iOS runtime `21`：[OTA 更新组](https://expo.dev/accounts/prophetwayen/projects/happy/updates/131cc65a-3538-4204-a2dc-e4a27ceb7490)，update ID `01a1bdb5-180f-79e6-8b28-53f24a210ca2`。preview/production 原有同分支映射保持，两渠道实际 manifest 的项目、bundle、runtime、提交及 update ID 均匹配。**桌面直接下载 CDN 主包返回 HTTP 403，主包下载字节与手机接收尚未验证，不能据此称手机已经更新。** 手机应用更新后核对提交 `0d16e04d`。

冷备、严格 schema 回滚限制、最终测试和验收边界见 [完整发布记录](docs/research/memory-move-validation-20261109.md#配套发布验收2026-11-09)。真实 Hindsight 使用独立 bank 验证后已清理，真实用户记忆/聊天未被测试写入。宿主仅保留原三项 attention；历史 `dot-recovery-upgrade-20261108.service` 仍 failed，本次没有重跑或清除它。

## Dot 重启后一键恢复发布（2026-11-08）

按用户授权提交推送个人main，私网Web/OTA源`825090126c860fcc5dbf4876ccda27fc9724e6e6`，托管CLI/Control源`aafcd3df42be577b67717e5a9edc801833abea51`（后续差异仅App原生超时修复），宿主源`28eb43a721dda20ecd0d43020616ba2c80ac0216`。发布checkout `/home/dev/code/happy-native-dot-release`为干净独立clone，已当次fetch核对main==fork/main，并确认包含上一OTA的82af9001；无原生接口/依赖变更。

私网`/happy/`的index和3个入口JS与产物字节一致；`/home-relay/v1/dots/recover`通过精确反代连接回环18196独立用户服务。`testloop-assistant.service`、`testloop-dot-recovery.service`均enabled/active，使用`/home/dev/.local/share/testloop-releases/dot-recovery-20261108`；固定托管CLI在`/home/dev/.local/share/happy-releases/dot-recovery-20261108`。Control镜像`sha256:861f025e9ba6c24e2b578fb69d488c98a3e44a1b7587ce2977690bade672c29a` healthy，旧锁停机留档、授权目录保持，依赖锁文件与原镜像一致。全局Happy/daemon未替换，Relay和执行Worker未重启。

个人`@prophetwayen/happy` preview环境/分支、iOS runtime21、bundle`com.prophetwayen.happy.preview`：[更新组3ba69aa4](https://expo.dev/accounts/prophetwayen/projects/happy/updates/3ba69aa4-47b2-40d7-9346-21a85595fd06)，update ID `01a1bba0-13be-7404-bf85-0f4a70c6239a`。preview/production原有映射均指向preview，本次未改；两渠道manifest及主包9,984,688字节SHA256回读通过。EAS可选assetmap上传socket hang up，已查CLI源码按warning返回null；实际bundle/manifest/下载哈希通过，不将辅助上传称为成功。未做真机接收或整机重启验收。

已部署产物的隔离手机尺寸浏览器恢复、原session/thread/聊天和刷新保持通过，errors=[]、付费模型0；真实账号停宿主后经私网接口并发恢复双Dot，202及原thread保持；未登录401、旧绑定409。原三项attention仍保留、scanner error=null。原生AbortSignal.timeout不支持已先红后绿修为AbortController；定向回归共60项及对应编译/类型通过，未跑全仓测试。

冷备与回退证据在 TestLoop `.e2e-artifacts/dot-recovery-release-20261108/`，完整冷备`/home/dev/.local/state/testloop-backups/dot-recovery-20261108T1444`及-extras。首轮激活因并发指标快照告警自动回滚，使用状态锁一致快照后第二轮通过；工作区链接、Docker本地镜像名称、Nginx reload瞬时旧worker、可选上传及未经授权的资产探针失败均保留原记录并说明。旧Control回退前必须停唯一实例并留档v2 marker，不能抢占运行中锁或删除`.gateway-lock` inode。详细操作、错误与验证边界见 TestLoop `DEPLOY.md` 本次发布章节。

本文件提供当前部署入口；个人项目身份、Git 发布线、授权范围与最低充分验证规则以
[AGENTS.md](AGENTS.md) 为准。历史发布结果只证明当时状态，每次发布仍需核对线上版本。

## 手机编辑按钮与 App 版本核查（2026-11-08）

用户反馈手机 Happy App 的 Dot 管理编辑按钮无法点击。当前 preview iOS OTA 回读仍为 `bdb246abeaf6`（group `78d1ee75-9a8c-47dc-948a-33395e04ddfa`，runtime 21），未包含后续模型/effort 编辑功能；真机实际加载版本未验证。此前整合发布未发 OTA。

Web 修复源码 `dc9379fbae3746e54038c3834cc0686e7109922e`：等待 list/inspect 回执时允许打开缓存配置，写操作仍等待确认；编辑表单显示等待状态和超时重试。隔离手机触屏在旧产物上复现按钮 disabled，修复产物验证创建默认 codex/gpt-6.1-sol/xhigh、编辑保存、延迟回执、恢复保存和刷新保持。脚本模型请求的 model/effort 与保存配置一致，付费模型 0；模型派发使用桌面键盘发送路径，不代表真机发送验证。组件7项、App类型与changelog一致性检查、干净个人main导出通过。

私网 Web 已部署，HTML及3个入口JS回读逐字节一致，手机尺寸线上登录页无页面/Console/失败请求。真实现有Dot仅认证只读核对绑定、名称/职责和8项模型目录，未改配置、记忆或任务。证据在 TestLoop `.e2e-artifacts/dot-edit-20261108/`，完整旧Web在其中 `previous-web/`；旧hash资源保留，无服务重启。Tailscale与用户故障的因果未证实。手机App尚未发布本次OTA，需要另行个人preview iOS OTA发布和真机复核。

## 本机 / Tailscale 私网部署（2026-11-07）

**基础设施与在线客户端已切流；已补充浏览器首屏及用户手机登录页验证，登录后业务未验收。** 当前入口为
<https://desktop-8ut4p0p.taild92624.ts.net/happy/>，Relay 为同源 `/home-relay`，
Control REST / MCP 为 `/happy-control/v1`、`/happy-control/mcp`。仅 tailnet 可达，
没有启用 Funnel。Windows Serve 持久代理 `http://127.0.0.1:18194`，后端都绑定回环。

本机 Relay 配置在 `/home/dev/code/happy-relay`，新卷为
`happy-relay_relay-data-tailscale-20261107`；Web / Control / 网关配置在
`/home/dev/code/happy-local`。旧本机 Relay 卷与两端冷备均保留。
Web 复用已发布的 `bdb246abeaf6` 产物，仅注入私网 Relay 地址，未重建 CLI 或发布 OTA。

最终同步核对 23 张表、707 个会话、225907 条消息与 132 个附件；两台电脑和 29 个
在线会话通过已有协议切服，Worker 以独立 systemd 维护单元重启。
3 个 MCP 连接地址更新后授权 scope 保持；两个 Dot ready、原 thread 保持，scanner error
为空。退役后回读 32 个活跃会话、2 台机器的 90 秒内心跳通过。

99.57 的 Happy Web、Relay、Control 和旧静态版本路径现在返回 410，其他项目配置未改；
99.55 的旧服务与临时桥均停止，Control 开机启用已取消、旧 Relay restart policy 为 no。
21 项 HTTPS / 公网退役 / WSS 检查、3 组 MCP 到 Worker 的只读目录检查，以及已有附件
的认证下载与文件哈希检查通过。原三项历史 attention 告警仍在，整体 health 仍 degraded。

手机需先连接同一 Tailscale 网络，在 Happy 服务器配置中填写
`https://desktop-8ut4p0p.taild92624.ts.net/home-relay`；新 Web 域名需登录原账号。
备份、迁移边界、运行命令和回退约束见 [部署手册](docs/deployment.md#本机与-tailscale-迁移2026-11-07)。
手机 / 桌面客户端配置、直连判断和日志命令见
[Tailscale、Shadowrocket 与 Clash Verge 使用说明](docs/features/tailscale-access.md)。

## 私网 Web 首屏缓慢修复（2026-11-07）

本机 Nginx 迁移配置漏掉了旧网关已有的 gzip，主 JS、common JS 与 WASM 合计约
20.82 MB 均以原始大小传输，叠加手机经美国 DERP 中继、未直连，使首次加载很慢。
已为现有静态文件生成 gzip sidecar，开启协商压缩，并为哈希 JS / 字体设置长期缓存；
HTML 保持 no-cache，固定名 WASM 仍以 ETag 校验。三个主要资源降至约 6.46 MB，
解压后与原文件逐字节一致。只热重载本机 Nginx，未改 App / CLI、发布 OTA 或重启 Relay。

经用户授权的隔离 Chromium 验证，桌面及手机布局均能显示登录页，未发现页面 JS 错误
或失败请求；模拟 1 Mbps、400 ms 延迟时首次手机布局约 40.6 秒。用户随后确认 Safari
已出现登录页。后续宿主 `status` 与 `ping` 确认手机已建立 direct，延迟约 49 ms，用户反馈
速度很快；这是当次链路结果，登录后收发仍未验证。证据及剩余边界见
[首屏修复记录](docs/deployment.md#web-首屏加载缓慢修复2026-11-07)。

## Dot 删除提示误报与空 thread MCP 刷新修复（2026-11-07）

源码提交 `bdb246abeaf6e44f65f406048b5ed67bfda64149`（`fork/main`）。工作台不再在每次挂载时播报历史删除回执，仅当前视图发起的删除提示一次；本地会话归档仍按回执静默核对。托管运行时在 MCP 集合变化时区分 thread 状态：已派发过输入的 thread 继续 `thread/resume`，从未派发输入的空 thread 因 Codex 没有 rollout 而改为重建；单次刷新失败保留原 MCP 并每 30 秒重试，不再把会话置为 blocked。

发布目标：托管入口 `/home/dev/.local/share/happy-releases/dots-refresh-recovery-20261107T102059Z/packages/happy-cli/bin/happy-hosted-dot.mjs`；Web `.happy-releases/20261107T102059Z-dots-refresh-recovery-bdb246abeaf6`；iOS preview OTA update group `78d1ee75-9a8c-47dc-948a-33395e04ddfa`、iOS update ID `01a1b596-35ab-7548-903f-58a3fad81461`（runtime 21）。宿主切换与冷备记录见 TestLoop `DEPLOY.md` 同日条目。

验证：`hostedDotMain` 14/14、dots 组件 31/31、App `tsc --noEmit` 通过；Web 构建产物与公网回读字节一致。手机真机是否已加载本次 OTA 未验证，不能由发布成功推定。

## Dot Yolo 权限传递修复（2026-11-07）

托管CLI `25641588332c16c0f20380086248b27c3392ae20` 在接收和恢复原生用户输入时保留permissionMode。TestLoop `1d1fea23de50d72ed8ce8968fb3830fd16d68857`将当前用户模式传入Happy MCP任务启动，Yolo在Claude目录中对应bypassPermissions；模型default不再覆盖选择，普通模式不被模型升级，授权未开放时明确拒绝。已启动会话的冻结模式与新用户模式校验，旧回执保持幂等。主Dot沙盒和项目/Token授权不变。

仅切换Dot宿主与隔离托管入口 `/home/dev/.local/share/happy-releases/dots-yolo-20261107T042334Z/packages/happy-cli/bin/happy-hosted-dot.mjs`，未更新全局CLI/daemon，未改App/Web/OTA或Relay。原Dot/session/thread、历史和记忆保持。Happy hosted/state14项、宿主45项及相关编译通过；公网真实浏览器9组（脚本模型）通过。真实Claude/Ali DeepSeek v4.1 Flash/max以bypassPermissions执行最小Python只读命令，人工授权0次，结果回原Dot、重启不重派通过。真机发送未验证，原三项历史attention未新增。

详细策略及权限边界见[TestLoop功能文档](https://github.com/prophetw/testLoop/blob/main/docs/features/dots-mcp-migration.md)，证据位于TestLoop `.e2e-artifacts/dots-yolo-20261107T042334Z/`，备份和验证范围见其DEPLOY.md、E2Etest.md。

## Dot 原生会话与 Happy MCP 收敛（2026-11-07）

源码 `f7b8d29d1e583b667b7029f4f6a18381ed0f8511`，从干净隔离个人main、与fork/main一致发布。App删除Dot的REST管理/迁移入口，仅保留MCP连接和显式项目选择；托管CLI支持一次性导入旧user/assistant历史、处理水位接续、原thread冷恢复和未知注入阻塞。宿主负责权限、回执与后台任务恢复，临时调查直接通过Happy MCP派工，不需要delegate模板。旧历史审计、冻结目标及Happy内部HTTP保留。

- Web：[入口](https://szsp.suitbim.com.cn:7100/happy/)，版本 `20261107T024306Z-mcp-converge-f7b8d29d1e58`，包SHA256 `c314d1fe2e2c9e6f99143dabd280ee7661c0834c4027a69527f27585ace4039b`。旧资源187项保留，nginx/Relay未重启。
- iOS：[OTA更新组](https://expo.dev/accounts/prophetwayen/projects/happy/updates/d5a1c688-d2bd-4281-b6e2-5864adb1fad4)，updateID `01a1b410-aba7-76f4-ad83-a75e749b7a5d`；个人@prophetwayen/happy、preview环境/分支、runtime21、bundle com.prophetwayen.happy.preview。preview与production保持原有的同一preview映射；两渠道manifest身份、源码和环境回读一致。真机加载未验证。
- 托管CLI仅从 `/home/dev/.local/share/happy-releases/dots-mcp-converge-20261107T024306Z/packages/happy-cli/bin/happy-hosted-dot.mjs`运行，不替换全局CLI/daemon。TestLoop `982a1d2625d5eb239e731a025e685f1fe79c3aed`将现有Agent开发Dot原地迁移，保留原Happy session、16条历史与规范记忆；其他活跃native thread保持。

Happy hosted/state13项、App面板16项及类型/changelog检查通过。公网Web/Relay隔离浏览器7组通过，覆盖MCP选择、旧历史交接/新请求不丢、派工/前台续聊、重启不重派、结果回原thread和实际执行链接；脚本模型7次、付费模型0次，页面/Console/非预期HTTP及清理错误为空。真实账号原Dot的bim-server调查完成并汇总回传，工作项 `d48b2d00-8e36-480d-959d-acf7ec1fd98e`、执行会话 `cmw5ul7nk1t7xms1d7fdqao1s`；前台续聊、同thread重启和不重派通过。实际执行使用Claude/Ali DeepSeek v4.1 Flash/max/default，35项只读权限单次放行；未扩权，不将其描述为无人值守。业务验收状态仍unverified，结果保留，自有执行进程停止已确认。

详细架构见[TestLoop功能文档](https://github.com/prophetw/testLoop/blob/main/docs/features/dots-mcp-migration.md)，验证边界及失败记录见[TestLoop E2Etest.md](https://github.com/prophetw/testLoop/blob/main/E2Etest.md)。证据位于TestLoop工作区 `.e2e-artifacts/dots-mcp-converge-20261107T024306Z/`；宿主备份和恢复记录见其DEPLOY.md。硬件断电恢复未验证。


最终线上回读7组通过：MCP管理、所有活跃Dot、已删除Dot拒绝、完成工作/执行链接、跨Dot工作拒绝、原thread在线、规范记忆与无新旧解释轮次均核对。原三项attention未增加，旧记忆revision1已indexed。已退役REST RPC回读得到`RPC method not available`；初次12秒观察超时因Relay对缺失方法先等待15秒重连宽限，改为25秒取得结构化拒绝，未调整生产超时策略。

## 发布来源与准备

- 常规发布使用已提交的个人 `main`。当次执行 `git fetch fork main`，确认
  `HEAD == fork/main`，发布 checkout 干净，包括未跟踪文件。
- `fork` 指向 `git@github.com:prophetw/happy.git`；`origin` 是上游
  `git@github.com:slopus/happy.git`，仅按用户要求吸收更新，不向上游推送。
- 开发工作区有其他改动时，使用独立、干净的发布 clone；不依赖固定 worktree 路径，
  不擅自 stash、清理或提交其他改动。提交、推送与实际发布分别按用户授权执行。
- 使用根 `package.json` 指定的 pnpm（当前 `10.11.0`）；安装使用仓库 `.npmrc`
  中的阿里云 npmmirror。仅在依赖变化或缺失时安装。
- 新 checkout 缺少共享包产物时，先在仓库根执行
  `pnpm --filter @slopus/happy-wire run build`，再检查 App。
- 验证范围按变更选择。发布 App / Web 时检查类型与 changelog 一致性；不因修改文档
  自动执行完整构建、全量测试、部署或 daemon 重启。测试失败必须调查，不能套用旧失败名单。

## Happy Web

当前私网入口为 <https://desktop-8ut4p0p.taild92624.ts.net/happy/>，同源 Relay 基址为
`https://desktop-8ut4p0p.taild92624.ts.net/home-relay`。

| 项目 | 当前部署 |
| --- | --- |
| Windows 网关 | Tailscale Serve → `http://127.0.0.1:18194` |
| 本机 Nginx / Control Compose | `/home/dev/code/happy-local/compose.yaml` |
| Nginx 配置 | `/home/dev/code/happy-local/config/nginx.conf` |
| Web 静态目录 | `/home/dev/code/happy-local/web` |
| 本次发布产物来源 | 99.57 原 `happy` 的 `bdb246abeaf6` 版本，已复制并注入私网地址 |
| 迁移证据 | `/home/dev/.local/state/happy-local-migration-20261107` |

[旧 Web 构建与发布手册](docs/deployment.md#web复用现有-https-域名并挂载到-happy)
中的 99.57 上传、符号链接切换和公网 URL 是历史流程，**不再作为当前发布目标**。
后续发布需要先适配本机目录、私网 Relay 与配置注入，不能直接重开旧公网路由。
Web 与 iOS 仍需保持个人发布主线及原有验证要求。

Dots 正式工作台仍为 `/happy/dots`，使用原会话、原 TestLoop 账本和 MCP 授权。
本次未新建 Dot、清空历史、重派任务或修改模型、权限模式和额度。

## Relay

当前实例为本机 `/home/dev/code/happy-relay`，监听 `127.0.0.1:8193`，由本机 Nginx
剥离 `/home-relay` 前缀并转发 WebSocket。`RELAY_PUBLIC_URL` 已设置为上述私网 Relay
基址；原镜像、主密钥和账号策略保持，数据库与附件迁到新的外部命名卷
`happy-relay_relay-data-tailscale-20261107`。

99.55 原 Relay 已停用，原卷与最终冷备保留。SSH 部署脚本仍默认 99.56（已在脚本内标注为历史目标，未显式传 `--host` 时会告警），旧文档中的
99.55 定向发布也不代表当前本机目标；不要直接照搬旧命令覆盖已有本机卷。
具体启动、备份及回退约束见 [本机迁移记录](docs/deployment.md#本机与-tailscale-迁移2026-11-07)。

## 手机 App：OTA 与 TestFlight

个人 Expo 身份、`preview prophet` 渠道、预检、发布命令及回读要求见
[AGENTS.md](AGENTS.md#3-preview-prophet-的个人发布目标)。执行发布前阅读
[release 技能](.agents/skills/release/SKILL.md)，上游默认值以个人约定覆盖。

`packages/happy-app/app.config.js` 包含上游默认身份，个人发布必须显式加载已核验配置，
不能依赖未提交的本机修改。纯 JS OTA 保持与安装包兼容的 runtime；原生接口变化时，
更新 runtime 并重建安装包。原生构建与送达 TestFlight 分别核验，不将构建完成视为可安装。

现有 `pnpm ota` / `release:build:*` 的预检脚本仍检查 `origin/main`，尚未适配个人
`fork/main`。按 `AGENTS.md` 完成个人预检后使用明确的 EAS 命令，不整体跳过发布检查。
回滚使用已核验个人项目的 EAS 机制，明确恢复版本、兼容 runtime 和受影响渠道。

## CLI 与 daemon

本地构建、安装参考 [dev 技能](.agents/skills/dev/SKILL.md)。CLI 的包名是 `happy`，
构建使用 `pnpm --filter happy run build`；不默认替换为上游 npm 的 `happy@latest`。

先通过 `command -v happy` 与实际链接核对安装路径。已链接到目标源码且依赖未变时，
构建后显式重启 daemon，无需重复 `npm link`。停止与启动必须放在独立进程执行的同一
序列中，避免当前会话终止后停在未启动状态，具体要求见
[AGENTS.md](AGENTS.md#执行顺序与耗时控制2026-10-23-实操经验)。

重启后核对 daemon PID、实际 `dist/index.mjs` 路径和启动时间晚于构建产物 mtime；
版本号可能不变，不能仅靠版本号判断是否更新。已有会话进程不会随构建自动替换代码。
