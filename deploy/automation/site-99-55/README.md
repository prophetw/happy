# 99.55 REST / 99.57 HTTPS：长期服务，测试范围任务控制已验证

## 浏览目录授权已上线（2026-11-04，待本人批准新授权）

已按本人明确授权更新55 REST、57 Web与4090原机器worker/daemon，固定应用树 `d8758551bf3b482093b251c1cc9af16add8a216e`。两端 `directorySelection.roots` 均为 `/home/dev/code`；保留原A/B登记、方法、身份、公钥、provider、期限策略和既有会话范围。根目录只是可选择边界，不直接授权整个目录树；旧令牌不会扩权，新选目录须新建并明确批准授权。

线上入口：`https://szsp.suitbim.com.cn:7100/happy/settings/automation-service`。本人登录后，浏览/输入具体目录，重复添加多个，点击“让 Worker 核实所选目录”，审查真实路径，再创建申请并单独批准。未替本人签发令牌或执行真实业务任务。

REST健康，公开宣告directoryScopes=1、OpenAPI1.4.0；新worker PID3634349连接原machine。原1条会话PID/startTicks/cgroup保持，16份旧持久状态字节一致，4个有效服务授权原范围保留；无新v3 grant。relay与57 Nginx容器/配置/路由未改，Web仅原子切换静态target。

14项维护安全测试、精确镜像76项原生Nginx/mTLS隔离检查、40项绑定新版entry JS的线上匿名浏览器检查通过；应用73后端/31前端合同沿用同一输入，完整Web导出及隔离worker冻结离线安装/构建通过。真实账号的目录RPC、v3批准/后端任务和失败恢复分支尚未验收；原生App/OTA/MCP未发布或注册。

记录见 `validation.directory-selection-live-2026-11-04.json`。55运维记录：`/data/code/happy-control/rollouts/20261104T093203Z-directory-selection`；4090记录：`/var/lib/happy-automation-maintenance/20261104T093203Z-directory-selection`。保留当前state及新REST，worker回撤仅处理本次70-release，保留原60-release和凭据；真实故障分支未演练。未commit/push/merge。

## 浏览目录授权扩展准备记录（维护前）

已新增owner在机器上浏览/多选目录的scope v3流程，复用现有目录选择器、加密machine RPC以及原出站worker/授权/任务内核。真实路径由在线worker核实，selectionID两分钟有效且一次性使用，批准时再核实；旧授权及已部署A/B范围不变。只读独立review通过；目录RPC的浏览器transport为fixture模拟，真实机器目录RPC和v3本人批准未验。

启用示例仅在 `directory-selection.fragment.json.example`，不应用现网。需要REST/Web/worker配套升级，并获准在host对应workers[]和worker.registration同时设置具体 `directorySelection.roots`；根目录本身不授予访问，令牌只绑定用户实际选中的1–32个目录。本轮没有改线上配置或服务、创建真实grant/token，未发布App/OTA或注册MCP。证据见 `validation.directory-selection-local-2026-11-04.json`，用户流程见 `docs/features/automation-service-access.md` 的浏览目录章节。

## 多项目版本已上线（2026-11-04，待本人批准新授权）

本次获准维护窗口已部署固定应用树 `11313dcc1ba0100d09a4fbfe4caeb17f750665c6`：55 REST为新镜像2df3bd95…，57 Web已切换到`.happy-releases/multi-project-11313dcc1ba0`，4090现有受管worker/daemon已更新到同一应用输入的独立release。HTTPS宣告projectScopes=1、OpenAPI1.3.0，新workerPID2329759连通原machineID。窗口内1条原会话PID/startTicks/cgroup全部保持；原relay和57 Nginx容器/配置/路由保持，不重启或重载。

`automation-test` 与 `automation-test-b` 已在host和worker双边登记，B目录为 `/home/dev/code/happy-automation-test-b`，dev:dev/0700。已有2个服务授权保持原单项目范围，13份原持久状态记录字节一致，没有代本人创建多项目grant或生成令牌。本人刷新 `https://szsp.suitbim.com.cn:7100/happy/settings/automation-service` 后，选择服务、两个目录和必要方法，单独审查批准，再一次性交付令牌给后端。新增目录/部署不等于授予已有令牌新权限。

12项维护控制器安全测试和独立复核通过；真实新worker启动/同machine/原会话身份与40项新版资源绑定的线上匿名浏览器检查通过。真实登录批准、两项目后端任务/撤销和失败恢复分支尚未验收；原生App与MCP仍未发布/注册。原项目的账号加解密材料继续留在4090，沿用现有签名身份和凭据托管，无新密钥/设备。

记录见`validation.multi-project-live-2026-11-04.json`。55回退材料位于`/data/code/happy-control/rollouts/20261104T081557Z-multi-project`；4090维护记录位于`/var/lib/happy-automation-maintenance/20261104T081557Z-multi-project`。优先保留新REST及当前state，worker仅撤回本次归属明确的release drop-in；真实失败分支未演练，不恢复旧state、不删未知锁。当前全局happy和原main/dist未改，继续用受管worker单元管理服务。未commit/push/merge。

下方未部署/待维护文字保留准备阶段的历史边界，以本节及最新线上记录为准。


## 多项目版本发布准备（2026-11-04，未部署）

固定应用树11313dcc1ba0100d09a4fbfe4caeb17f750665c6的REST镜像、完整Web导出及隔离worker运行包已在本地准备，来源和摘要见`multi-project-rollout.json.example`。新镜像64项原生Nginx/mTLS检查、Web导出匿名桌面/手机28项检查、worker隔离构建及27项合同通过；先前61项后端/27项前端/多选浏览器验证沿用同一应用输入。

用户已把`/home/dev/code/happy-automation-test-b`选入未来验收计划，当前仍不存在、未追加到host/worker白名单、未创建真实grant。实际发布顺序及回退见`multi-project-rollout.md`；模板只准备，不安装或重启服务。当前运行的REST/Web/worker仍是下节单项目版本；worker必须在明确维护窗口中更新，不能只发布多选前端。旧worker迁移脚本不适用于已有受管服务的本次升级。

