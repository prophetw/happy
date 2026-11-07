# 个人 Fork 部署入口（prophetw/happy）

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

99.55 原 Relay 已停用，原卷与最终冷备保留。SSH 部署脚本仍默认 99.56，旧文档中的
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
