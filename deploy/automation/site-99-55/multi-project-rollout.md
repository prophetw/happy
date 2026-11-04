# 多项目服务授权发布与回退清单

2026-11-04 本人随后明确启动受控维护窗口，本清单的REST/Web/worker切换和test-b创建/双边登记已完成，记录见 `validation.multi-project-live-2026-11-04.json`。原会话身份保持、旧授权不扩权；新多项目grant仍须本人单独批准。下面步骤与“本轮未执行”等表述保留准备阶段的状态；当前线上情况以站点README首节和最新记录为准。

准备阶段用户已选择将 `/home/dev/code/happy-automation-test-b` 纳入验收计划；该路径在准备阶段只读检查时不存在，现已按维护授权创建并登记。使用原 `automation-test` 加新增逻辑项目 `automation-test-b`，同一worker/machine、原9个方法、新授权专用会话。最终grant的方法/期限仍由本人在Happy页面审查批准，部署本身不授予访问权。

## 可审阅文件和固定制品

- `multi-project-rollout.json.example`：本次固定源码/制品摘要、只读现场基线、切换顺序及停止条件。所有授权/执行标记保持false。
- `multi-project-scope.patch.json.example`：只允许给匹配身份的host worker表及worker.registration追加第二个测试项目，不包含真实密钥或完整认证配置。
- `multi-project-worker-release.conf.example`：仅重设现有worker单元的WorkingDirectory/ExecStart，继承User、KillMode、Credential、Environment与重启策略。本轮未安装。
- `multi-project-settings.env.example`：55专用Compose的公开镜像/path参数，无凭据；不得用它覆盖其他服务的.env。
- `validation.multi-project-plan-local-2026-11-04.json`：本轮真实构建/隔离验证与只读状态证据。

应用输入固定为Git tree `11313dcc1ba0100d09a4fbfe4caeb17f750665c6`，base commit为`d64659a0955a65b99f860abb7ee05ff6086cda82`。这是clever-ocean未提交源码快照，不是发布提交；没有commit/push/merge。应用代码与上一阶段已验证的多项目实现一致。本轮新增发布文档及容器验收脚本不在该应用快照内，另记录fixture SHA，不混称同一提交。

本地制品在 `/home/dev/code/happy/.dev/worktree/clever-ocean/.e2e-artifacts/multi-project-release-preparation/`，由Git忽略，不包含Happy账号认证材料：

| 制品 | 文件 / 用途 |
| --- | --- |
| 固定源码 | `application-source-11313dcc1ba0.tar.gz`；共享给55构建记录/审计 |
| REST镜像 | `control-image.tar`；本地image ID见plan，save/load后pull never，不拼成registry manifest digest |
| Web静态包 | `web.tar.gz`；完整Expo Web导出，base path=/happy，relay=/home-relay |
| 4090 worker运行包 | `worker.tar.gz`；CLI、happy-agent、happy-wire构建、生产依赖及本机工具，现有Node22执行 |

worker包使用独立全新依赖目录、冻结lockfile从现有pnpm缓存安装：构建依赖842个，生产依赖527个，零下载；CLI/agent/wire完整构建及27项纯fixture合同通过。运行包1543个符号链接均解析到包内，bootstrap/worker库导入验证没有启动daemon或读取账号认证。Web复用已有依赖完成导出，不能称App全新安装。未改依赖/lockfile，未查询或运行CI、发布npm或EAS。

新REST镜像和生产同版Nginx通过64项原生容器检查，包括两跳TLS/mTLS、完整query、单令牌两项目、第三目录拒绝、跨项目幂等冲突、回执恢复、撤销及硬杀失败关闭；fixture容器、网络和临时TLS/模拟凭据已清理。完整Web导出通过桌面/手机四个匿名页面情景、28项检查，浏览器及loopback服务均已关闭。它们不能替代未来真实账号批准、实际worker重启与真实任务验收。

## 本轮只读确认的现场基线