## 服务令牌已部署（2026-11-04，待本人及接收后端验收）

本人此次明确要求上线。固定应用源码树 `d587ffdf686c46509cc59a4cc88a63991ad638a1` 已构建为 image ID `sha256:a9e59fb0cde80557db85b7e0be9b75e11cc17fc5bcc68361ca82a4a622e41563`，新镜像和生产同版 Nginx 的 52 项容器隔离检查通过后，已切换 99.55 REST 控制对与 99.57 Web 静态目录。沿用原签名1小时策略、mTLS、反代和4090 worker；relay、现有57 Nginx容器与worker/daemon均未重启，未向任何会话发测试指令。

线上入口：`https://szsp.suitbim.com.cn:7100/happy/settings/automation-service`。本人登录Happy后重开此页，选择“后端联调测试”、`automation-test`、所需方法及期限（最长30天，建议首次短时验收），创建申请并在5分钟内明确批准，再点击一次性交付。原worker只准 `/home/dev/code/happy-automation-test`，既有会话默认不包含；网页默认只读，派发任务需另选创建/追加，停止需另选取消。项目scope不是OS文件沙箱。令牌不要发到聊天、URL或日志，交给接收后端自己的secret provider；本次没有替本人批准、生成令牌或配置后端密钥托管。

HTTPS compatibility 已宣告 serviceTokens.protocol=1 / maxGrantMs=2592000000；OpenAPI、首页/批准页/服务页、JS和WASM均200，匿名owner端点依次受Origin及登录认证保护。桌面/手机共40项真实匿名浏览器检查通过；原已到期的签名grant在启动核对时仅将state改为expired，其余6份持久记录字节保持，proof按正常TTL修剪。当前服务grant/token仍为0；真实登录、生成及对方后端任务验收待本人操作。当前站点未启用HTTP MCP，REST令牌不能充当OAuth/MCP注册。

公开证据与完整摘要见 `validation.service-token-live-2026-11-04.json`。55发布/回退材料在 `/data/code/happy-control/rollouts/20261104T064226Z-service-token`，源码和镜像归档在 `/data/code/happy-control/archives`；57当前target为 `.happy-releases/20261104T064226Z-service-token`，保留旧target及hashed资源。优先保留新binary撤销/关闭服务模式，始终保留当前state；本次state检查点仅哈希清单，不是可恢复备份。真实故障回退/整机重启及接收后端托管未验证。未commit/push/merge。

下方“仅准备”“尚未部署”等部分保留各阶段的历史边界，以本节及最新线上证据为当前状态。

## 服务令牌上线配置准备（仅本地，未部署）

已准备`service-token-rollout.json.example`、只读审阅器`service-token-plan.mjs`及执行/撤回手册`service-token-rollout.md`。运行`node deploy/automation/site-99-55/service-token-plan.mjs --review`可查看公开配置缺项；即使公开资料齐全也不声称deploymentReady。此包只提出55镜像/公开字段和57静态页更新，复用原反代、TLS和4090 worker。真实身份、制品摘要、后端secret provider及安全交付尚待确认；不在计划中放凭据。

计划锁定上一轮已验证的应用源码树，并保存本地忽略的源码归档防止未提交对象被清理。回撤优先保留新binary撤销服务grant；若降级必须额外通过状态兼容测试，配置和镜像配套回退，保留当前撤销和幂等状态。该包没有apply/SSH/Docker或真实授权动作，本轮未访问部署主机。记录见`validation.service-token-plan-local-2026-11-04.json`。

## 本地新增服务令牌模式（尚未部署）

已在clever-ocean本地增加显式opt-in的`service-token-v1`：owner创建有限scope、原批准页显式确认模式、一次性交付256-bit令牌、服务端只存摘要，原REST任务内核和worker双重校验复用。固定30天上限不改变签名grant默认1小时和其7天配置上限；线上没有启用此字段或生成真实凭据。新功能说明、API和运行命令见`docs/features/automation-control.md`的服务令牌章节，配置片段是`deploy/automation/service-tokens.host.fragment.json.example`，本地验证记录是`validation.service-token-local-2026-11-04.json`。

旧批准页缺少credentialMode确认时返回426。服务身份当前需要操作方预登记；第一次真实启用需要审阅部署配置、服务归属、worker允许项目/方法、最长授权期限及接收后端的秘密托管/交付，不能仅复制本地构建上线。已有生产/试部署/真实任务记录保持历史；本次没有操作线上服务、账号、设备或grant。

## 本人批准后的真实任务验收（2026-11-04）

本人已在Happy批准连接`391cb63d-9b3b-4394-b6c4-80ac5d579112`。实际签名REST→99.57反代→99.55控制→4090出站worker链路已验证，范围仅`automation-test`=`/home/dev/code/happy-automation-test`和本连接创建的会话，9个既定方法，到2026-11-04 12:38:08 UTC+8失效。没有长期续权或其他项目授权。

真实创建一个专用Codex会话`cmw1kwkr40062ml1dq4vabqsr`，运行参数确认`gpt-6.1-sol`/high。两轮短文本任务分别产生明确completed终态及指定turn结果，已验证列机器/会话、分页、稳定requestID回查、同键创建/发送去重、同键不同内容冲突、真实relay消息回读与单条提交、增量cursor、结果归因；虚构的越机器/项目/会话目标均被SCOPE_DENIED拒绝，没有向既有会话发测试。

第三轮只做文本输出，观察到running后请求取消：先收到cancel_requested/stopping，后续receipt和status均为stopped；本机PID1725440及进程组探测均ESRCH，已知组员均退出，worker仍PID737095且active。中断轮没有写出终态事件，因此其result保持ready=false/outcome=unknown；不能把进程停止写成completed或伪造cancelled结果。没有在本轮重启/部署服务、实际撤权/到期或断连故障演练；专用MCP平台注册仍未完成，当前实际使用现有运维SSH权限下的固定签名adapter。

公开证据：`validation.task-2026-11-04.json`。下方“待批准”等文字是此前阶段的历史状态；本次并未实际观察用户账号扫码登录，只核实本人批准后的真实调用。

## 助手批准页 UI 更新（2026-11-04）

已发布新的静态Web批准页：中文权限分区、状态标签、显式登录入口；机器/项目目录/方法/会话范围/期限直接可见，长ID和公钥指纹可展开核对。二维码默认收起，过期申请不显示批准或扫码入口。批准/撤销回包丢失只读回查，仍不确定则显示结果待核实并禁止重复批准；旧请求响应不能覆盖当前连接。未改变REST授权协议，也未代用户批准。

14项相关合同、App类型检查、Web导出、15项loopback浏览器情景、20项线上匿名桌面/手机检查通过，独立只读复核没有剩余必修项。保留135项旧资源，原子切换静态symlink，没有重载/重建Nginx或操作relay/worker。固定源码快照及回退目录见`validation.ui-2026-11-04.json`；未commit/push/merge。真实账号扫码、本人批准和任务验收仍待完成。

验收中历史relay身份一致性检查失败：发现relay已于03:36:44 UTC被外部替换，早于本次静态页准备；操作者未核实。本轮未更换relay。当前新relay健康、HTTPS health为200，4090受管worker仍PID737095、active并持续connected；因此不能沿用“原relay容器始终未变”的历史表述。已将该变化及重新核验结果单独记录。

## 当前维护窗口结果（2026-11-04，worker已接入，待本人批准）

用户明确选择现在执行维护窗口。4090使用现有Happy机器接入`happy-automation-worker.service`，没有新账户、设备或逻辑机器。新daemon从`/home/dev/.local/share/happy-automation/releases/20261104T021514Z-worker/packages/happy-cli/`运行，global happy仍指向原Main且原dist未改。27项CLI合同、1项签名取消测试、4项迁移安全测试及完整隔离CLI构建通过；冻结安装复用842缓存包，补正源码已使用的`@anthropic-ai/sdk@0.110.0`类型devDependency，lock仅增3行，无运行时SDK升级。

实际迁移使用独立Root oneshot，验证旧PID/starttime/exe、控制端口、机器与CG后POST本地stop。新worker同一machine连通，原21个session的PID/startticks/CG全部不变；随后真实systemd worker stop/start成功，state/lock由本进程自然释放，未归档/偷取未知锁，凭据由systemd重新装载。worker启用开机启动，正常使用`systemctl start/stop/restart happy-automation-worker.service`，不要以旧global CLI启动模式代替受管worker。正常App/CLI版本仍1.2.5，automation能力依据协议1实时协商。

关键关闭保护：`KillMode=process`只管理daemon主PID，不以control-group清理agent会话；签名HTTP在shutdown时可abort，远端announcement有界，专属state清理核验PID/UID/原锁FD inode，不调用legacy无条件clear；worker退出后signer.close。未知ownership仍保持并失败关闭。`worker-transition.py`只允许本次invocation、已证实退出的owner元数据进入Root-only同FS审计备份；不是通用stale lock自动恢复。单次controller已退出，新worker继续存活；没有实际触发rollback，旧daemon恢复分支仍未真实故障演练。

99.57批准页已发布到`/happy/settings/automation`，保留83项旧hashed assets以兼容已有打开页面，使用原静态站点的原子相对symlink切换，不重建Nginx。实际首页/entry JS/WASM magic+MIME/批准路由/relay/REST检查通过。随后获准使用全新隔离浏览器，实际Playwright桌面及手机尺寸共22项检查通过：批准页渲染、connection参数保留、脚本/字体等资源200、无页面异常/控制台error/失败请求、无横向溢出。未登录时显示`OWNER_AUTH_REQUIRED`、无批准按钮，未发出受保护REST请求；仅允许同源GET/HEAD，没有登录、扫码、代批准或任务操作。发现每个尺寸一条既有`dev/masked-progress`开发路由警告，HEAD已有同一声明，本次不改无关路由。浏览器已关闭，截图和完整脱敏报告保留在本地`.e2e-artifacts/automation-approval-20261104/`；**已登录审查、真实扫码和批准仍未验证**。旧手机不需要OTA即可扫码登录Happy网页，再在Web内批准独立助手连接；原生专用automation QR页面未发布到手机，不应让旧手机直接扫描该专用scheme来替代Web审查。

下一步只申请有限连接：4090现有machine、`automation-test`=`/home/dev/code/happy-automation-test`，9个固定控制方法，只准本连接新建的专用会话、无既有session，首次验收55分钟（部署policy仍1小时）。申请仅pending、5分钟内需本人在已登录Happy网页确认；过期失效，不自动放行或延长。助手与worker独立签名身份已登记，Happy账号密钥留在4090，真实有效grant在本人批准前为0。批准后才做独立新任务create/send/requestID/cursor/turn结果/cancel实际退出验收，不向bridge或日常session发测试。

本轮公开证据见`validation.worker-2026-11-04.json`；下面production/trial部分为此前阶段记录，其worker=0、批准页未发布等字段不是当前状态。MCP平台注册仍未配置，当前已有执行工具→固定运维SSH adapter→签名REST已实际可达；不要称专用最小权限MCP/SSH principal已安装。


## 当前状态（2026-11-04，长期凭据方案已获明确批准）

REST和内部mTLS已从24小时试部署切为长期服务；原试部署到期timer已在新链验收后撤除。55启用`happy-control-pair.service`开机启动；两机有独立TLS ensure/renew timer。55/57各自保存专用CA私钥，不互传私钥，仅交换公有信任根。CA有效期5年、叶证书30天，剩余14天时续签；CA剩余90天时拒绝自动发新leaf，需人工重叠换根。已实际分别轮换一次叶证书、剔除trial CA、核验新链和入口200。未来按日触发、整机重启与CA灾难恢复尚未发生，不能写成已验。

用户明确接受专用服务凭据保存例外：目录root:0700，文件0400/0600；TLS叶私钥和服务解锁材料可在本机root-only文件中明文持久保存；CA和助手签名私钥使用加密PKCS8。解锁材料与密文同机，依赖root和主机安全，**不是所有secret静态加密或HSM隔离**。Happy账号E2EE材料仍仅由4090受信worker使用，没有复制到55/57或聊天。新的助手公钥已登记，workers仍为空、真实grant为0，REST健康不等于可执行任务。