- 55当前REST为`sha256:a9e59fb0cde80557db85b7e0be9b75e11cc17fc5bcc68361ca82a4a622e41563`，原网关为`sha256:62217789446a0bb2b68d9f65538a7f4246b7041505f42383e5e29f0112644eb3`。control/gateway均运行，relay健康。
- 55 release为`/data/code/happy-control/releases/20261104T064226Z-service-token`，host.json摘要与上次发布一致；签名1小时、服务令牌最长30天，已有服务身份不变。
- 57当前Web target为`.happy-releases/20261104T064226Z-service-token`；现有Nginx容器ID/启动时间、主配置inode/SHA和容器内tmpfs路由SHA均与上次发布一致，无需改路由或重载Nginx。
- 4090现有`happy-automation-worker.service`仍PID737095、User=dev、KillMode=process；运行入口为`/home/dev/.local/share/happy-automation/releases/20261104T021514Z-worker/packages/happy-cli/bin/happy-control-worker.mjs`。happy-agent依赖确实解析在同一旧release内，更新本工作树dist不会更新该进程。
- 4090当前登记2条仍存在的会话子进程；PID/startTicks/cgroup身份只作当次元数据证据，维护窗口开始时必须重新采集，不把历史数量当保护条件。
- HTTPS首页/授权页、relay health、compatibility及OpenAPI均200。线上OpenAPI仍1.2.0，尚未宣告projectScopes；准备的版本为1.3.0。证书只核对公开有效期/指纹，没有读取私钥或账号认证值。
- 57剩余空间约1.9GB，只传Web小包，不把worker大包、REST镜像和源码传到57；worker包留4090，镜像/源码仅在55私有目录。不得为腾空间删除其他任务文件或历史版本。

这些是检查时刻的事实，不是将来的部署许可。计划没有假设真实grant/token仍为0；本轮未枚举凭据值。切换前需停止新增业务派发、核实在途请求，超时按原requestID回查，不能盲目重派。

## 正式获准后的执行顺序

由助手执行以下操作，不要求用户手工部署或粘贴任何密钥。**本轮不执行本节。**

1. **即时复核和私有暂存。** 核对plan基线与正在运行的镜像、host/Web摘要、unit/入口/节点、PID/startTicks、machineID、配置和状态路径；核实最新fork/main差异及不会丢失现网功能。任一非预期漂移先停止调查，不覆盖并发变更。制品逐一验SHA，导入55后inspect确认精确image ID，解包到各自新的release目录；拒绝覆盖已存在且未经核实的目录、越界符号链接或不安全权限。保留旧release、当前state和私有公开配置副本。
2. **第二个目录及双边配置。** 在获得本次部署范围授权后，仅创建计划中的test-b目录，dev所有、0700；已存在则先检查归属/realpath及内容，不覆盖。host与worker注册表先按workerID/userID/machineID精确匹配，确认旧projects集合符合预期，才在候选副本追加B。仅改变两处projects数组，pubkey、身份、generation、provider/凭据路径、Happy home、relay、methods、期限、现有会话范围均不变；用实际hostConfigSchema/workerConfigSchema验证后再以原子替换落盘，保留各自权限。不要把本次示例或通用host模板整份覆盖现网。
3. **55先升级控制对。** 停止原happy-control-pair并确认control/gateway均退出、自有owner lock自然释放；不删未知锁。只改专用deploy.env的CONTROL_IMAGE并切新release，原管理单元成对启动，保留state和原gateway镜像/PKI。验证内部ready、外部compatibility.projectScopes=1、OpenAPI1.3.0；relay容器ID/启动时间保持。期间旧worker仍可按原poll执行原单项目授权，不将cancel ack或REST恢复当真实任务完成。
4. **4090独立维护控制器切worker。** 切换由脱离当前Happy会话cgroup的短时root oneshot执行，控制器与worker均须KillMode=process。核实当前unit原有drop-in、MainPID/startTicks/exe/UID/入口、machine及状态文件归属，采集会话子进程身份。禁止在依赖当前会话存活的前台shell里先stop后start。先停现有worker单元，确认旧PID退出、其state/lock自然释放；未知归属或未退出时停止，不force kill、不偷锁。再安装本次唯一、摘要固定的release drop-in，daemon-reload并启动同一单元，保持原LoadCredential/Environment等配置不变。**不要运行worker-transition.py**：它针对最初的未受管main daemon迁移，当前服务已经运行，不是本次升级执行器；同样不能cli:install、npm link或改全局happy。
5. **worker验收。** 确认新unit MainPID和启动标识、新entry/cwd/Node及happy-agent实际依赖路径均属于候选release；同一machine连通、原账号设备没有新增。观察本invocation的脱敏connected事件，以及signed poll的projectScopes=1能力；仅进程active不等于具备能力。逐一回查窗口开始时记录的会话PID/startTicks/cgroup；若会话变化无法归因，记录unknown/待核实，不能宣称无影响，也不为了通过而重发/取消日常任务。
6. **57最后切Web。** 新静态目录保留旧hashed assets，核实index SHA和WASM magic，原子替换happy相对symlink；不重建或重载Nginx。验证真实HTTPS页面/资源、登录边界、无新console/network error，并再次核实原Nginx、relay身份。所有产物都来自同一个固定应用输入。
7. **本人审查新授权。** 本人登录Happy Web，选择“后端联调测试”、A/B两个目录及所需方法，推荐首次短时限，审查每个实际目录，明确批准后自行一次性交付令牌。旧单项目令牌不原地扩权；部署、建目录、登记或扫码登录均不能代替此次批准。令牌不进聊天/URL/普通日志，业务后端沿其secret provider托管。
8. **真正任务验收。** 仅在新grant的A/B专用新会话分别创建短任务，核对目录、明确sessionID、create/send子requestID、消息持久ack、增量cursor及指定turn最终证据；未勾选项目/其他grant会话必须拒绝。取消先cancel_requested，再核实实际process=stopped；没有证据时unknown。撤销该测试grant后重连不得恢复。不得向bridge或日常session发指令；模型仍限GPT-6.1 Sol High/xHigh。本轮fixture通过不等于本步骤已完成。