本会话已有执行工具和获授权的SSH可调用固定适配器：`root@192.168.99.55`上的`/usr/local/libexec/happy-control-call.py`，JSON stdin→短时无端口、log-driver=none的Node容器→独立密钥签名→57完整路径反代→55 REST。源签名私钥加密保存于`/etc/happy-control/secure/assistant/`；每次在`/run/happy-control-caller/`受控装载并清理。真实签名请求已通过认证后被不存在的grant拒绝（`NOT_FOUND`），没有派发任务。它是REST内部adapter，不是最终用户CLI平台，也不等于dot已注册MCP；不暴露任意shell/HTTP工具。此路径复用已存在的运维Root SSH权限，没有新建SSH账号或grant；不能将它称为已部署独立最小权限connector身份。供其他云端平台日常使用时仍应接入其支持的受限工具托管，不把运维SSH密钥交给工具参数。

```sh
# 无需在聊天或参数提供密钥；当前无grant会被拒绝。
printf '%s' '{"tool":"happy_machines","input":{"limit":1}}' | \
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@192.168.99.55 \
  'python3 /usr/local/libexec/happy-control-call.py'
```

固定工具与MCP共用`toolContracts`：happy_machines、happy_sessions、happy_create_task、happy_send、happy_status、happy_events、happy_result、happy_cancel、happy_request_status；专用happy_request_connection只能使用操作方预置的connectionScope申请，不能批准。当前caller配置没有connectionScope，grantID是明确无权限的占位ID；不会自动选择其他grant。超时不自动重试；变更返回unknown保留requestID，后续按原requestID查询。若Docker可能晚创建、查询失败或label不符，返回`CALLER_CREDENTIAL_CLEANUP_UNKNOWN`并保留私有tmpfs，不虚报已清理，需操作方先确认/停止该唯一caller后处理。

用户已选择沿用现有机器、等待维护窗口更新共享daemon。本次**未重启或替换4090 daemon、未启动worker、未新增本地设备或逻辑机器、未向bridge或日常会话发送指令**。批准页已本地Web构建并完成App类型检查/合同测试，线上`/happy/`尚未替换；浏览器/手机扫码与真实批准尚未验证。到维护窗口再发布并验证批准页、接入已有机器worker、由用户批准明确测试项目/方法/专用会话/期限，再做单测试任务验收。默认不含任何既有会话；实际maxGrantMs仍1小时，新schema最多允许显式配置7天，任何更长策略仍须用户逐项批准。

源码及目标证据见`validation.production-2026-11-04.json`。TLS配置和ensure/renew样例同目录；生产pair需额外ExecStartPre hydrate（`happy-control-pair-production.conf.example`），普通trial模板仍故意不隐式启用持久凭据。源码状态仍为clever-ocean未提交快照；没有commit/push/merge或CI。

### 生命周期与恢复

`tls-maintain.py`是本机固定角色工具。仅首次显式initialize建立专用CA，重复初始化/缺失解锁材料都失败关闭，不静默换根。每日renew和每60秒ensure使用同一flock。源leaf pair先落受校验candidate与durable ledger，中断可forward完成；私有随机临时文件残留不阻断恢复。55保持per-file bind inode，只有实际观察到新公有leaf后记录applied；57发布route在完整材料之后，观察新NGINX worker进程后记录generation，单纯reload ack不算完成。57不变时ensure不重载，缺材料或证书错误则不发布可用路由。真实外部readiness另以HTTPS验证。

本轮一次REST升级因旧owner锁被拒绝，服务按限流停住。隔离子进程复现重复SIGTERM在`process.once`关闭中断的问题，又补启动尚未返回host时的信号窗口；已改启动前安装`process.on`、暂存shutdownRequested与closing guard，两种时机均验证close一次、正常退出及删除自己的owner锁。最终镜像38项通过；中间e030候选在第20项后的重建失败，未投送。旧锁只在停止本unit、证明全部可能RW状态挂载owner已退出、核验dev/inode/hash后，原子移入同文件系统挂载外的root-only审计目录；state/proofs未改。这是一次人工恢复，**没有新增自动删锁或重试搬锁逻辑**。硬杀/不明owner仍失败关闭，需要同等核验。

撤回新组件时先停用55/57新TLS timers，停/disable新pair，再仅移出production route并nginx -t/reload；原Happy/relay保持。不要整份还原旧NGINX备份覆盖并发改动，不要恢复到撤权之前的state。旧trial路由和证书不能作为长期回退目标。凭据被盗时应撤销相关grant/公钥登记并轮换专用根/leaf，保留审计；常规续签不会自动吊销旧leaf，未实现CRL/OCSP。

## 以下为历史试部署记录（不代表当前凭据或deadline状态）


这是直接 REST + 独立 Ed25519 签名方案。2026-11-04用户明确批准当前clever-ocean固定快照例外试部署（不commit/push/merge）和仅tmpfs、24小时内部mTLS。新REST/网关已部署99.55，99.57已有Nginx仅热加载一个新路径；clients/workers均空，没有真实Happy grant、worker/daemon更新或账号凭据读取。当前试部署实际记录见 `validation.trial-2026-11-04.json`；下文早期本地结果保留其当时边界。

公网 `https://szsp.suitbim.com.cn:7100/happy-control/v1/compatibility` 已返回200；未授权机器/会话/任务/追加/日志/结果/取消/回查均401稳定JSON。原Happy与relay仍200，原relay和57 Nginx的容器ID/启动时间未变。真实授权业务流程及本助手签名调用未接通。

本次截止为 **2026-11-05 00:01 Asia/Singapore（2026-11-04 16:01 UTC）**，两机各有仅运行期的一次性 `happy-control-trial-expire-e13c5e86.timer`；其策略检查已过，未来触发尚未发生。55先stop新unit并逐成员确认停止，才删除本trial TLS；57先移出内存route、nginx -t/reload并确认404，再删本trial key。不删除state/锁，不还原整份旧配置，不重启原Nginx；主配置仅保留无匹配时安全的可选glob。新55unit未启用开机自启；重启丢失临时路由后原站可启动，REST关闭。需要长期运行时另行确定持久secret provider与有效授权，不能靠延长临时证书冒充接入完成。

部署基线是Git tree `e13c5e8689e0a3a4125d18c3f4725e92961c0d03`，HEAD `d64659a0`，当次fetch的fork/main `aa8b0dce`只多一项DEPLOY文档提交；未替换已发布App/relay。控制镜像和NGINX镜像通过save/load导入，运行配置固定本地sha256 image ID，未push/pull registry。host配置额外使用资源限制overlay；真实systemd发现Compose显式stop退出130，部署unit与本地模板补 `SuccessExitStatus=130`，不放行Stop/Post或配置失败的exit1，Restart=always及限流保留。

本次复用此前已验证的控制镜像，没有新构建镜像或全新安装依赖；不将镜像复用称为干净构建。上一个阶段的38项本地原生镜像检查和本轮14项合同测试分别保留其范围，真实服务器验收见新记录。

## 已核实的部署事实（2026-11-03，只读 SSH）

- 99.55：Anolis 8.9、Docker 27.3.0；`happy-relay-relay-1` 在8193健康运行。宿主Node v10.24.0不能运行本组件，采用独立Node22镜像，保留宿主环境。
- 99.55：`docker-nginx-1` 与 `nginx_ssl` 服务其他应用，网络分别为 `docker_default`、`nginx_default`。本方案新增Happy专用网关，不改这两套配置或容器。
- 99.57：`bim-nginx-1.30` / `nginx:1.30.1` 在 `bim_network`，7100为现有HTTPS入口。配置源 `/root/bim-engine/script/http.nginx.1.30.1.prod.conf` 挂入 `/etc/nginx/nginx.conf`。
- `/happy/` 从该容器的 `/usr/share/nginx/html` 提供页面，`/home-relay/` 代理至 `http://192.168.99.55:8193/`。现有前缀剥离行为不适用于新增的签名REST路径。
- 公网网页与relay health均200，REST compatibility为404；证书校验通过，有效期记录至2027-01-16。从99.57 Nginx容器到99.55 relay health返回200。
- 99.55的9010/9011未监听，firewalld active，默认zone未显式放行这两个端口；这不等同于验证了完整Docker/firewall访问策略。已有20443从99.57 TCP不可达，不选用该入口。

## 新增组件与边界

```text
云端签名调用组件 / 用户的Happy批准页
  → 现有HTTPS origin https://szsp.suitbim.com.cn:7100
  → 99.57新增 /happy-control/v1/（保持现有网页/relay路径）
  → 经验证服务器身份的内部HTTPS + 99.57客户端证书
  → 99.55:9011 → 新gateway容器:9443
  → 同一网络命名空间的REST 127.0.0.1:9010
  ← 4090Wsl2 worker通过上述公网HTTPS origin主动出站
```

REST容器拥有独立网络和9011→9443的端口映射；gateway使用 `network_mode:service:control`，所以其127.0.0.1确实能访问REST。REST的9010、`/livez`、`/readyz`均不发布。没有连接relay原有Docker网络、数据卷或Docker socket。

99.55的独立Compose项目名为 `happy-control`。仅其 `/var/lib/happy-control` 有持久写入；两个容器UID/GID1000、rootfs只读、capabilities全部移除，NGINX所有temp路径位于tmpfs。关闭请求/响应代理落盘缓存、普通访问日志；现有应用协议审计只记录路由模板、身份ID与状态。NGINX critical错误不作为完整访问审计。

直接REST不依赖OAuth AS或MCP。当前site配置没有启用 `/happy-control/mcp`，原有可选适配代码保留。调用方仍需可运行签名组件的受控环境、安全SecretProvider及网络可达；平台有URL不等于我方已获工具/凭据。REST服务端仅登记助手公钥；助手私钥不放在此host.json，也不使用网页cookie/账号主密钥。

## 文件

| 文件 | 用途 |
|---|---|
| `Dockerfile.control`、专用 `.dockerignore` | Node22构建/运行，两workspace最小构建，npm/corepack固定阿里镜像；构建上下文排除认证材料 |
| `compose.yaml.example` | 99.55独立REST和NGINX；必须显式profile与配置路径，禁止自动创建空bind目录 |
| `happy-control-pair.service.example` | 管理前台Compose组；派生trial单元已安装运行，未enable开机自启 |
| `paired-contract.mjs`、`paired-fixture.mjs` | 核对单元策略；fixture按相同Compose命令验证退出恢复，不代替真实systemd |
| `validation.trial-2026-11-04.json` | 真实目标试部署、已核验结果、截止清理、未授权/未验证边界；不含私钥或token |
| `settings.env.example` | 只有非秘密参数；镜像引用默认留空，防止直接启动 |
| `host.json.example` | 实际origin/relay，助手和worker公钥占位；单机器/测试项目 |
| `nginx-55.conf.example` | 独立内部TLS网关，mTLS且只允许99.57来源；不改写URI/query |
| `nginx-57.location.conf.example` | 加入现有7100 ssl server的一个location，严格校验55服务器证书 |
| `nginx-57.mounts.yaml.fragment` | 57端三个只读PKI文件挂载片段；实际Compose服务名待核实，不能当独立配置启动 |
| `worker.json.example`、`worker.service.example` | 4090Wsl2显式已有认证模式、加密worker密钥引用、出站连接；不登录/新建机器 |
| `grant-request.json.example` | 待用户批准的有限授权申请；expiresAt=0故意无效，默认不准访问既有会话 |
| `check.mjs`、`config.test.mjs`、`healthcheck.mjs` | 本地模板/合同验证、隔离loopback测试、生产本地readiness探针 |

## 现在可以安全执行的本地检查

在仓库根目录：

```sh
node deploy/automation/site-99-55/check.mjs --templates
# 下列合同测试使用已有happy-agent构建导出；新checkout先构建happy-wire与happy-agent。
node --import tsx --test deploy/automation/site-99-55/config.test.mjs
```