## worker切换和回退边界

切换及恢复必须在同一个独立维护控制器中有界完成，包含失败分支和状态回写，不能先停daemon再寄希望当前会话继续执行后半段。原基础unit在本轮不改；新的drop-in只重设入口和cwd，因此回退可以仅撤回该文件。撤回前核对它仍为本次安装的inode/SHA，禁止移除其他drop-in或覆盖别人后来修改的unit。

若新worker启动失败，先核实当前unit进程及invocation仍属于本次候选；只停止本次可归属的进程，确认自然退出及锁释放，再撤回本次drop-in、daemon-reload并启动旧入口，保留当前journal/receipts。原worker已被其他操作改变、未知owner lock或状态归属不清时，失败关闭并报告，不能自动删锁、启动第二个daemon或清空state。恢复成功须核对旧入口对应的新PID、同machine/connected及原会话身份，不能仅凭systemctl返回0。

**真实主机上的新worker停启和原会话身份保持已验证，失败恢复分支仍未实测。** 本次维护包含REST和worker的短暂控制面不可用窗口，不能称零中断。已有agent进程不作为发布对象；窗口内记录的原会话PID、启动标识及cgroup均保持。

## REST/Web与授权撤回

优先保留新REST二进制和**当前**状态。先停止新增派发；本人在有效范围内取消仅属于本次测试的任务并确认实际停止，再撤销受影响的多项目grant。紧急泄漏可先撤权，但运行任务仍需另行核实。可以把Web切回保留旧target；恢复旧worker前须处理未完成多项目工作，旧worker缺能力时新REST返回426，绝不能默默按第一个目录执行。

如要移除新增B，必须在两边候选配置中只移除本次追加项、保留其他变化；相关多项目授权会失配并持久撤销。旧单项目A授权不应被扩大、延长或批量删除。**不得恢复旧state快照**，不得丢弃撤销、proof、幂等或receipt记录。本次检查点仅文件哈希元数据，不是灾难恢复备份。旧REST镜像读取新增scope状态的真实兼容性未验，本计划不批准盲目降旧镜像。

## 下一步需要的真实授权

本次受控维护窗口已获明确授权并执行：55 REST控制对升级、4090现有worker单元更新、57静态页切换，以及test-b目录创建和双边登记。沿用已批准的专用服务root-only凭据方案和原机器身份，不生成新账户/设备、TLS或签名密钥，不新增云端E2EE设备或长期OAuth权限。

维护后，由本人单独批准有限多项目grant并托管一次性服务令牌；这项真实授权不包含在维护窗口中。原生App/OTA、WorkBuddy或云端MCP注册也不属于本次计划。

实际受管worker切换使用新增 `worker-release-switch.py`（12项对应安全测试），通过独立root oneshot执行。最初的worker-transition.py仍不适用此次受管升级。新PID、invocation、同machine及原会话身份已回读验证；真实失败恢复分支仍未实测。