check仅用固定假镜像digest和非秘密路径执行 `docker compose config`，不调用Docker daemon，不pull/build/run/up；隔离 `DOCKER_CONFIG`，不读取真实.env或Docker认证配置。模板输出必须 `deploymentReady:false`；镜像digest、挂载权限、真实身份、PKI均不在此检查的证明范围内。实际Compose版本需支持long bind `create_host_path:false`、service_healthy和前台abort-on-container-exit；本地使用2.40.3。部署前只读核实99.55已有Compose2.27.3，但仅在root插件目录；unit在独立运行目录链接获准release/tools/docker-compose副本，不读取root的Docker配置或凭据、不更改全局插件。发布前需核对副本的版本/hash；未准备副本即启动失败。宿主单元固定本机Unix socket、独立0700运行时Docker CLI配置目录，并清除继承的context/TLS相关变量。

合同测试使用短时模拟身份、真实fixture REST/worker/receipt、临时127.0.0.1端口。两跳代理为Node transport模拟，不等同于原生NGINX、TLS/mTLS、Docker NAT或防火墙验收。脚本退出清理listener/临时目录。不会访问99.55/99.57或真实Happy认证材料。

## 待批准和填入的非秘密参数

- 三个镜像：用于构建/运行的可信Node22 Debian镜像、可信NGINX镜像、构建输出的control镜像；均应记录来源与immutable sha256 digest。文件没有假设某个第三方镜像仓库可信。NPM/corepack只使用 `https://registry.npmmirror.com`。
- 99.55新目录建议 `/data/code/happy-control/{config,state}`（持久配置/状态）和 `/run/happy-control/pki`（内存运行材料），与现relay、Dify、其他NGINX完全分开。state所有者1000:1000、0700；host.json所有者1000:1000、0600。runtime配置和密钥来源不得为不受控symlink/hardlink。
- 同一个已有Happy userID、已有machineID、独立助手/worker公钥，以及准确项目realpath。当前示例 `/home/dev/code/happy-automation-test` 只是候选，尚未创建；本次不使用agent-runtime-bridge目录或其会话。
- methods可缩小；grant默认仅本连接创建的会话，既有sessionIDs为空。必须显式填写未来expiresAt，且不得超过host的1小时上限。申请、批准、实际执行仍是三个不同阶段。
- REST调用方的签名执行位置及SecretProvider。独立签名密钥只证明调用者身份，必须同时有该user批准的有效grant；不要把浏览器凭据转交调用方。

所有REPLACE值与空镜像、expiresAt=0均需经授权处理。模板不能作为已配置的身份或已授予权限，check不会创建这些授权。

## TLS、凭据与挂载

以下挂载方式为长期运行建议；当前已授权短期试部署的57侧改用容器tmpfs和可选glob，不新加volume，具体见开头及真实记录。

99.57→99.55传输含获准任务明文/结果及临时owner批准请求，因此使用内部TLS，严格验证服务端证书，同时55校验57客户端证书。不能把 `proxy_ssl_verify` 或 `ssl_verify_client` 改成off来排障。

| 主机 | 运行材料 | 最小约束 |
|---|---|---|
| 55 | server.crt、server.key、client-ca.crt | server证书含DNS SAN `happy-control-55.internal` 与serverAuth；server.key只给UID1000读 |
| 57 | server-ca.crt、client.crt、client.key | client证书clientAuth，专门代表获准57网关；key只给已核实NGINX master读取 |
| 4090Wsl2 | worker-signing-key.encrypted.pem、service-manager运行时口令凭据 | 仅加密PKCS8，公钥pin与登记相同，文件owner/mode满足provider要求 |
| 签名调用组件 | 独立助手signer/key ref | 安全provider托管，公钥与client登记匹配；不在聊天/URL/响应/普通配置内传私钥 |

55只逐文件挂载前三项，不挂整个PKI目录；57也只逐文件挂载其三项。TLS叶私钥应由获准secret provider/加密凭据在运行时投送到tmpfs，不以这些模板默认持久明文保存；57对应运行目录为 `/run/happy-control-proxy-pki`。CA签发私钥不得进入任何运行容器、镜像或代码库，57的client.key不进入55容器。server内部身份名是待批准的证书SAN方案，不要求新增公网DNS；57使用固定IP连接、该名字做SNI和证书校验。

早期本地阶段只生成隔离fixture证书/密钥并在结束后删除。当前试部署已按当次明确授权签发24小时内部TLS，CA签名私钥销毁，叶私钥仅在各自主机/容器tmpfs；未登记真实助手客户端。长期叶证书期限、签发与轮换仍待明确；已有Happy账号密钥不参与内部TLS或助手签名。

`nginx-57.mounts.yaml.fragment` 的实际父Compose服务与现有挂载尚未复核。如果需要新增mount，可能必须重建现Nginx容器，**不能承诺仅reload或无中断**；这要单独的最小中断窗口与回退配置。禁止把私钥放进已公开挂载的Web静态目录。本地使用fixture PKI执行原生 `nginx -t` 已通过；上线目标仍需在获准真实PKI和原版本镜像下重新核验。

4090Wsl2的 `LoadCredentialEncrypted` 要求兼容systemd版本和已配置的安全credential源（实际支持需现场核实）。不支持时应使用获准vault/系统凭据适配；不降级成普通口令文件。worker的Happy home目录、实际Node22路径、既有daemon启动方式及owner都待现场核实；本地配置不触碰现有认证。这个worker入口接管现有daemon的启动方式，不允许并行启动第二个同机器daemon。

## 后续长期接入与发布流程（当前仅短期试部署）

以下是长期上线步骤；当前已执行的短期试部署范围及偏差以本文开头和真实记录为准。试部署57没有新增volume或重建容器：只在7100 server加入可选 `/dev/shm/happy-control-trial/routes/*.conf`，client key与location同存容器tmpfs。空glob和完整候选都用原NGINX1.30.1验证，候选与主配置同目录保持相对路径语义，备份后按SHA guard原inode写入/fsync并读回；实际撤下/恢复路由已验，期间原站正常。

1. 固定可审阅源码快照、lockfile和镜像来源；本地配置仍在clever-ocean未提交，不自动合入main、commit或push。发布来源及例外按个人AGENTS规则另行授权。
2. 在独立构建环境用显式 `CONTROL_NODE_IMAGE` 构建本目录Dockerfile，仓库根为context。Dockerfile复制两个workspace的manifest/源码、ignore scripts冻结安装、先build wire再agent，再按相同lockfile离线冻结安装仅production依赖，保持本地workspace布局。原始repo .npmrc不进入镜像。
3. 新发布镜像仍需独立导入/启动验证，确认本地wire、UID1000、失败关闭与只写state/tmpfs。本次复用镜像已在目标Docker27/NGINX1.30.1运行并验收；不把此结果外推为其他新镜像或长期provider已验。
4. 在授权目录准备公共注册配置、私有state和PKI，审阅 `happy-control-pair.service.example` 的操作用户、Docker/Compose路径和非秘密deploy.env；经批准后由该单元成对管理55新组件，不改relay。镜像必须事先导入并固定digest，运行时禁止build/pull。9011只绑定55内网IP，9010不发布；新增内网访问规则仅准57，不依赖firewalld普通端口查询证明Docker规则安全。
5. 校验55入口：正确客户端证书通过，错误/缺失证书、错误来源被拒绝；57校验错误CA/SAN必须失败。必须核实Docker NAT后55看到的真实来源IP，不能为通过测试放宽到allow all。
6. 备份57原配置，核实/准备只读PKI挂载及窗口，再增加一个完整路径location。两跳均不带proxy_pass URI、不rewrite/query重排；外层域名和Happy网页/relay原路径保持。先用非秘密compatibility/未认证401校验，再做专用授权测试。
7. 更新可用的Happy批准入口（网页可以作为第一入口）；新版手机专用扫码另需发布/真机验收。用户登录现有账号后独立审查助手连接，不以账号登录成功代替grant批准。
8. 在批准的4090Wsl2 daemon更新窗口启用worker；将调用方公钥绑定到对应user，用户批准测试项目/方法/期限。只在隔离测试会话验收create/send、requestID回查、cursor/result、cancel与实际stopped/unknown、撤销/过期、重连。真实签名调用端的网络/SecretProvider/工具可用性单独验收。

## 探针、恢复与撤回

- `control`健康检查仅看本namespace的REST `/readyz`，不要求已批准grant，也不等待NGINX启动；否则会与gateway的service_healthy依赖形成死锁。
- 两个容器均 `restart: "no"`，禁止分别后台自启。宿主单元以前台 `compose up --force-recreate --abort-on-container-exit --no-build --pull never` 管理整组；任一成员退出（含退出码0），Compose停止组，ExecStop/Post补停两成员，然后systemd `Restart=always` 等10秒重建两者，避免旧gateway滞留原namespace。单元每300秒最多启动3次；触及限制后停在失败状态，不承诺稍后自行复活。配置/PKI/镜像失败也受同一限制；不build、不pull、不删除state。
- ExecStop/Post直接使用固定本机Docker socket，按project=`happy-control`、service=`gateway/control`、managed-pair=`site-99-55-v1`三标签stop，逐成员尝试，任一失败最终返回非零；不依赖release目录、deploy.env或Compose文件仍存在。只停止，不remove/prune，不读授权state。fixture已移走Compose文件验证两成员停止，并确认相同managed标签但项目/服务不同的两个邻居fixture仍在运行。Docker daemon不可达、权限被撤回或stop本身失败时无法保证已停，必须报告unknown并在批准后人工隔离，不能凭unit已失败推断入口已关闭。
- 手动停止应使用该systemd单元的stop；单独 `docker stop` 属于受管成员退出，会触发成对恢复。单元Type=simple表示前台进程启动，不表示入口已ready。初启仍需核对两成员namespace、55:9011和57/公网compatibility；REST healthy不能证明外层入口。启动后health变unhealthy、进程存活但卡死、网络/证书异常不触发此退出恢复机制，需要外部观测和人工处置，尚未实现自动健康重启。
- 真实systemd239已补验：REST直接restart与网关SIGKILL均成对重建，入口自动恢复；修正130退出分类后，手动stop超过RestartSec仍保持两成员停止。无效listen配置在owner lock创建前失败，实际三次拒绝后不再重启、两成员停止、入口502；该版本此时Result仍为exit-code，须结合NRestarts=3和journal的Start request repeated too quickly判断，不能仅匹配start-limit-hit。测试恢复有效公共配置并重置本测试unit失败计数后，入口已恢复200；没有删除owner lock或回滚授权state。
- 早期本地fixture只执行真实Compose和stop脚本、模拟systemd策略（等待250ms，每个独立fresh场景最多3次）；未模拟完整300秒窗口，不能由fixture计数推断真实systemd行为。本次目标环境的启动/退出恢复/人工停止/限流已另行补验；Docker daemon重启传播、主机重启或整机恢复仍未验。试部署不启用开机自启。
- REST硬崩溃留下 `.gateway-owner` 后，后续启动失败关闭；本地三次尝试后两成员均停止，锁内容保持，入口502/504不可用。没有自动删锁、抢占、清空授权/receipt或恢复旧state快照。恢复必须先停整组、确认原进程及实际任务状态，保留最新receipt/revocation，排除其他owner，再由获准操作方处理锁和启动限流；本次未提供自动解锁命令。worker daemon state/lock同样保守拒绝，未改变其恢复边界。
- 新网关收到错误cert/来源返回拒绝是预期；应用确定worker离线返回unavailable、不排离线任务；已派发超时仍可能unknown，应按原requestID回查。
- 撤回前如需停止测试任务，先在有效授权下cancel并核实stopped/unknown，再撤销grant；若先紧急撤权，可用原Happy UI/本机人工处理任务，不能认为撤权或停组件就是已停止。
- 移除57新增location/挂载的变更按获准回退计划执行，停55新 `happy-control` 项目，恢复原daemon启动方式（如曾改动）。不执行down -v、不删除state/proofs/receipt，不回滚到撤权前的授权快照；原relay和两套业务Nginx不在撤回范围。

## 验证范围

早期本地配置阶段没有修改服务器；本地渲染/合同和readiness结果以当时输出为准。当前试部署已额外核验实际Docker/Compose/systemd/NGINX、临时TLS与来源拒绝，详见真实记录。全新完整monorepo安装、长期PKI/provider、主机故障恢复、真实扫码、worker更新和本助手实际调用仍须分别验收。


构建配方验证记录：首次在全新临时两workspace中，offline frozen安装与wire/agent构建通过，但`pnpm deploy --legacy --prod --offline`因需要重新解析release-it依赖的镜像元数据失败。Dockerfile已移除该路径，改成runtime目录按同一lockfile进行第二次production-only离线冻结安装；修正后同一隔离配方的production-only离线冻结安装与产物模块加载均通过，本地wire确认随产物存在。未以修改依赖版本或非阿里源绕过失败。


本次本地验证结果：Compose 2.40.3渲染及6项合同测试通过；全新临时两workspace的构建依赖安装、wire/agent构建、production-only依赖安装均通过（冻结lockfile、离线、ignore scripts、阿里源），产物production模块与本地wire加载通过，临时目录已删除。独立只读复审发现的temp目录、PKI最小挂载和成对恢复事项已处理；在该配置准备阶段未运行Docker；后续本地镜像与NGINX验证见下节。原有118项应用测试结果未因只改部署模板而重复执行。


## 早期本地镜像与原生NGINX隔离验证（2026-11-03，当时未上线）

结果记录为 `validation.local.json`。本地Docker29.1.3，缓存Node22.23.2、NGINX1.31.6；后者与99.57现用1.30.1不同，不能当原版本或目标Docker27验收。基础镜像只使用本地缓存ID，没有registry pull，包下载只走阿里源。生产Dockerfile仅在临时构建副本中增加追踪LABEL，构建每RUN限制1CPU/2GiB，产物保留在本机供审阅，没有推送。

```sh
# 会构建镜像并启动临时容器，需Docker权限；不是线上部署命令。
node --import tsx deploy/automation/site-99-55/container-fixture.mjs --local-only
# 复验已保留的本地fixture镜像（会核对fixture label）：
node --import tsx deploy/automation/site-99-55/container-fixture.mjs --local-only --image <本地fixture镜像ID>
node --test deploy/automation/site-99-55/fixture-process.test.mjs
# 单元策略、停止/重试边界；不安装或启动systemd服务：
node --test deploy/automation/site-99-55/paired-contract.test.mjs deploy/automation/site-99-55/paired-fixture.test.mjs
```

本轮原生容器38项检查通过，site/中断管理/单元策略测试共14项通过：保留UID/只读文件系统、配置失败关闭、两层nginx -t、TLS/mTLS拒绝、完整验签、并发幂等、大结果/cursor/turn、撤权/过期和state脱敏检查；新增REST直接重启与NGINX强杀均成对重建、同namespace与入口自动恢复、持久grant/receipt/撤权/过期、配置缺失仍停整组且不误停其他项目/服务、人工停整组、硬崩溃重试限流与锁保留。cancel仍用模拟进程返回unknown；submitted是模拟内存relay回执契约，不是真实relay数据库持久化证明。worker、owner、daemon及relay是fixture，镜像中的REST与两层NGINX是真实进程。

**恢复修正的实测范围**：此前无人管理时直接 `docker restart controlID` 导致namespace分离、入口15秒未恢复；现在相同直接restart由前台Compose观察到退出码0，停止整组并重建，入口自行恢复。NGINX强杀退出137也成对恢复。测试没有在恢复时手工reload外层NGINX；仅fixture为Docker临时IP设置短DNS刷新，site仍连接稳定55宿主IP。硬崩溃保留锁时不会假称恢复成功。首轮最后的HTTP断言只允许502而失败；增加观测后实际得到504上游超时，修正为502/504且分别断言两成员均停止。本记录仍区分本地退出恢复与未验的真实systemd/目标部署，模板继续deploymentReady=false。

`systemd-analyze verify` 对隔离临时unit依赖集合的语法检查通过，未安装unit。最初全宿主依赖扫描还提示无权读取netplan临时unit、已有snapd的RestartMode不兼容；隔离核对避免依赖这些无关服务，不能当作已修复宿主配置。本机无用户systemd总线；真实systemd管理器运行未验证。

最初fixture使用Docker `--internal` network，Docker29抑制了端口发布；现使用与site方案一致的独立普通bridge，所有host端口明确127.0.0.1临时端口。没有改daemon镜像源、宿主防火墙或现有网络。fixture私钥在构建context外，根CA私钥不挂载到任何容器，测试后删除。

`FixtureProcesses` 将信号/timeout/null exit视为失败；stop同时中止子进程、HTTP和普通等待，阻止后续work，清理走唯一finally。SIGINT在Docker exec阶段已实测退出130且容器/网络为0；非子进程等待阶段另有smoke与单测。构建CLI中断测试已观察到带本run标签的RUN容器，CLI退出143，daemon移除了该容器。这只证明本地Engine此次行为，不保证宿主崩溃、SIGKILL或目标Engine27一样。

每次先打印runID，清理按该run唯一 `com.happy.automation.fixture` label发现并删除容器和网络，再核验成功查询的结果；查询失败是unknown/非零，不能报0。临时目录删除成功才报testKeysRemoved。构建镜像和Docker构建缓存会保留，不能把容器/网络为0写成所有资源均删除。SIGKILL/断电无法保证finally执行，需按日志runID只读核对残留：

```sh
docker ps -a --filter 'label=com.happy.automation.fixture=<准确runID>'
docker network ls --filter 'label=com.happy.automation.fixture=<准确runID>'
```

核实准确ID/标签后再仅回收本run资源和对应临时目录；禁止global prune或按模糊名称处理其他项目。真实Happy服务和agent-runtime-bridge从未加入这些fixture网络或接收指令。
