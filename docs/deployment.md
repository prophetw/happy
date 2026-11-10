# Deployment

This document describes how to deploy the Happy backend (`packages/happy-server`) and the infrastructure it expects.

## 本机与 Tailscale 迁移（2026-11-07）

**基础设施、数据与在线客户端切流已验证；已补充未登录浏览器与用户手机首屏验证。** 99.55 / 99.57
的旧 Happy 服务与路由已退役，以下旧部署章节保留作历史，不代表当前发布目标。
日常客户端配置、直连判断与日志命令见
[Tailscale、Shadowrocket 与 Clash Verge 使用说明](features/tailscale-access.md)。

### 旧部署脚本与配置（禁止直接重放）

| 文件 | 现状 |
| --- | --- |
| `scripts/deploy-relay.mjs` | 默认 SSH 目标仍是已退役的 `root@192.168.99.56`；未显式传 `--host` 时脚本会告警。 |
| `deploy/relay/nginx-location.conf` | 指向 `192.168.99.55:8193` 的旧 relay-only 片段，仅供历史参考。 |
| `deploy/automation/site-99-55/` | 99.55/99.57 旧站点自动化与验证记录；个别脚本仍可本地复用，须显式使用当前配置。 |
| `docs/features/automation-service-access.md` | 入口已更新为当前私网地址，文首标注旧入口退役。 |

| 服务 | 当前实例 | 配置 / 数据 |
| --- | --- | --- |
| 私网 HTTPS | Windows Tailscale Serve，节点 `desktop-8ut4p0p.taild92624.ts.net`，IP `100.116.89.36` | 后台持久代理 `http://127.0.0.1:18194`；无 AllowFunnel 配置 |
| 本机 Nginx | `happy-local-gateway-1`，`127.0.0.1:18194` | `/home/dev/code/happy-local/compose.yaml`、`config/nginx.conf` |
| Happy Web | 本机 Nginx 的 `/happy/` | `/home/dev/code/happy-local/web`；复用 `bdb246abeaf6` 静态包，index 的 `__HAPPY_CONFIG__` 指向私网 Relay |
| Relay | `happy-relay-relay-1`，`127.0.0.1:8193`，healthy | `/home/dev/code/happy-relay`；卷 `happy-relay_relay-data-tailscale-20261107`；PGlite 与本地附件 |
| Control REST / MCP | `happy-local-control-1`，`127.0.0.1:9010`，healthy | `/home/dev/code/happy-local/config/host.json`、`state/`；原授权、身份、服务 Token 保持 |
| CLI / Worker | 本机 `happy-automation-worker.service`，PID `3511169` | `/etc/happy-control/worker.json`；drop-in `zz-tailscale-local.conf`；endpoint / relayURL 均为私网 |
| Windows CLI | 原 daemon / 会话原地切服 | `C:\Users\Prophet\.happy` 的账号密钥、机器 ID 保持，认证与 settings 绑定私网 |
| Dot / TestLoop | 原 release，scanner PID `3559876`；两个 Dot ready | 原 assistant 根、原会话和原 native thread；未新建任务、清空历史或调用真实模型做验收 |
| Hindsight | `happy-dots-hindsight`，`127.0.0.1:8888` | 原卷 `happy-dots-hindsight-data`；记忆与索引未搬迁或清空 |

入口：

- Web：<https://desktop-8ut4p0p.taild92624.ts.net/happy/>
- Relay：`https://desktop-8ut4p0p.taild92624.ts.net/home-relay`
- Control：`https://desktop-8ut4p0p.taild92624.ts.net/happy-control/v1`
- MCP：`https://desktop-8ut4p0p.taild92624.ts.net/happy-control/mcp`

Windows Serve 配置已生效，WSL 未另装 tailscaled：

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --yes http://127.0.0.1:18194
& 'C:\Program Files\Tailscale\tailscale.exe' serve status
```

本机服务使用已有镜像，无依赖安装、源码重建或版本升级：

```sh
docker compose -f /home/dev/code/happy-relay/docker-compose.relay-only.yml \
  --env-file /home/dev/code/happy-relay/.env.relay up -d --no-build --wait relay
docker compose -f /home/dev/code/happy-local/compose.yaml up -d --no-build --wait
```

Control 镜像 `sha256:2657e5fb4359262d7c3e5526063204337f51f0b6b2848d025435f1bd3b1a2132`，
Nginx 镜像 `sha256:3dd08163706a20b20622f310ec10258cc96e9007ab357f7201955bc880ac17f4`。
所有后端只监听回环，Windows Serve 负责 tailnet HTTPS；不要直接对局域网发布这些后端端口。

### 数据同步与会话身份

1. 暂停 Dot scanner / native runtime，使用原 release 的备份 API 创建并校验
   `~/.local/state/testloop-backups/tailscale-local-20261107`，保留原线程持久目录。
2. 停止 99.55 Relay 后冷备数据库和附件，下载后核对 SHA256，恢复到**新卷**。
   原本机卷 `happy-relay_relay-data` 另存冷备并保留。比对覆盖 23 张表：
   707 个 Session、225907 个 SessionMessage、10 个 Account、15 个 Machine、39 个迁移。
   表记录 ID 无本机独有项、会话 seq / metadataVersion / agentStateVersion 无本机领先项；
   本机 132 个附件哈希均与来源一致。这里不把运行状态字段变化描述为全库逐字一致。
3. 保留同一镜像、主密钥和账号策略，启动本机同步卷。99.55 使用临时 Nginx / SSH
   桥把旧连接送到本机同一数据库，旧 Relay 不再写入，避免两个权威库并行写入。
4. 用已有加密 `relay-switch` 协议迁移两台机器、29 个会话；Windows / WSL 与 Dot profile
   的认证地址和 Web 登录地址更新为私网。Worker 通过独立 systemd 维护单元停启，
   PID 从 `2844475` 变为 `3511169`，未重建 dist 或结束已有编码进程。
5. 通过原 MCP 配置 API 更新三个连接的 URL 与本地凭据绑定；新旧授权 scope 完全相同。
   当前 active REST 职责通过正常 revision 更新地址。历史 runs、hostedTasks、conversation
   和 hindsight 摘要保持，不全局替换旧 target 或修改历史回执。冻结的历史 REST run 仍保留当时 endpoint，
   将来如需恢复，应显式迁移其绑定，不直接恢复旧公网调用。旧配置及当前凭据另存私有备份。
6. 账号公钥与源 Relay 账号核对后，仅迁移 workspace 的账号/地址绑定和两个 runtime
   的 serverUrl / config binding。每个 runtime 的旧 binding 先通过原 schema 校验，
   新配置仅改变 URL，重新校验后原 thread、afterSeq、输入/输出账本保持。
   两个 Dot 最终 ready：`01a1b410-2bee-7a11-88c5-a20dd7880ccd`、
   `01a1b546-4965-70e1-8e94-6f7ba34d7e98`。

### 迁移中的失败与恢复

- 初次辅助脚本使用了 Python 3.10 没有的 `hashlib.file_digest`；改为流式 SHA256。
  首次 Docker 解包缺少 `-i`，容器未接收到归档；补齐标准输入后重新恢复并通过比较。
- 临时桥使用宿主端口，被 99.55 firewalld 拦截，旧入口出现 502 / RPC method not available。
  查明后仅为来源 99.57 临时放行 8193 / 9011，带超时；迁移完成已显式撤销。
- 在线切服重试碰到旧 socket 清理导致 `RPC target disconnected`。两轮分别成功覆盖
  全部 31 个唯一参与者；并非把失败响应算作成功。退役旧桥后另回读 32 个活跃会话
  （含两个 Dot 和工作台）与 2 台机器，均有 90 秒内心跳，确认没有依赖旧桥维持在线。
- Dot 首次恢复因 URL config binding 拒绝启动，完成上述显式绑定迁移后，继续发现
  `session_attach_missing`：托管 CLI 的 `attachSession` 只查最近 150 个会话。
  V2 分页确认原两个 Dot 仍存在后，通过现有 `/v1/relay/sessions/:id` 重新登记原加密
  snapshot，使它们进入最近列表；ID、密钥、消息 seq 保持，metadata / agentState 版本
  正常递增。自动恢复随后成功。未为迁移修改 CLI 查找逻辑，此分页边界仍是后续维护项。

### 旧端退役与备份

99.57 只修改 Happy 的两个标记区域，Nginx 候选及生效配置均通过 `nginx -t` 后热重载。
`/happy`、`/home-relay`、`/happy-control` 和 `/.happy-releases/` 的 Happy 路径返回 410。
其他项目配置保留。备份与候选：
`/root/bim-engine/script/happy-local-migration-20261107/`。原 `happy` 符号链接与整个
`.happy-releases` 目录已移到该目录的 `static/`，不再留在公开静态根目录，
防止经共享网关其他静态路径访问；旧产物保留用于审计。

99.55 旧 Relay、Control / gateway、临时 bridge 容器均 exited；Control pair 的 systemd
开机启用已取消，旧 Relay restart policy 设为 no。临时防火墙规则与 SSH 隧道已撤销，
8193 / 9011 / 28193 / 29010 不再监听。原卷、配置及 TLS 材料没有删除。

| 备份 | 位置 / SHA256 |
| --- | --- |
| 源 Relay 最终冷备 | 99.55 `/data/code/happy-relay/migration-backups/local-final-20261107/relay-data.tar.gz`；`5426647bd7710c183d1c4594564ac7370558e07903e8765181f8c70a0c4bc478` |
| 源 Control 最终冷备 | 同目录 `control-final.tar.gz`；`184c42cd6a9a06d57d17cf37b8427a1d7c160c06067f4ccd21fde4fda47cab62` |
| 本机证据 / 配置备份 / 冷备副本 | `~/.local/state/happy-local-migration-20261107/`，目录私有，备份文件 0600 |
| 原本机 Relay 卷冷备 | 上述目录 `source/relay-local-before.tar`；原卷也保留 |
| TestLoop 冷备 | `~/.local/state/testloop-backups/tailscale-local-20261107`，已校验 |

旧冷备只代表切流时刻。若需把权威实例迁回旧机器，必须协调当前本机停写、重新备份并
同步迁移后的数据；不能直接启动旧数据库，把后来写入当作可以丢弃。Control 回退同样
要保留当前 grants / receipts，不能恢复较早授权副本后重派旧任务。

### 验证结果与使用边界

- `final-verification.json`：21 项通过。覆盖私网首页、Dots / Settings SPA、三个入口 JS
  字节、WASM、缺失 JS 404、Relay / Control、原账号认证、私网 WSS 握手与心跳，
  以及旧公网 Web / Relay / Control / MCP / 静态版本六项 410。
- `private-mcp-verification.json`：3 个私网 MCP 到新 Worker 的只读模型目录调用通过，
  均返回 Codex / Claude / Agy；退役旧桥后再做一次只读调用仍通过，记录在
  `mcp-after-retirement.json`。不创建私人任务或调用付费模型。
- `attachment-verification.json`：已有加密附件经认证下载 200，字节哈希与卷内文件一致，
  返回下载 URL 为私网基址。直接走被禁止的 `/files/sessions/...` 返回 403 符合现有访问规则。
- `dot-runtime-final.json`：两个 Dot ready、原 thread 保持，scanner error 为 null。
  `live-participants-final.json`：32 个会话、2 台机器心跳新鲜。
- `assistant-health-final.json`：仍为 degraded，仅有原先的
  `assistant_runs_need_attention`、`assistant_conversation_needs_attention`、
  `assistant_happy_push_needs_attention`，没有清除历史错误来制造健康结果。
- 初次切流未运行真实浏览器；后续首屏修复已补充浏览器与用户手机登录页验证，见下节。
  手机登录后会话收发、附件上传和整机断电恢复仍未验收。没有发布 OTA、
  原生包、npm 或更新 CLI 代码。手机加入同一 tailnet 后，在 Happy 设置中填写上述 Relay
  基址；新 Web 域名需要登录原账号，不要创建替代账号。全局与 Node 环境中的外部模型
  供应商仍按原设置使用，迁移范围是 Happy 服务与访问入口。

### Web 首屏加载缓慢修复（2026-11-07）

用户报告 Shadowrocket 内置 Tailscale 已连接，Relay 有文字响应，但 Safari 打开 Happy
一直空白或转圈。实际检查发现：

- 本机入口与全部 HTML / JS / 字体资源返回 200，本机 HTTPS 主 JS 下载约 0.25 秒；
  这只能验证宿主本机链路，不能代替手机链路测速。
- 原 99.57 网关启用了 gzip / gzip_static，新本机配置遗漏；即使客户端声明支持 gzip，
  主 JS 仍传输 10228109 字节，common JS 2591152 字节、WASM 8001100 字节。
- 宿主测手机经美国 DERP 中继，三次 ping 约 329 / 407 / 1214 ms，未建立 direct；
  宿主 netcheck UDP=true，Windows 有启用的 Tailscale UDP 入站规则。用户确认独立
  Tailscale App 已断开，Shadowrocket 的“始终使用 DERP”关闭。没有据此擅自改防火墙、
  选择出口节点、强制其他 DERP 或恢复公网入口。

修复只涉及 `/home/dev/code/happy-local/config/nginx.conf` 与现有 Web 的压缩 sidecar：

- 复用 Nginx gzip / gzip_static，为 JS、CSS、WASM、JSON、SVG 和 TTF 中适合压缩的
  63 个现有静态文件生成 `.gz`；保留原文件及 MIME，sidecar mtime 与源文件一致，响应包含 Vary。
- `/happy/_expo/`、`/happy/assets/` 的内容哈希资源使用
  `Cache-Control: public, max-age=31536000, immutable`；固定名 canvaskit.wasm 使用
  `max-age=0, must-revalidate`，HTML 继续 no-cache。
- Relay / Control 代理显式关闭压缩继承。Nginx `-t` 通过后热重载，不重启后端、
  不改认证/数据，不编译新 App / CLI 或发布 OTA。

| 资源 | 原始字节 | gzip 传输字节 |
| --- | ---: | ---: |
| 主 JS | 10228109 | 2644976 |
| common JS | 2591152 | 621927 |
| canvaskit.wasm | 8001100 | 3193782 |
| 合计（不等于未登录首屏实际请求集合） | 20820361 | 6460685 |

HTTP 验证同时覆盖 identity / gzip 两种协商、解压后与源文件逐字节比较、Vary、缓存头、
ETag 304、SPA、真实缺失 JS 404、Relay health 和 Control compatibility，均通过。

得到当次浏览器授权后，按 agent-browser 技能启动独立、无登录态的 Chromium，先检查
登录页，再固化 Playwright CDP 脚本验证全新手机布局上下文。未登录或发送消息：

- 桌面和 390×844 手机布局登录页均可见；手机布局本机链路约 644 ms。
- 独立冷缓存上下文模拟 1 Mbps 下行、400 ms 延迟，约 40551 ms 出现登录按钮。
  两个手机场景均无 pageerror、console error、失败请求或非预期 HTTP 错误。
- 控制台保留一条产物内 `dev/masked-progress` 路由 warning，未将其计为错误或顺带改代码。
- 用户刷新私网地址后明确确认“已经出现登录页”。这是用户对真实 Safari 首屏的反馈，
  不是本机 Chromium 等同真实 Safari、或已完成登录后链路验收的证明。
- 为对照手机请求临时启用的静态路径日志仅记录 URI / 状态 / 大小 / 耗时 / UA，不记录
  query、认证头或消息。确认恢复后已撤销 `DEBUG-happy-web-slow-20261107` 配置并再次
  校验、重载 Nginx；隔离浏览器已关闭。

证据：`.e2e-artifacts/happy-web-slow-20261107/`（忽略目录，含桌面 / 手机截图、
`browser-report.json`、`compression-verification.json`、用户确认记录）；回滚配置与 gzip
清单保存在 `~/.local/state/happy-web-slow-20261107/`。

后续用户反馈访问速度很快，宿主再次检查：手机 `100.93.129.83` 的 `tailscale status`
显示 `active; direct`，`tailscale ping --c 3 --timeout 3s 100.93.129.83` 返回对端 UDP
地址，延迟约 49 ms，确认当次已建立直连。JSON 中 `CurAddr` 非空时仍可能保留
`Relay: sfo`，该字段不能单独用来判断业务流量仍走中继。“始终使用 DERP”关闭允许直连，
不禁止直连暂时失败时自动回退；最初未直连的具体原因未确定，也未量化手机完整加载耗时。
真实账号登录后收发、附件上传仍未验证。以后替换 Web 静态包时，
需重新生成对应 gzip sidecar，不能沿用同名文件的旧压缩内容。

## Runtime overview
- **App server:** Node.js running `tsx ./sources/main.ts` (Fastify + Socket.IO).
- **Database:** Postgres via Prisma.
- **Cache:** Redis (currently used for connectivity and future expansion).
- **Object storage:** S3-compatible storage for user-uploaded assets (MinIO works).
- **Metrics:** Optional Prometheus `/metrics` server on a separate port.

## Required services
1. **Postgres**
   - Required for all persisted data.
   - Configure via `DATABASE_URL`.

2. **Redis**
   - Required by startup (`redis.ping()` is called).
   - Configure via `REDIS_URL`.
   - Managed by this repo: `packages/happy-server/deploy/happy-redis.yaml` (StatefulSet + redis-exporter sidecar).

3. **S3-compatible storage**
   - Used for avatars and other uploaded assets.
   - Configure via `S3_HOST`, `S3_PORT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`, `S3_USE_SSL`.
   - **Deployed separately** — not managed by this repo's Kubernetes manifests. In prod, the S3-compatible service (MinIO or similar) behind `S3_PUBLIC_URL` is provisioned and managed by external infrastructure. The app only consumes it via env vars: `S3_PUBLIC_URL` is set in the Deployment, and credentials come from Vault via ExternalSecret (`/handy-files`).
   - If `S3_HOST` is unset, the server falls back to local filesystem storage (`./data/files/`).
   - For local k8s dev, a MinIO pod is deployed via `deploy/overlays/local/minio.yaml`.

## Environment variables
**Required**
- `DATABASE_URL`: Postgres connection string.
- `HANDY_MASTER_SECRET`: master key for auth tokens and server-side encryption.
- `REDIS_URL`: Redis connection string.
- `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`: object storage config.

**Common**
- `PORT`: API server port (default `3005`).
- `METRICS_ENABLED`: set to `false` to disable metrics server.
- `METRICS_PORT`: metrics server port (default `9090`).
- `S3_PORT`: optional S3 port.
- `S3_USE_SSL`: `true`/`false` (default `true`).

**Optional integrations**
- GitHub OAuth/App: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, plus redirect URL/URI.
  - `GITHUB_REDIRECT_URL` is used by the OAuth callback handler.
  - `GITHUB_REDIRECT_URI` is used by the GitHub App initializer.
- Voice: `ELEVENLABS_API_KEY` (required for `/v1/voice/conversations` in production).
- Subscriptions: `REVENUECAT_API_KEY` (server-side RevenueCat key, required for voice subscription checks).
- Debug logging: `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` (enables file logging + dev log endpoint).

## Docker image
A production Dockerfile is provided at `Dockerfile.server`.

Key notes:
- The server defaults to port `3005` (set `PORT` explicitly in container environments).
- The image includes FFmpeg and Python for media processing.

## 自建 Relay：Docker Compose 测试部署

### 192.168.99.55 定向推送最小补丁（2026-11-04）

已按当次用户明确批准的**非 main 最小补丁例外**，在原运行镜像上回移
`b0f850d4b43334036a31e73ef2f780af9af5a119` 的目标会话焦点判断。旧版会因任何
前台 Happy UI 抑制其他会话通知；现在仅明确查看目标会话时抑制，并识别已有的
`alwaysPushToPhone` 输入。只覆盖 `eventRouter.ts`、`focusTracker.ts`、
`pushDispatch.ts`、`socket.ts`，保留原镜像其他层、依赖、配置和数据库结构。

| 项目 | 本次结果 |
| --- | --- |
| 实例 | `192.168.99.55:/data/code/happy-relay`，项目 `happy-relay`，仅更新 `relay` 服务 |
| 镜像 | `happy-relay:targeted-focus-aacf81fae02e` |
| 镜像 ID | `sha256:c235c83318d20ab2b7b2804c77f006db931a596c7365a1b63c8a399d32161801` |
| 原始基线 | `happy-relay:relay-switch-d346ec958c0b`，镜像 ID `sha256:89664c870fbc18705d11bbd661a7918966c53c8480ad5efa8542cbea9e4f53d8` |
| 补丁 SHA-256 | `aacf81fae02ec2060b51e1581005423b70ddbae8a1df87b73ac46245a2df2c6a` |
| 来源 | 经明确批准保留现有镜像基线的非 main 回移；当次 fetch 的 `fork/main` 为 `aa8b0dcef288cfe094ff58afc46f2d0e8b919737`，未执行整版主线升级 |
| 容器 | `039f621e3b26385473957bd96d4fcd1d96a1021910cfe4bc215cad56e878c224`，启动于 `2026-11-04T03:36:44.59580502Z` |
| 已核验 | 健康、重启计数 0、实际四文件 SHA、运行环境变量相同、原数据卷与端口相同、无新增迁移、专用会话认证读回及旧消息保留 |

一致性备份位于：

```text
/data/code/happy-relay/backups/20261104T033518Z-targeted-focus-aacf81fae02e
```

原 `.env.relay`、Compose、数据/附件归档及校验值均已保留；目录权限 `700`，备份文件
权限 `600`。归档完整读取检查通过，SHA-256 为
`c924525c3db6a40a4af5ae70a6c09b1ab60807fda06b088b601d9fc5aaa4d6b2`。
`release-source/` 保留四文件源码、补丁、摘要和构建入口，便于从同一基线镜像复现。
回滚使用该备份中的原配置与原镜像，保留当前数据卷；本次没有结构迁移。

候选针对性测试 17/17 通过，原镜像同一组测试出现 9 项断言失败，覆盖目标会话判断、
参数传递与 socket 握手/状态更新。相同配置的生产源码类型检查和隔离启动通过；原始
完整测试类型检查因运行镜像缺少 App 测试引用源码而失败，失败记录已保留，不能称
完整测试类型检查通过。测试模拟 Expo 与 Socket.IO 基础设施，不能代替真机显示验收。

首次尝试因操作者依据过期状态发送中断信号而在备份中触发自动回滚，原版恢复健康；
随后去除较慢的全容器清单查询，再次完成备份并成功部署。首次中断备份不作为可用
数据归档，记录位于 `backups/20261104T033339Z-targeted-focus-aacf81fae02e`。
此次仅向 `relay` 发出 stop/up，未执行全容器重启；其他容器清单未独立核验。
部署后外部健康接口及既有专用会话读取通过，启动日志无新增迁移或非预期错误。
部署后沿用原职责重排一次真实提醒，正文已在原专用会话读回；正常推送事件返回
`sent`，网关接受设备数为 `1`，没有再被活跃UI规则抑制。本次重排和提醒没有新增
模型调用。用户随后明确反馈未收到系统通知，手机显示的端到端验收未通过，点击
跳转未验证；不能由网关接受代替。现有客户端整个App前台时隐藏系统横幅，且App内
列表过滤非活跃的普通会话；是否命中本次场景仍待核验前后台状态、设备权限及实际
客户端版本，不将源码策略直接认定为本次投递失败原因。

### 192.168.99.55 全量源码升级（2026-11-04）

经本次用户明确授权，将个人 `main` `87e16bb659ec4b6361f1de93fe6fb47f0fd25d26`
的完整 `happy-server` / `happy-wire` 源码部署到现有 Relay。镜像以原补丁镜像为基线，
仅替换两个包的源码与 wire `dist`，复用未变化的依赖，不更换密钥、账号配置或数据卷。

| 项目 | 本次结果 |
| --- | --- |
| 实例 | `192.168.99.55:/data/code/happy-relay`，项目 `happy-relay`，仅更新 `relay` 服务 |
| 镜像 | `happy-relay:head-87e16bb659ec`，镜像 ID `sha256:88fe97123ab3cd2359e31c2dbc218cb468ab3d28789c9fe27c0f3deb5d95d34b` |
| 基线镜像 | `happy-relay:targeted-focus-aacf81fae02e`，镜像 ID `sha256:c235c83318d20ab2b7b2804c77f006db931a596c7365a1b63c8a399d32161801` |
| 来源 | `main` `87e16bb6...`，源码树 `3e01ff794681947aecaa2847c91aa8616e26fcf8`；发布 clone 干净且等于当次 `fork/main` |
| 容器 | `0f158b3924c932765fff18c1a521783a6613b3799b7e727139215351c7a59a89`，启动于 `2026-11-04T10:52:54Z` |
| 备份 | `/data/code/happy-relay/backups/20261104T104633Z-head-87e16bb659ec`；数据归档 SHA-256 `437e7c5934ccea7da01a399da5c96cda620adf01d6d2e807dc1f1696132fa8ed`，约 1021M |
| 已核验 | 健康、重启计数 0、镜像标签 revision/tree/off-main、镜像内 server 与 wire 类型检查、运行源码包含 `sessionAttention`，除 `RELAY_IMAGE` 外环境变量逐字一致、数据卷相同、无新增迁移、公网 `/home-relay/health` 200、`/happy-control/v1/compatibility` 200、启动日志无错误 |

相比上一补丁镜像，本版本额外包含会话注意力记录/去重与 badge、`failed` / `intervention`
事件类型、intervention 始终推送、启动 RPC 50s 超时、push priority 等改动。
回滚时将 `.env.relay` 的 `RELAY_IMAGE` 改回 `happy-relay:targeted-focus-aacf81fae02e`，
执行同样的 `docker compose ... up -d --no-build`；数据卷保留，必要时用上述备份恢复。

**未验证**：未用真实账号验证登录后的消息收发、推送投递、附件和真机显示；健康检查与
WSS 握手不能代替这些业务流程。

### 192.168.99.55 分支测试发布（2026-10-18）

已按本次会话的明确授权，将 `feat/custom-relay-url` 的分支测试版本原位置升级到
`192.168.99.55`。发布前在临时独立 clone 中同步并 rebase 到上游，随后应用获准的
35 个暂存文件。该次镜像发布未在原功能 worktree 执行 rebase、commit 或 push，
随后补充部署记录。App 和 CLI 安装版本未在此次更新。

| 项目 | 已验证结果 |
| --- | --- |
| API 地址 | `http://192.168.99.55:8193`，不带 `/relay` 前缀 |
| 启动目录 | `/data/code/happy-relay`；与现有 `/data/code/` 下的其他服务保持同一部署布局 |
| Compose / 项目 | `docker-compose.relay-only.yml` / `happy-relay` |
| 容器 | `happy-relay-relay-1`，健康，检查时重启计数为 0 |
| 镜像 | `happy-relay:relay-switch-d346ec958c0b` |
| 镜像 ID | `sha256:89664c870fbc18705d11bbd661a7918966c53c8480ad5efa8542cbea9e4f53d8` |
| 发布来源 | 非 main 的获批测试发布；原分支基线 `7705608a`，临时重放后基线 `1dc4e0d7`，再应用暂存改动 |
| 上游 / 代码指纹 | 上游 `4baddee7`；源码树 `d346ec958c0bc661c9b2816eaa3997d66d281135`；当时上游没有缺失提交 |
| 数据卷 / 密钥 | 保留原卷 `happy-relay_relay-data`；运行中主密钥指纹与升级前一致，未重新生成主密钥 |
| 数据库 | schema 与原版本一致，39 个迁移，没有新增迁移；已有账号和会话可访问 |
| 账号访问方式 | 保留原有公开注册行为，明确设置 `HAPPY_ALLOWED_ACCOUNT_IDS=*`，本次未擅自收紧白名单 |
| 其他服务 | 其他容器 ID 保持不变，未重建或重启其他 Compose 项目 |

升级前停止原 Relay 做了一致性数据与附件备份，随后替换容器。备份目录：

```text
/data/code/happy-relay/backups/20261018T011002Z-d346ec958c0b
```

其中保存原 `.env.relay`、Compose、数据卷归档与校验和，以及本次源码树快照和验证记录。
目录权限为 `700`，备份文件为 `600`；不要公开其中的环境配置或数据归档。
部署根目录的 `release-manifest.json`、`deployment-result.json` 和 `verification.json`
记录镜像来源、备份位置及验证结果。

本次镜像构建与类型检查通过；容器内 43 项相关测试、7 项 API/WebSocket 检查和
2 项升级/回滚隔离检查通过。生产侧验证了外部 `/health`、未登录访问的预期 `401`、
已有账号认证、在线切换能力接口与既有会话 ID，验证未向生产数据库写入测试消息。
备份校验通过，未发现实际 error / exception / failed 日志；正常汇总行的 `errors=0`
和主动未登录探测产生的 `401` 不属于部署故障。

日常检查在服务器启动目录执行：

```sh
cd /data/code/happy-relay
docker compose -p happy-relay -f docker-compose.relay-only.yml --env-file .env.relay ps
curl --fail http://127.0.0.1:8193/health
```

要测试 App 改地址后免扫码、免手动重启的完整体验，仍需更新 App 与各设备的
CLI / daemon；已有旧会话也需先加载一次新代码。此次未发布 App、CLI 或执行真机、
真实模型联调。当前记录是分支测试部署，功能合入 main 后应再按正式发布流程更新。

### 部署前准备（192.168.99.56）

这份说明用于准备容器化部署；准备文档和运行 `--dry-run` 不会部署服务器。
当前目标是 `root@192.168.99.56`，本机 `~/.zshrc` 的 `log9956` 为该 SSH 命令的别名。
没有显式端口参数，端口、密钥或代理仍可能来自 `~/.ssh/config`。
本次仅用 `ssh -G` 读取本地有效配置：用户 `root`、端口 `22`；默认候选私钥
`~/.ssh/id_rsa` 存在。未读取私钥内容，也未验证目标服务器是否接受该密钥。
**目前未连接目标机核验 Docker、认证、磁盘、端口或网络，以下目标配置尚未实机验证。**

| 项目 | 本次建议值 / 部署前需要完成的事项 |
| --- | --- |
| SSH | 确认 `ssh root@192.168.99.56 true` 成功；脚本采用非交互 SSH，需要可用的密钥、ssh-agent 或 SSH 配置 |
| 开发机 | Node.js 20+、Git、Docker Engine、OpenSSH 的 `ssh` / `scp`；Docker daemon 可用且有镜像构建/导出权限 |
| 服务器 | Linux、可用的 Docker Engine 与 Compose v2 插件；Compose 的 `up` 需支持 `--wait`、`--wait-timeout`；有 `openssl`、`awk`、`df` |
| 源码 | 将 Relay 账号访问控制、在线切换及本次部署脚本合入计划发布的 `main`；在独立 clone 中保持干净，并与刚 fetch 的 `origin/main` 完全一致 |
| 当前代码状态 | 本次功能仍在 `feat/custom-relay-url` 且有未提交改动，尚不满足正式发布前置条件；不能直接把此工作目录当发布源 |
| 镜像 | 复用根 `Dockerfile`，包含 PGlite 与本地附件存储；镜像 CPU 架构必须适用于目标机；预构建镜像也必须包含账号访问控制和在线切换接口 |
| 部署目录 | `/data/code/happy-relay`；SSH 用户需能创建/写入该目录并执行 Docker |
| 实例名 | `happy-relay`；同一服务器上的额外实例需要不同的项目名、目录和宿主机端口 |
| 内网入口 | `http://192.168.99.56:8193`；建议仅绑定 `192.168.99.56` 并由防火墙限制内网来源 |
| 公网入口 | 准备域名、证书和支持 WebSocket 的 HTTPS 网关；后端绑定 `127.0.0.1`，`PUBLIC_URL` 使用客户端实际访问的完整地址 |
| 数据和密钥 | 数据卷保存数据库和附件；`.env.relay` 保存一次生成的 `HANDY_MASTER_SECRET`；两者都需备份，重部署时保留 |
| 账号 | 新实例没有账号，默认拒绝所有账号；先在受控内网初始化，再填写这台 Relay 的账号 ID 白名单，最后开放正式入口 |
| 客户端 | App 和在线 CLI / daemon 需要包含在线切换实现；普通 `/health` 成功不代表账号可用或 WebSocket 正常 |

不需要在目标服务器安装 Node.js、pnpm、Postgres、Redis 或 S3，也不需要把整个源码仓库
复制到服务器。开发机负责构建/准备镜像，服务器只保存镜像、Compose 文件、环境配置和数据卷。
容量需求需要按实际使用测量；首次构建与镜像导出会额外占用开发机磁盘。

先预览执行计划（不运行 SSH、Git、Docker，不生成密钥）：

```sh
node scripts/deploy-relay.mjs --dry-run \
  --host root@192.168.99.56 \
  --image happy-relay:main-REPLACE_WITH_COMMIT \
  --public-url http://192.168.99.56:8193 \
  --bind-address 192.168.99.56
```

源码满足发布条件后，部署前运行只读自检。该命令会实际连接服务器，但不会创建目录、
修改 `.env.relay`、构建/导入镜像或启动容器：

```sh
node scripts/deploy-relay.mjs --check --host root@192.168.99.56
```

脚本不会 source `~/.zshrc`、读取私钥内容或复制口令。`log9956` 是 shell 别名，不能直接
用作 `--host`；可以使用 `~/.ssh/config` 中的 Host 别名，或传 `--ssh-port` / `--identity`：

```sh
node scripts/deploy-relay.mjs --check --host root@192.168.99.56 \
  --ssh-port 22 --identity ~/.ssh/id_rsa
```

### 容器和首次部署顺序

默认推荐 `docker-compose.relay-only.yml`：一个 Relay 容器，内含 PGlite、文件存储和
进程内事件总线。已有 HTTPS 网关可以直接代理该容器；需要 `/relay` 等路径前缀时，
由已有网关剥离前缀，或使用下面的双容器 Compose 入口。

1. 完成上面的源码、SSH、Docker、网络和备份准备。实际发布遵循
   [release 技能](../.agents/skills/release/SKILL.md) 的干净 main 规则。
2. 从符合条件的独立 main clone 构建镜像，或使用已经按该规则构建的本地镜像。
   旧的上游 main 或旧镜像可能不包含本分支能力；脚本会拒绝缺少必要代码的构建源或镜像。
3. 执行部署脚本：镜像存在且镜像 ID 相同时跳过传输，否则导出、压缩、传输并导入；
   复制 Compose 文件、保留既有配置与主密钥，最后 `up -d --no-build --wait`。
4. 首次部署默认 `deny-all`。在受控内网，登录服务器编辑部署目录中的 `.env.relay`，
   临时设置 `HAPPY_ALLOWED_ACCOUNT_IDS=*`，确认仅绑定指定内网地址并限制来源，
   再执行对应 Compose `up -d` 使配置生效。
5. 用包含本次改动的 App 切到这个内网地址，自动认证并让在线 CLI 跟随；按下方
   “私有 Relay”步骤获取新实例上的账号 ID。随后执行脚本的 `--allowed-accounts`，
   将临时开放收紧为指定账号；此配置变更会重建 Relay 容器。
6. 检查账号访问、WebSocket、消息双向收发及权限批准，再根据需要启用公网 HTTPS。

准备发布源并选择镜像来源：

发布时应从已包含本次改动的独立 main clone 执行脚本。没有现成镜像时，先在该 clone
中构建；以下命令中的 clone 目录应位于当前 worktree 之外，且 `origin` 指向你计划发布的仓库。
个人 fork 的功能必须先合入它的 main，不能仅存在于功能分支：

```sh
# 首次准备发布源；已有独立 clone 时直接进入该目录。
git clone --branch main git@github.com:prophetw/happy.git ~/code/happy-relay-release
(
set -eu
cd ~/code/happy-relay-release
git fetch origin main
test "$(git branch --show-current)" = main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain=v1)"

# 直接复用现有脚本构建并部署；执行前先完成 --check。
node scripts/deploy-relay.mjs --source "$PWD" \
  --host root@192.168.99.56 --bind-address 192.168.99.56 \
  --public-url http://192.168.99.56:8193
)
```

`--image` 跳过源码获取和构建。使用它时也要先完成同样的发布源检查，并核对镜像
`org.opencontainers.image.revision` 标签对应选定的 main 提交；镜像能力检查只确认
必要代码存在，不代替发布来源审核或完整业务验收。镜像必须可在开发机执行本地能力探测，
跨架构场景需要兼容的构建机或已经配置的模拟执行环境，本次尚未验证跨架构部署。

已经准备好合规镜像时，在经过上述 main 检查的发布目录执行：

```sh
node scripts/deploy-relay.mjs \
  --host root@192.168.99.56 \
  --image happy-relay:main-REPLACE_WITH_COMMIT \
  --dir /data/code/happy-relay \
  --project happy-relay \
  --bind-address 192.168.99.56 \
  --port 8193 \
  --public-url http://192.168.99.56:8193

# 初始化账号后收紧名单；账号 ID 必须来自这台 Relay。
node scripts/deploy-relay.mjs --host root@192.168.99.56 \
  --image happy-relay:main-REPLACE_WITH_COMMIT \
  --allowed-accounts REPLACE_WITH_ACCOUNT_ID
```

所有 `REPLACE_WITH_...`、`NEW_SERVER` 占位值都需替换，不是可直接运行的实际值。
部署脚本的健康检查只确认容器和基础 API 可用；最终从手机/CLI 实测认证、实时消息与
权限操作。已有数据更新前备份数据卷和 `.env.relay`；回滚旧镜像前先确认数据库迁移兼容，
不要使用 `down -v`，也不要重新生成已有主密钥。

仓库根目录的 `docker-compose.yml` 复用 standalone `Dockerfile`：一个 Happy
relay 实例使用 PGlite 和本地文件存储，另一个 Nginx 网关负责路径前缀及
WebSocket 转发。默认对外提供 HTTP `8193` 端口和 `/relay` 前缀；数据库和附件
共同保存在 `relay-data` 命名卷中。此方式适用于单实例服务器测试。

在服务器上，进入包含本次改动的仓库根目录，准备环境配置：

```sh
cp .env.relay.example .env.relay
chmod 600 .env.relay
relay_master_secret="$(openssl rand -hex 32)"
sed -i "s/^HANDY_MASTER_SECRET=$/HANDY_MASTER_SECRET=$relay_master_secret/" .env.relay
unset relay_master_secret
```

编辑 `.env.relay`，将 `YOUR_SERVER` 换成服务器域名或 IP。例如：

```dotenv
RELAY_PUBLIC_URL=http://xxx.xxx.com:8193/relay
RELAY_BIND_ADDRESS=0.0.0.0
RELAY_PORT=8193
RELAY_BASE_PATH=/relay
HAPPY_ALLOWED_ACCOUNT_IDS=your-existing-account-id
```

`RELAY_PUBLIC_URL` 是客户端访问的完整 API 基址，也是服务器生成附件及头像
地址的 `PUBLIC_URL`。它不带尾斜杠；路径部分应与 `RELAY_BASE_PATH` 一致。
前缀可以换成 `/team/relay` 等多级路径，需以 `/` 开头且不带尾斜杠。
`RELAY_PORT` 是宿主机发布端口，容器内 API 始终使用 `3005`，仅供网关访问。

启动、检查和查看必要日志：

```sh
docker compose --env-file .env.relay config --quiet
docker compose --env-file .env.relay up -d --build
docker compose --env-file .env.relay ps
curl --fail http://127.0.0.1:8193/relay/health
docker compose --env-file .env.relay logs --tail 50 relay gateway
```

`/health` 应返回 `service: "happy-server"` 和 `status: "ok"`。
宿主机及云服务的入站规则需要允许实际使用的对外端口。App 中填写
`RELAY_PUBLIC_URL`；CLI 和 happy-agent 使用相同的 `HAPPY_SERVER_URL`。
带前缀地址需要本次分支中已更新的客户端。

后续更新使用相同的 `.env.relay` 和项目名执行 `up -d --build`。网关会随 relay
的 Compose 更新重新启动，以刷新上游连接。停止服务使用
`docker compose --env-file .env.relay down`，该命令保留数据卷；`down -v` 会删除
数据库和附件。`HANDY_MASTER_SECRET` 也需要保持原值，以保留已有认证和服务端密钥。
多个独立测试实例可通过 `docker compose -p <name>` 区分，并分别配置端口及密钥。

### 私有 Relay：仅允许指定 Happy 账号

两个 Compose 入口都传入 `HAPPY_ALLOWED_ACCOUNT_IDS`，默认空值会拒绝所有账号。
填入这台 relay 上已有的 Happy 账号 ID，多个 ID 用逗号分隔：

```dotenv
HAPPY_ALLOWED_ACCOUNT_IDS=account-id-1,account-id-2
```

限制在服务端执行，App、CLI 和 happy-agent 不需要额外的访问密码：

- 名单内账号可以登录，并继续通过扫码批准其他设备加入同一个账号。
- 名单外账号和新账号的签名登录返回 `403`；不会自动创建新账号。
- 名单外账号以前签发的 Bearer Token 也会被拒绝，包含 REST 和 Socket.IO。
- 设备配对不能为名单外账号签发新 Token。
- `/files/...` 不再公开提供 `sessions/` 和 `projects/` 下的私人文件；附件和头像
  继续通过原有的鉴权接口下载。

已有 relay 应在内网完成登录并获取账号 ID，再启用限制。在已经登录**这台 relay**
的 CLI 开发机运行下面的命令，只打印当前账号 ID，不打印 Token 或密钥：

```sh
HAPPY_SERVER_URL=http://192.168.99.55:8193 node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const homeDir = (process.env.HAPPY_HOME_DIR || join(homedir(), '.happy')).replace(/^~/, homedir());
const { token } = JSON.parse(await readFile(join(homeDir, 'access.key'), 'utf8'));
const baseUrl = process.env.HAPPY_SERVER_URL.replace(/\/+$/, '');
const response = await fetch(`${baseUrl}/v1/account/profile`, {
  headers: { Authorization: `Bearer ${token}` }
});
if (!response.ok) throw new Error(`Account lookup failed: HTTP ${response.status}`);
console.log((await response.json()).id);
NODE
```

将 `HAPPY_SERVER_URL` 换成实际 API 基址，包含实际路径前缀。账号 ID 属于当前
relay 的数据库，其他 relay 上同一个人的账号 ID 不能直接套用。

首次部署的空数据库还没有账号。先保持入口仅在本机或受控内网可访问，并明确设置
`HAPPY_ALLOWED_ACCOUNT_IDS=*` 进行初始登录、设备配对和 ID 获取。随后改为具体
账号 ID，重新创建 relay 容器，再开放公网 HTTPS 入口。`*` 表示允许所有账号，
不能留在私人公网部署中。直接运行上游服务器而完全不设置该变量，仍保留原有的
公开注册行为；显式空值始终拒绝所有账号。格式错误会阻止服务启动。

修改名单后，用对应 Compose 命令执行 `up -d`，让新容器配置生效并断开旧连接。
只执行 `docker compose restart` 不会更新容器的环境变量。
`/health` 成功只表示服务运行正常，不代表你的账号已获准使用。

公网仍能访问健康检查、登录和配对申请等必要入口，白名单限制的是可使用 relay
的账号。Nginx 可为这些公开入口配置请求限流；白名单本身不是流量攻击防护。

### HTTPS 入口

#### 复用 99.57 的现有 Nginx，代理 99.55 的 relay-only

已只读确认（2026-10-18）：`99.57` 的目录为 `/root/bim-engine/script`（单数），
容器 `bim-nginx-1.30` 将其中的 `http.nginx.1.30.1.prod.conf` 挂载为
`/etc/nginx/nginx.conf`。该配置的 `listen 7100 ssl` 已有证书和其他路径代理；
从 `99.57` 访问 `http://192.168.99.55:8193/health` 返回 `status: ok`。

将 [最小配置片段](../deploy/relay/nginx-location.conf) 的内容粘贴到这个现有的
HTTPS `server { ... }` 块内，与其他 `location` 同级。片段复用已有证书，
将 `/home-relay/` 转发至 `http://192.168.99.55:8193/`，剥离前缀并支持 WebSocket。
对外地址为现有 HTTPS 站点基址加 `/home-relay`，复用当前域名和端口，无需新增
`listen`、端口映射或证书。`8193` 仅为 Nginx 访问 Relay 的内网后端端口。
这是 `server` 内的片段，不能替换整个 `nginx.conf`，也不能直接放入默认在
`http` 层加载的 `conf.d/*.conf`。当前容器仅挂载主配置；若改用 `include`，
需另外挂载该片段并在 `server` 内引用容器中的路径。

客户端启用前在 `99.55:/data/code/happy-relay/.env.relay` 中，将 `RELAY_PUBLIC_URL`
改成客户端实际访问的完整 HTTPS 基址（包含 `/home-relay`，末尾不加 `/`）。
下面的域名替换为现有站点域名；若原站点地址本来带端口，保留该端口：

```dotenv
RELAY_PUBLIC_URL=https://your-existing-domain.example/home-relay
```

App 中也填写相同基址。`RELAY_PUBLIC_URL` 用于生成附件等资源地址，不能只改 Nginx。
保留其余环境变量、镜像、密钥和数据卷，在 `99.55` 的部署目录使该配置生效：

```sh
docker compose -p happy-relay -f docker-compose.relay-only.yml --env-file .env.relay up -d --no-build --wait relay
```

这会重新创建 Relay 容器，无需重建镜像。随后在 `99.57` 检查并热重载 Nginx：

```sh
docker exec bim-nginx-1.30 sh -c 'nginx -t && nginx -s reload'
curl --fail --show-error https://your-existing-domain.example/home-relay/health
```

将最后一条命令的域名和端口换成实际公网入口，再验证客户端 WebSocket 和消息收发。
片段已在临时 Nginx 1.31.6 中通过语法检查，并经 HTTPS 代理实际 `99.55` Relay
验证健康检查、保留查询参数的跳转、未认证 API 的 401、Socket.IO polling 和 WSS 双向 ping/pong。

2026-10-18 10:18（UTC+8）已按用户确认更新 `99.57` 上述主配置并热重载，
仅添加 `/home-relay` 的两个 `location`。主配置以原 inode 写入，容器和 Nginx
主进程未重启，既有监听端口、证书和其他路径配置未修改。

- 实际入口：`https://szsp.suitbim.com.cn:7100/home-relay`，复用已有 `7100 ssl`。
- 原配置备份：`/root/bim-engine/script/http.nginx.1.30.1.prod.conf.bak.home-relay-20261018T021830Z`。
- 部署报告：`/root/bim-engine/script/happy-home-relay-deployment-20261018T021830Z.json`。
- 已验证：实际 Nginx 1.30.1 的候选配置和生效文件均通过 `nginx -t`；
  经现有域名正常解析访问健康检查返回 200，WSS 握手和双向 ping/pong 通过；
  未认证 API 返回 401，Socket.IO polling 返回 200。原站点根路径在修改前后均为 404。

2026-10-18 14:34（UTC+8）已按用户要求更新 `99.55` 的 `.env.relay`：

```dotenv
RELAY_PUBLIC_URL=https://szsp.suitbim.com.cn:7100/home-relay
```

只重新创建 Relay 容器，已验证运行时 `PUBLIC_URL` 为该 HTTPS 基址。原镜像、
`happy-relay_relay-data` 数据卷、主密钥、其他环境变量和端口均保持一致；
其他容器 ID 未改变。配置备份位于：

```text
/data/code/happy-relay/backups/20261018T063438Z-public-url
```

备份目录权限 `700`、文件 `600`，包含原环境配置、Compose 和 `result.json`。
部署目录另存 `public-url-update-result.json`。首次执行因校验脚本混用短容器 ID 和
完整 ID 触发自动回退，已统一为 `docker ps --no-trunc` 后重新执行成功；首次记录
保留在 `backups/20261018T063328Z-public-url/attempt-result.json`。

配置检查、容器健康检查、公网域名 `/health` 的 200、未认证 API 的 401、
Socket.IO polling 和 WSS 双向 ping/pong 均已验证；本地部署脚本 22 项测试通过。
实际手机登录、附件上传下载及消息收发尚未验收，App 和 CLI 新版尚未发布。

#### 使用 Compose 内置路径网关

使用双容器 `docker-compose.yml` 时，外层网关同样复用现有站点的 HTTPS 入口，
Compose 的内部 HTTP 入口例如使用 `18193`：

```dotenv
RELAY_PUBLIC_URL=https://your-existing-domain.example/home-relay
RELAY_BIND_ADDRESS=127.0.0.1
RELAY_PORT=18193
RELAY_BASE_PATH=/home-relay
```

外层网关将 `/home-relay/...` 原样转发到 `http://127.0.0.1:18193`，并支持 WebSocket
Upgrade；Compose 中的网关负责剥离此前缀。TLS 证书由外层网关配置。
公网 HTTPS 和实际手机访问需在目标服务器上验收。
公网 HTTPS 入口只转发到内部 HTTP 端口；同机部署时保持
`RELAY_BIND_ADDRESS=127.0.0.1`，避免通过 `8193` 等后端端口绕过外层网关。
如果 Nginx 与 relay 不在同一服务器，后端端口的防火墙只允许 Nginx 服务器连接。

### 仅部署 relay 服务

已有网关或只需直接访问 API 时，使用 `docker-compose.relay-only.yml`。
它只运行一个 relay 容器，将宿主机 `8193` 直接映射到容器 `3005`：

```sh
cp .env.relay-only.example .env.relay
chmod 600 .env.relay
# 填写 RELAY_PUBLIC_URL、HANDY_MASTER_SECRET 和 HAPPY_ALLOWED_ACCOUNT_IDS。
docker compose -f docker-compose.relay-only.yml --env-file .env.relay up -d --build
curl --fail http://127.0.0.1:8193/health
```

直连时 `RELAY_PUBLIC_URL` 使用 `http://<服务器地址>:8193`，不加 `/relay`。
如果由已有外部网关提供带前缀的 URL，则网关负责剥离前缀，并将
`RELAY_PUBLIC_URL` 改为客户端最终访问的公网基址。该模式使用相同的
`relay-data` 数据卷和主密钥配置。

采用预构建镜像时，在目标服务器加载镜像并将 `RELAY_IMAGE` 设置为对应标签，
启动命令改为 `up -d --no-build`；部署目录只需要 Compose 文件和 `.env.relay`。

### 一键部署到 SSH 服务器

开发机上执行以下命令，会自动准备最新 upstream `main`、复用或构建对应镜像、
比较服务器镜像 ID、在需要时传输/导入，并启动 relay 和验证健康响应：

```sh
node scripts/deploy-relay.mjs
```

默认目标为 `root@192.168.99.56:/data/code/happy-relay`。开发机需要 Node.js、
Git、Docker、SSH/SCP，服务器需要 Docker Compose 和首次生成密钥用的 OpenSSL。
源代码使用独立的缓存 clone，必须处于干净 `main` 并等于刚 fetch 的 `origin/main`；
不会切换当前工作分支。可用 `--source <path>` 指定已有的合规 main clone。
用于本分支功能时，该 main 必须已合入账号访问控制和在线切换实现；缓存的上游 main
不保证包含这些能力。可以先将个人 fork 的 main 克隆到独立目录，再用 `--source` 指向它。

已经准备好本地镜像时，直接指定标签可跳过源码更新和构建：

```sh
node scripts/deploy-relay.mjs --image happy-relay:main-fba320e4
```

服务器已有相同镜像 ID 时，跳过打包、传输和导入。既有 `.env.relay` 中的主密钥、
公网地址和端口会保留，数据卷不会删除；首次部署才生成主密钥。需要改目标或配置时
使用 `--host`、`--dir`、`--public-url`、`--port`，可通过 `--help` 查看参数。
`--allowed-accounts <账号ID1,账号ID2>` 设置允许使用 relay 的账号；省略时保留已有
名单，首次部署默认拒绝所有账号。例如：

```sh
node scripts/deploy-relay.mjs --allowed-accounts your-existing-account-id
```

首次部署需要先按“私有 Relay”小节在受控内网完成账号初始化。该选项不接受 `*`，
避免一键私人部署意外开启公开注册。镜像必须包含本次账号访问控制实现；旧镜像
不会因为新增环境变量就自动获得白名单能力。
源码或依赖发生变化的新版本仍需要实际构建，自动化并不消除这部分耗时。

### 快速部署到其他服务器

复用同一个兼容 CPU 架构的镜像，替换 SSH 目标、公开地址和绑定地址即可。每台新服务器
都需要独立初始化账号和白名单；不会自动复制 `.env.relay`、主密钥、数据库或历史。

```sh
node scripts/deploy-relay.mjs --dry-run --host root@NEW_SERVER \
  --image happy-relay:main-REPLACE_WITH_COMMIT \
  --bind-address REPLACE_WITH_LAN_IP --public-url http://NEW_SERVER:8193

node scripts/deploy-relay.mjs --check --host root@NEW_SERVER

# 完成检查后去掉 --dry-run 才会实际部署。
```

同机多实例必须同时指定不同的 `--project`、`--dir`、`--port`。项目名保存为
`.env.relay` 的 `COMPOSE_PROJECT_NAME`，后续省略参数仍使用该实例的数据卷；
已有实例不要随意改项目名，否则会使用另一个数据卷。

公网 HTTPS 的部署示例使用 `--bind-address 127.0.0.1 --port 18193
--public-url https://relay.example.com/relay`，已有网关需剥离 `/relay` 并转发
WebSocket 到 `http://127.0.0.1:18193`。TLS、云防火墙和宿主机网关由运维环境配置，
脚本不自动安装 Docker、不配置 DNS/证书，也不会关闭或修改防火墙。

本次准备阶段验证：`node --check scripts/deploy-relay.mjs`、部署脚本 22 项隔离测试、
`--help` / `--dry-run` 以及实际 Docker Compose 配置解析通过。测试使用临时目录和模拟
SSH/Docker 命令，没有连接目标服务器；Compose 解析确认项目名、内网绑定、端口、
`/data` 数据卷和默认拒绝账号的配置，没有启动容器。镜像构建、目标机 `--check`、
实际部署和公网/真机验收仍待执行。

`.env.relay` 已被 Git 忽略，Docker 构建也排除环境文件及本地验证产物。
模板中没有实际密钥。配置关系及客户端行为另见
[自定义 Relay 地址](features/custom-relay-url.md)。

## Web：复用现有 HTTPS 域名并挂载到 /happy/

**最近发布：2026-11-04，来源 `87e16bb659ec`。** 公网 HTTP 与 WSS 握手检查通过，
本次未执行真实浏览器与登录后的业务验收。2026-10-25 首次发布的浏览器冒烟记录保留，
但不能代替新版本的浏览器验收。来源、验证边界与回滚记录见第 0 节的公网发布记录。
`/happy` 的源码适配、本地 Web 导出和浏览器复验记录也保留在第 0 节。
部署前 2026-10-24 的只读检查确认：现有 Relay 公网 `/health` 返回 200；
`99.57` 的 Nginx 正在运行，已有静态目录挂载且加载了 `mime.types`；
当时 `/happy/` 返回 404，宿主机对应目录尚不存在。后续操作仍需核对实际状态。

| 项目 | 本次方案 |
| --- | --- |
| Web 公网入口 | `https://szsp.suitbim.com.cn:7100/happy/` |
| Relay API 基址 | `https://szsp.suitbim.com.cn:7100/home-relay` |
| 网关 | `root@192.168.99.57`，容器 `bim-nginx-1.30` |
| 网关配置 | `/root/bim-engine/script/http.nginx.1.30.1.prod.conf` |
| Web 静态目录 | 宿主机 `/root/bim-engine/web/html`，容器 `/usr/share/nginx/html` |
| 版本目录 / 当前版本 | `.happy-releases/<run-id>` / 相对符号链接 `happy` |
| 构建入口 | `Dockerfile.webapp` 的 `builder` 阶段，内含 pnpm `10.11.0` |
| 发布源码 | 干净的个人 `main`，等于当次 fetch 后的 `fork/main` |

现有 Nginx 直接提供静态文件；本方案不使用此前候选的 `99.55:8194`。
Relay 的密钥、数据卷和 `/home-relay` 配置不在这些命令的修改范围内。
检查时 Relay 的账号策略仍为允许所有账号；若目标是仅个人使用，需在发布前另外
落实已有账号白名单，不能将目前的配置描述为已完成私人访问限制。

### 0. 源码适配与发布前提

以下子路径适配已写入源码；未设置 `HAPPY_WEB_BASE_PATH` 时继续使用站点根路径。
每次发布都必须从已提交、干净且等于当次 `fork/main` 的个人 `main` 执行，
通过后续预检。本次已发布版本的来源见下面的公网发布记录。

实现复用 Expo 55 的 `experiments.baseUrl` 和 Babel 的 `EXPO_BASE_URL` 编译常量。
下面记录配置位置与行为；浏览器业务验收另见第 5 节。

在 `packages/happy-app/app.config.js` 的 `expo.experiments` 中保留原配置并增加：

```js
baseUrl: process.env.HAPPY_WEB_BASE_PATH || '',
```

在 `Dockerfile.webapp` 的 `builder` 阶段、执行导出之前增加：

```dockerfile
ARG HAPPY_WEB_BASE_PATH=""
ENV HAPPY_WEB_BASE_PATH=$HAPPY_WEB_BASE_PATH
```

在 `packages/happy-app/sources/utils/loadSkia.web.ts` 中指定 WASM 的绝对加载路径。
Expo 的 Babel preset 会把 `process.env.EXPO_BASE_URL` 替换为上述 `baseUrl`：

```ts
import { LoadSkia } from '@shopify/react-native-skia/lib/module/web';

export async function loadSkia() {
    const basePath = process.env.EXPO_BASE_URL || '';
    await LoadSkia({ locateFile: (file) => `${basePath}/${file}` });
}
```

`sources/utils/web/faviconGenerator.ts` 切换普通 / 提醒图标时也使用
`process.env.EXPO_BASE_URL` 前缀。浏览器验收发现原实现会把 HTML 中正确的图标地址
覆盖为根路径 `/favicon.ico`；现已修复为 `/happy/favicon.ico` 和
`/happy/favicon-active.ico`，默认根路径行为保留。

2026-10-24 本地验证记录（开发工作区，未发布）：

- 默认根路径与 `/happy` 的 2 项 Expo 编译回归测试通过，覆盖 WASM 和两种 favicon；
  现有 Relay 地址配置的 7 项测试通过。
- 消息解析与命令清单的 35 项相关测试通过；新增回归用例在修复前有 8 项失败，
  修复后通过，覆盖路径文本、已知命令、元数据前导斜杠和 SDK 命令回显。
- App 类型检查通过：`pnpm exec tsc --noEmit --incremental false`。
- 设置 `HAPPY_WEB_BASE_PATH=/happy` 和上述 Relay 地址，执行生产模式的
  `expo export --platform web` 成功，输出到临时目录。
- 产物检查确认入口 HTML 的 6 个资源引用均带 `/happy/` 且文件存在；46 个 JS 包中
  提取出的 572 个字体及图片等资源 URL 均带 `/happy/assets/` 且文件存在；
  `canvaskit.wasm` 文件头正确，打包后的 Relay 地址与上述目标一致。
- 导出出现 `@noble/hashes/crypto.js` 未声明于包 `exports` 的警告，Metro 使用文件路径
  回退后导出成功。本次未修改该依赖。
- 本地验证使用已有依赖，尚未执行 Docker 构建或公网网关接入。

#### 本地浏览器验收

使用生产导出、真实 Playwright Chromium、临时 PGlite Relay 和当前 CLI 的 API 客户端。
本地 Node 网关仅监听 `127.0.0.1`，模拟 `/happy/` 静态路由与 `/home-relay/`
HTTP / WebSocket 代理；账号、密钥和会话均为临时测试数据，外部请求被拦截。
验证完成后关闭浏览器及本地服务并删除临时数据库，没有连接或修改公网 Relay。

首次验收记录仍保留在 `.e2e-artifacts/web-subpath-2026-10-24T12-25-22-514Z/`。
当时 8 项通过，但普通消息 `Browser message through /happy and /home-relay`
被识别为斜杠命令并隐藏，因此报告为 FAILED。

根因是原始文本仅按 `/单词` 的形状识别命令，没有核对会话命令清单。现已复用
`suggestionCommands.getAllCommands(sessionId)`：只有内置命令、会话 `slashCommands`
或 `skills` 中的名称才作为原始命令处理，其余文本保留。命令名称支持元数据中的
前导 `/`；已知命令仍可位于句首、句中或句尾。SDK 明确标注的 `<command-name>`
回显优先解析，不受原始文本命令清单限制，也不会被参数中的其他命令词覆盖。

修复后复验记录：`.e2e-artifacts/web-subpath-2026-10-24T12-56-06-523Z/`，
包含 `report.json`、关键截图和服务日志。**结果为 PASS_WITH_WARNINGS，退出码为 0，
10 项检查通过，失败项为 0。**

原有 8 项继续通过：已登录桌面页面及带前缀 Socket.IO 连接、设置页导航和刷新、
Web / CLI 加密消息收发及会话刷新、浏览器附件 API 上传下载和二进制字节校验、
字体 / 图片加载及 WASM 编译、普通 / 提醒 favicon 切换、移动端宽度与布局、
浏览器错误及网络路径检查。未出现 Page Error、Console Error、非预期 HTTP 4xx/5xx
或外部请求。

另有 2 项回归检查通过：含 `/happy` 和 `/home-relay` 的普通消息发送后立即可见，
刷新后仍保留；内置 `/compact`、元数据命令 `/maintain` 和技能 `/fixture-skill`
使用模拟 SDK 回显验证，刷新后均显示命令标记及参数，没有重复的原始回显。

补充本地验收记录：`.e2e-artifacts/web-subpath-2026-10-24T15-36-31-691Z/`。
复用同一生产导出，仅扩展验收脚本和文档；**16 项检查通过，失败项为 0，退出码为 0，
状态为 PASS_WITH_WARNINGS**。新增 6 项检查覆盖：

- 通过真实文件选择器选图、展示预览、移除预览；移除不会发送附件事件。
- 重新选图并发送，CLI 收到文件和文字，下载解密后的图片字节与原图一致；
  刷新会话后浏览器重新下载、解密并显示图片。
- 浏览器强制断网并关闭现有 WebSocket，手机尺寸的首页显示 `disconnected`；
  CLI 保持连接，离线期间的回复继续写入临时 Relay。
- 恢复网络后自动重连并补回该回复，页面不刷新、不退出登录、URL 不变；
  下一条消息只被 CLI 接收一次。
- 无登录凭据的新浏览器从登录按钮进入 `/happy/restore`，对页面实际渲染的二维码
  截图做像素解码，确认其包含有效的账号关联请求。
- 模拟原生手机的授权请求，验证 Web 端轮询、解密和账号恢复；刷新后登录保留，
  恢复的账号可以打开原会话并与 CLI 收发加密消息。没有向该浏览器注入登录凭据。

其他警告保留在报告中：布局注册了不存在的 `dev/masked-progress` 路由；
页面导航 / 刷新取消在途请求时出现 `Failed to fetch` warning，事件时间线确认与
`net::ERR_ABORTED` 同时发生；临时 Relay 收到 SIGTERM 后，超时任务可能在 PGlite
关闭后查询数据库，产生 `Response from the Engine was empty`。该错误发生在测试清理
阶段，运行阶段的服务日志未检出错误。测试代理依赖另有 `util._extend` 弃用警告。
补充验收中曾出现关闭服务超过 10 秒的情况（`15-26-37-718Z` 记录），当次已强制
终止并确认无残留进程；最新一轮未触发该超时，但数据库关闭错误仍存在。
脚本现在会等待并确认强制终止后的退出，无法确认时将验收标为 FAILED。

在已安装依赖与 Playwright Chromium 的仓库根目录复跑（可复用同一源码的已有导出，
仅修改验收脚本时无需重新导出）：

```bash
WEB_E2E_EXPORT=$(mktemp -d /tmp/happy-web-e2e.XXXXXX)
(
  cd packages/happy-app
  HAPPY_WEB_BASE_PATH=/happy APP_ENV=production NODE_ENV=production \
    EXPO_PUBLIC_HAPPY_SERVER_URL=https://szsp.suitbim.com.cn:7100/home-relay \
    pnpm exec expo export --platform web --output-dir "$WEB_E2E_EXPORT"
)
HAPPY_SUBPATH_EXPORT_DIR="$WEB_E2E_EXPORT" \
  pnpm exec node packages/happy-app/scripts/web-subpath.e2e.mjs
```

上面最后一条命令执行基础 10 项。要执行补充后的 16 项，用下面的命令代替它，
复用同一 `WEB_E2E_EXPORT`。二维码像素解码使用开源 jsQR `1.4.0`，仅安装到临时目录，
没有修改项目依赖或 lockfile；浏览器验收期间仍禁止访问外部服务。

```bash
WEB_QR_DECODER_DIR=$(mktemp -d /tmp/happy-web-e2e-qr-decoder.XXXXXX)
npm install --prefix "$WEB_QR_DECODER_DIR" --no-package-lock --ignore-scripts \
  --no-audit --no-fund jsqr@1.4.0
HAPPY_SUBPATH_EXTENDED=1 \
  HAPPY_QR_DECODER_MODULE="$WEB_QR_DECODER_DIR/node_modules/jsqr" \
  HAPPY_SUBPATH_EXPORT_DIR="$WEB_E2E_EXPORT" \
  pnpm exec node packages/happy-app/scripts/web-subpath.e2e.mjs
```

扫码授权端为协议模拟，未验证真实手机摄像头、原生 App 内的扫码与确认操作；
手机尺寸页面仍为 Chromium 窗口模拟。以上为本地验收边界，公网验收记录如下。

#### 2026-10-25 首次公网发布

- 公网入口：<https://szsp.suitbim.com.cn:7100/happy/>。
- 发布来源：`6ad793da0bc6231b42c4c386f7f075dc06288908`，构建前及上传前均 fetch
  `fork/main`，确认发布 clone 为干净的个人 `main` 且 HEAD 与远端一致。
- 版本标识：`20261025T004606Z-6ad793da0bc6`；实际激活时间为
  `2026-10-25T00:56:09Z`（新加坡时间 08:56）。
- 静态包 SHA-256：`cef352817fba38dbf7d2110fc10e8c8ce73aca01cf6aeb8a3cf7697d8dab729e`。
- 当前相对链接：`/root/bim-engine/web/html/happy` →
  `.happy-releases/20261025T004606Z-6ad793da0bc6`。
- 配置备份：`/root/bim-engine/script/http.nginx.1.30.1.prod.conf.bak.happy-20261025T004606Z-6ad793da0bc6`。
  静态包、来源 SHA、空的 `previous-target`（首次发布）与部署元数据保留在
  `/root/bim-engine/script/happy-web-artifacts/`。回滚本次发布时，第 6 节的
  `WEB_RUN_ID` 应设为上述版本标识；未在运行中的公网入口执行回滚演练。
- 验收产物：`.e2e-artifacts/web-release-20261025T004606Z-6ad793da0bc6/`，
  包含构建日志、`public-http-report.json`、`public-browser-report.json`、
  `gateway-verification.json` 和关键截图。

完整干净 checkout 的 App 类型检查通过，重新生成 changelog 后与提交版本一致。
曾尝试在只包含 App / wire 的精简 builder 中执行完整类型检查，因缺少测试引用的
CLI 源码和测试依赖而失败；已改为在完整发布 clone 中检查，未忽略类型错误，
也未为此删除测试或放宽 TypeScript 配置。Docker 构建、导出、编译配置及来源 SHA
核验通过；构建保留 `POSTHOG_API_KEY` 使用 ARG 的提示，本次该参数为空。

公网 HTTP **7 项通过**：308 跳转保留查询参数；入口字节与构建包一致且 HTML 使用
`no-cache`；设置、恢复账号和会话路径支持直接访问；入口 JS/CSS 与两个 favicon
的内容和 MIME 正确；WASM 的 MIME、魔数与 SHA-256 正确；缺失的 JS 和图片返回
真实 404；原 Relay `/health` 返回 200。

公网 Chromium **6 项通过，失败 0，状态 PASS_WITH_WARNINGS**：未注入服务端地址或
登录凭据的生产入口正常加载；`/home-relay` 上的 WSS 升级及 Engine.IO 握手成功；
二维码像素解码为有效关联请求，实际编译的 Relay 地址返回 200；直接刷新
`/happy/restore` 可重新加载二维码；手机尺寸页面无横向溢出；未出现 Page Error、
Console Error、非预期 HTTP 4xx/5xx、外部请求或资源路径越出前缀。
唯一浏览器警告仍是已记录的 `dev/masked-progress` 路由不存在。
网关配置去掉本次新增块后与备份逐字一致，挂载文件 inode 保持不变，Nginx 运行正常。

| 公网关键节点 | 截图 |
| --- | --- |
| 实际二维码登录入口 | [查看](https://szsp.suitbim.com.cn:7100/img-bed/images/20a14726-ad18-49a9-b972-23926e64e164.png) |
| 手机尺寸登录页 | [查看](https://szsp.suitbim.com.cn:7100/img-bed/images/1d4c75d6-6337-4093-a33c-1a6f03baf5ec.png) |

本次公网冒烟没有登录真实个人账号；真实手机扫码确认、该账号在公网与 CLI 的
加密消息收发、重连和附件上传下载仍未验证。这些业务流程的现有自动化结果来自
上面的本地临时 Relay 验收；WSS 握手成功不代表已验证登录后的消息收发。

#### 2026-10-30 Web 更新

- 公网入口：<https://szsp.suitbim.com.cn:7100/happy/>。
- 发布来源：`4ffff7a1db67cc33f2504a67ce0e58d98635b249`。独立发布 clone 为干净的
  个人 `main`，准备时及上传前均 fetch 并核对 `fork/main`；包含上一线上提交
  `6ad793da0bc6231b42c4c386f7f075dc06288908`，未吸收上游或发布 OTA / CLI。
- 版本标识：`20261030T061425Z-4ffff7a1db67`；实际激活时间
  `2026-10-30T06:21:41Z`（新加坡时间 14:21）。
- 静态包 SHA-256：`3d6077d2977ba8d123bf42c89d4a0ab620f6d8dff3e913fd13df06b2056c1e09`。
- 当前链接：`/root/bim-engine/web/html/happy` →
  `.happy-releases/20261030T061425Z-4ffff7a1db67`。
- `previous-target` 为 `.happy-releases/20261025T004606Z-6ad793da0bc6`，旧版本目录保留；
  静态包、来源 SHA 与 `.deployment.json` 位于
  `/root/bim-engine/script/happy-web-artifacts/`。按第 6 节回滚时使用本次版本标识。
- 此次只上传静态文件并切换符号链接；现有 Nginx 配置 SHA-256 未变，未重启网关或
  Relay。回滚机制与记录已核对，未在公网执行回滚演练。
- 验收产物：`.e2e-artifacts/web-release-20261030T061425Z-4ffff7a1db67/`，包括
  `checkout-checks.json`、`builder-checks.log`、`public-http-report.json`、
  `public-wss-report.json`、`gateway-verification.json` 和 `publication-report.json`。

本次 App 类型检查通过，changelog 重新生成后与已提交版本一致。13 个相关测试文件、
252 项测试通过。Docker Web 导出成功，已核验 `/happy` 前缀、编译后的 Relay 地址、
来源 SHA、入口资源和 WASM。构建保留既有 `@noble/hashes/crypto.js` exports 回退警告，
以及 `POSTHOG_API_KEY` 使用 ARG 的提示（本次值为空）；网关解包保留系统 tarfile 的
默认安全策略提示，归档成员已逐项检查相对路径与类型，没有解包错误。

公网 HTTP **7 项通过**：308 跳转、入口与导出字节一致及 `no-cache`、深层路由、
JS/CSS 与 favicon、WASM、缺失资源真实 404，以及 Relay 健康检查。
另已验证 `/home-relay/v1/updates/` 的 WSS 升级和 Engine.IO 握手。
**本次状态为部分验证**：按当次授权未启动浏览器，未验证页面运行时错误、真实手机扫码、
登录后的会话收发、附件或重连；HTTP 和 WSS 握手结果不代表这些业务流程通过。

#### 2026-11-04 Web 更新

- 公网入口：<https://szsp.suitbim.com.cn:7100/happy/>。
- 发布来源：`87e16bb659ec4b6361f1de93fe6fb47f0fd25d26`。独立发布 clone 为干净的
  个人 `main`，准备时及上传前均 fetch 并核对 `fork/main`；包含上一线上树
  `d8758551bf3b` 的全部文件（无删除项），并加入 Dots、自动化 UI 与 hosted Dot 状态修复。
- 版本标识：`20261104T104633Z-87e16bb659ec`；实际激活时间
  `2026-11-04T10:51:25Z`（新加坡时间 18:51）。
- 静态包 SHA-256：`df03f2ddcc03799f31c570f704655f771b1321b87c0accc0a503a6f4ac6465ac`。
- 当前链接：`/root/bim-engine/web/html/happy` →
  `.happy-releases/20261104T104633Z-87e16bb659ec`。
- `previous-target` 为 `.happy-releases/directory-selection-d8758551bf3b`；该旧版本
  没有标准 source-sha 记录，发布前按 `20261104T093203Z-directory-selection.activation.json`
  核对线上 index SHA 为 `1ab2eb70d500998219ba00e648a13206e9c079e69038df3f462c0303933023fd`，
  并确认其源码树相对 HEAD 无删除文件。
- 本次只上传静态文件并切换符号链接；Nginx 配置 SHA-256、inode 与容器 ID 均未变，
  未重启网关。Relay 另行升级，见上文。
- 验收产物：`.e2e-artifacts/web-release-20261104T104633Z-87e16bb659ec/`，7 项公网 HTTP
  检查和 `/home-relay/v1/updates/` 的 WSS/Engine.IO 握手通过。
- 构建使用 `Dockerfile.webapp` 的 `builder` 阶段；为遵守阿里云镜像规则，构建时用
  临时 Dockerfile 增加 `ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com`，
  其余步骤与仓库 Dockerfile 相同。App 类型检查、changelog 一致性、导出配置与
  来源 SHA 核对通过。
- **本次状态为部分验证**：未启动浏览器，未验证页面运行时错误、真实手机扫码、登录后
  会话收发、附件或重连；HTTP 与 WSS 握手不代表这些业务流程通过。

#### 2026-11-05 Dot REST连接与显式授权管理

已部署Web源码提交 `1449b17777c65b6d4949de1ab873816e9798d5ec`（`fork/main`）及TestLoop宿主提交 `383e64dc6704f569d1ced9f87b188827f70b2118`（既有 `feat/lightweight-happy-loop` 分支）。来源均已提交推送；Web从干净main clone构建，发布前再次fetch核对。两端类型检查、135项后端、28项前端及7个本地隔离浏览器检查通过；本次不包含手机OTA或原生构建。

Web当前目标为`.happy-releases/20261105T012838Z-dots-rest-1449b17777c6`，前一目标`.happy-releases/20261105T011915Z-21c3dbf6aa9e`保留。静态包SHA-256为`3e70e0a958286f0c6d4e758951ad503aa6476ac467bb8b667b3db792e2b69a14`，切换时合并保留45个旧hashed资源，未重启Nginx、Relay或Happy daemon。来源、包及previous-target记录仍位于既有`happy-web-artifacts`目录。

入口为「设置 → 个人助理 → Dots连接与授权」及工作台「连接与授权」；每个Dot在「可用连接与项目」单独选择范围，新Dot默认无REST能力。服务令牌走工作台加密RPC，不进入聊天。宿主已在源码外的固定release目录运行，完成冷备及验证，保留原任务、历史、额度、记忆和旧环境变量授权；没有生成真实新令牌或派发私人验收任务。

公网HTTP回读核对index、三个引用JS及功能分包的实际字节、Dots/设置深层路由、WASM magic、真实缺失JS的404；Relay health及控制API compatibility均200。真实账号仅执行一次加密管理RPC的只读列表查询，连接及旧绑定可读；未做线上已登录浏览器、真实worker新任务或真机验收。宿主整体health保留此前已有的`assistant_conversation_needs_attention`及`assistant_happy_push_needs_attention`，无新增扫描或连接错误；不将其表述为全系统healthy。

本机证据位于TestLoop的`.e2e-artifacts/dots-connections-20261105/20261105T012838Z-dots-rest/`。第一次离线Docker构建因无法访问npmmirror失败，恢复正常联网且仍限定阿里源后构建通过；首次回读的SSH warning/多分包解析及误用公开readyz路径已修正并保留记录，未重复发布。实际builder image为`sha256:75c12dd5b512bf291a5c277320c8a775d3d577634d632ba34423aabcbaaffe46`。

### 1. 开发机：准备独立发布目录

先执行 `bash` 进入 Bash；以下开发机代码块在**同一个 Bash 会话**依次执行，保留变量。
开发机需要 Git、SSH、Docker、Python 3 和 `sha256sum`；Docker daemon 必须可用。
本机原工作区可能包含其他任务的暂存修改，发布源使用新的独立 clone。

```bash
set -euo pipefail

WEB_ORIGIN='https://szsp.suitbim.com.cn:7100'
WEB_RELAY_URL="$WEB_ORIGIN/home-relay"
WEB_RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)
WEB_RELEASE_DIR="/tmp/happy-web-release-$WEB_RUN_ID"

git clone --origin fork --branch main --single-branch \
  git@github.com:prophetw/happy.git "$WEB_RELEASE_DIR"
cd "$WEB_RELEASE_DIR"
git remote -v
git fetch fork main
test "$(git branch --show-current)" = main
test "$(git rev-parse HEAD)" = "$(git rev-parse fork/main)"
test -z "$(git status --porcelain=v1 -uall)"

# 适配尚未合入时，在这里停止，不继续构建。
rg -q '^ARG HAPPY_WEB_BASE_PATH=' Dockerfile.webapp

WEB_SHA=$(git rev-parse HEAD)
WEB_RUN_ID="$WEB_RUN_ID-${WEB_SHA:0:12}"
WEB_BUILD_IMAGE="happy-web-builder:$WEB_RUN_ID"
WEB_BUILD_ARGS=(
  --platform linux/amd64
  -f Dockerfile.webapp
  --build-arg HAPPY_WEB_BASE_PATH=/happy
  --build-arg "HAPPY_SERVER_URL=$WEB_RELAY_URL"
  --build-arg "HAPPY_BUILD_COMMIT_SHA=$WEB_SHA"
  --build-arg "HAPPY_BUILD_COMMIT_TIMESTAMP=$(git show -s --format=%cI HEAD)"
)
printf 'Web: %s/happy/\nRelay: %s\nSource: %s\n' \
  "$WEB_ORIGIN" "$WEB_RELAY_URL" "$WEB_SHA"
```

### 2. 开发机：构建一次、验证并导出静态包

builder 会安装依赖、构建 `happy-wire` 并执行 `expo export --platform web`。
该精简镜像只包含 App 和 wire，不包含 App 测试引用的 CLI 源码及完整测试依赖，
因此完整 App 类型检查与 changelog 一致性必须在发布 clone 中执行。
可设置 `WEB_DEPENDENCIES_FROM=/home/dev/code/happy` 复用已验证且依赖清单一致的
本机依赖；未设置时在发布 clone 安装依赖。任意检查失败立即停止，不上传或修改网关。

```bash
if [ -n "${WEB_DEPENDENCIES_FROM:-}" ]; then
  python3 - "$WEB_DEPENDENCIES_FROM" "$WEB_RELEASE_DIR" <<'PY'
import pathlib, sys
source, release = map(pathlib.Path, sys.argv[1:])
manifests = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']
manifests += [str(p.relative_to(release)) for p in (release / 'packages').glob('*/package.json')]
for relative in manifests:
    if (source / relative).read_bytes() != (release / relative).read_bytes():
        raise SystemExit('STOP: dependency manifest differs: ' + relative)
directories = [release] + [p for p in (release / 'packages').iterdir() if (p / 'package.json').is_file()]
for directory in directories:
    installed = source / directory.relative_to(release) / 'node_modules'
    link = directory / 'node_modules'
    if installed.is_dir():
        if link.exists() or link.is_symlink():
            raise SystemExit('STOP: inspect existing node_modules: ' + str(link))
        # 保留真实 node_modules 目录，使仓库的 node_modules/ 忽略规则仍然生效。
        link.mkdir()
        for dependency in installed.iterdir():
            (link / dependency.name).symlink_to(dependency, target_is_directory=dependency.is_dir())
PY
else
  pnpm install --frozen-lockfile
fi
pnpm --filter @slopus/happy-wire run build
(
  cd packages/happy-app
  pnpm exec tsc --noEmit --incremental false
  WEB_CHANGELOG_BEFORE=$(sha256sum sources/changelog/changelog.json)
  pnpm exec tsx sources/scripts/parseChangelog.ts
  test "$WEB_CHANGELOG_BEFORE" = "$(sha256sum sources/changelog/changelog.json)"
)
test -z "$(git status --porcelain=v1 -uall)"

docker build "${WEB_BUILD_ARGS[@]}" --target builder \
  --label "org.opencontainers.image.revision=$WEB_SHA" \
  -t "$WEB_BUILD_IMAGE" .

docker run --rm -i --entrypoint sh \
  -e "EXPECTED_WEB_SHA=$WEB_SHA" \
  -e "EXPECTED_WEB_RELAY=$WEB_RELAY_URL" \
  "$WEB_BUILD_IMAGE" -es <<'SH'
cd /repo/packages/happy-app
pnpm exec expo config --type public --json > /tmp/happy-web-config.json
node <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync('/tmp/happy-web-config.json', 'utf8'));
assert.equal(config.experiments.baseUrl, '/happy');
assert.equal(config.extra.app.buildCommitSha, process.env.EXPECTED_WEB_SHA);
assert.equal(process.env.EXPO_PUBLIC_HAPPY_SERVER_URL, process.env.EXPECTED_WEB_RELAY);
const html = fs.readFileSync('dist/index.html', 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(x => x[1]);
assert(scripts.some(x => x.startsWith('/happy/_expo/')), 'Missing prefixed entry bundle');
assert(!scripts.some(x => x.startsWith('/_expo/')), 'Unprefixed entry bundle');
assert(fs.statSync('dist/canvaskit.wasm').isFile());
console.log({ baseUrl: config.experiments.baseUrl, source: config.extra.app.buildCommitSha });
JS
SH

test -z "$(git status --porcelain=v1 -uall)"
WEB_EXPORT_DIR=$(mktemp -d /tmp/happy-web-export.XXXXXX)
WEB_EXPORT_CONTAINER=$(docker create "$WEB_BUILD_IMAGE")
docker cp "$WEB_EXPORT_CONTAINER:/repo/packages/happy-app/dist/." "$WEB_EXPORT_DIR/"
docker rm "$WEB_EXPORT_CONTAINER"
WEB_ARCHIVE="/tmp/happy-web-$WEB_RUN_ID.tar.gz"
tar -C "$WEB_EXPORT_DIR" -czf "$WEB_ARCHIVE" .
WEB_ARCHIVE_SHA=$(sha256sum "$WEB_ARCHIVE" | awk '{print $1}')
```

### 3. 开发机 → 网关：上传并切换静态版本

此步开始实际修改服务器文件。后续升级也可重复本步骤；网关路由已正确配置时，
无需重复添加下一节的 `location`。符号链接必须使用相对路径，目标也在同一个
静态目录挂载内，才能从 Nginx 容器访问。

```bash
# 发布前再核对最终源码；构建期间 main 已推进时，停止并重新准备。
git fetch fork main
test "$WEB_SHA" = "$(git rev-parse HEAD)"
test "$WEB_SHA" = "$(git rev-parse fork/main)"
test -z "$(git status --porcelain=v1 -uall)"

# 后续发布核对当前线上版本的来源，防止发布缺失已上线功能的提交。
WEB_PREVIOUS_SHA=$(ssh -o BatchMode=yes root@192.168.99.57 python3 - <<'PY'
import os, pathlib, re
current = pathlib.Path('/root/bim-engine/web/html/happy')
records = pathlib.Path('/root/bim-engine/script/happy-web-artifacts')
if current.is_symlink():
    target = os.readlink(str(current))
    if not re.fullmatch(r'\.happy-releases/[A-Za-z0-9-]+', target):
        raise SystemExit('STOP: inspect the existing happy symlink before deployment.')
    sha = (records / (pathlib.PurePosixPath(target).name + '.source-sha')).read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise SystemExit('STOP: invalid previous release commit.')
    print(sha)
elif current.exists():
    raise SystemExit('STOP: happy already exists and is not a symlink.')
PY
)
if [ -n "$WEB_PREVIOUS_SHA" ]; then
  git merge-base --is-ancestor "$WEB_PREVIOUS_SHA" "$WEB_SHA"
fi

ssh -o BatchMode=yes root@192.168.99.57 \
  'install -d -m 700 /root/bim-engine/script/happy-web-artifacts'
scp -o BatchMode=yes "$WEB_ARCHIVE" \
  "root@192.168.99.57:/root/bim-engine/script/happy-web-artifacts/happy-web-$WEB_RUN_ID.tar.gz"

ssh -o BatchMode=yes root@192.168.99.57 \
  bash -s -- "$WEB_RUN_ID" "$WEB_ARCHIVE_SHA" "$WEB_SHA" <<'SH'
set -euo pipefail
WEB_RUN_ID=$1
WEB_ARCHIVE_SHA=$2
WEB_SHA=$3
WEB_ROOT=/root/bim-engine/web/html
WEB_RECORDS=/root/bim-engine/script/happy-web-artifacts
WEB_RELEASE="$WEB_ROOT/.happy-releases/$WEB_RUN_ID"
cd "$WEB_RECORDS"
printf '%s  %s\n' "$WEB_ARCHIVE_SHA" "happy-web-$WEB_RUN_ID.tar.gz" | sha256sum -c -

if [ -e "$WEB_ROOT/happy" ] && [ ! -L "$WEB_ROOT/happy" ]; then
  printf '%s\n' 'STOP: happy is an existing real file/directory; inspect before deployment.' >&2
  exit 1
fi
test ! -e "$WEB_RELEASE"
install -d -m 755 "$WEB_ROOT/.happy-releases" "$WEB_RELEASE"
tar --no-same-owner -xzf "happy-web-$WEB_RUN_ID.tar.gz" -C "$WEB_RELEASE"
test -s "$WEB_RELEASE/index.html"
test -s "$WEB_RELEASE/canvaskit.wasm"
find "$WEB_RELEASE" -type d -exec chmod 755 {} +
find "$WEB_RELEASE" -type f -exec chmod 644 {} +
printf '%s\n' "$WEB_SHA" > "$WEB_RECORDS/$WEB_RUN_ID.source-sha"

if [ -L "$WEB_ROOT/happy" ]; then
  readlink "$WEB_ROOT/happy" > "$WEB_RECORDS/$WEB_RUN_ID.previous-target"
else
  : > "$WEB_RECORDS/$WEB_RUN_ID.previous-target"
fi
ln -s ".happy-releases/$WEB_RUN_ID" "$WEB_ROOT/.happy-$WEB_RUN_ID"
mv -Tf "$WEB_ROOT/.happy-$WEB_RUN_ID" "$WEB_ROOT/happy"
readlink "$WEB_ROOT/happy"
SH
```

### 4. 首次部署：准备候选 Nginx 配置、检查并热重载

只在现有 `7100 ssl` 的 `server` 中、紧邻 `/home-relay` 添加 `/happy` 路由。
脚本要求该锚点唯一，已有 `/happy` 配置时会停止；不要反复插入。
JS/CSS 所在的 `/_expo/`、`/assets/` 和 WASM 缺失时返回真实 404；前端页面路由
回退到 `/happy/index.html`。入口 HTML 要求浏览器重新验证缓存。

宿主机配置文件直接挂载进容器，写回时保留 inode；不能通过原子重命名替换它。
先将候选文件复制到容器的同一配置目录并检查，再写入实际文件。
现有配置包含相对路径 `include mime.types`，候选文件必须也放在 `/etc/nginx/`，
放到 `/tmp/` 会改变相对 include 的解析位置。

```bash
ssh -o BatchMode=yes root@192.168.99.57 bash -s -- "$WEB_RUN_ID" <<'SH'
set -euo pipefail
umask 077
WEB_RUN_ID=$1
WEB_CFG=/root/bim-engine/script/http.nginx.1.30.1.prod.conf
WEB_BACKUP="$WEB_CFG.bak.happy-$WEB_RUN_ID"
WEB_CANDIDATE="$WEB_CFG.candidate.happy-$WEB_RUN_ID"
test ! -e "$WEB_BACKUP"
cp -p "$WEB_CFG" "$WEB_BACKUP"
chmod 600 "$WEB_BACKUP"

python3 - "$WEB_BACKUP" "$WEB_CANDIDATE" <<'PY'
import pathlib, re, sys
source, candidate = map(pathlib.Path, sys.argv[1:])
text = source.read_text()
if re.search(r'location[^\n{]*/happy', text):
    raise SystemExit('STOP: /happy already has a location; inspect instead of inserting again.')
anchors = list(re.finditer(r'^([ \t]*)location = /home-relay \{', text, re.M))
if len(anchors) != 1:
    raise SystemExit('STOP: expected one existing /home-relay anchor in the HTTPS server.')
anchor = anchors[0]
block = r'''# BEGIN HAPPY WEB /happy/
location = /happy {
    absolute_redirect off;
    return 308 /happy/$is_args$args;
}
location = /happy/index.html {
    root /usr/share/nginx/html;
    add_header Cache-Control "no-cache" always;
    try_files $uri =404;
}
location ^~ /happy/_expo/ {
    root /usr/share/nginx/html;
    try_files $uri =404;
}
location ^~ /happy/assets/ {
    root /usr/share/nginx/html;
    try_files $uri =404;
}
location = /happy/canvaskit.wasm {
    root /usr/share/nginx/html;
    types { application/wasm wasm; }
    try_files $uri =404;
}
location ^~ /happy/ {
    root /usr/share/nginx/html;
    index index.html;
    try_files $uri $uri/ /happy/index.html;
}
# END HAPPY WEB /happy/'''
block = '\n'.join(anchor.group(1) + line for line in block.splitlines()) + '\n\n'
candidate.write_text(text[:anchor.start()] + block + text[anchor.start():])
PY

docker cp "$WEB_CANDIDATE" "bim-nginx-1.30:/etc/nginx/happy-web-$WEB_RUN_ID.conf"
docker exec bim-nginx-1.30 nginx -t -c "/etc/nginx/happy-web-$WEB_RUN_ID.conf"

python3 - "$WEB_CFG" "$WEB_BACKUP" "$WEB_CANDIDATE" <<'PY'
import pathlib, sys
live, backup, candidate = map(pathlib.Path, sys.argv[1:])
if live.read_bytes() != backup.read_bytes():
    raise SystemExit('STOP: gateway config changed concurrently; rebuild the candidate.')
with live.open('wb') as output:
    output.write(candidate.read_bytes())
PY
docker exec bim-nginx-1.30 nginx -t
docker exec bim-nginx-1.30 nginx -s reload
SH
```

任何 Nginx 检查或 reload 失败，停止发布并执行下述回滚；不报告发布成功。

### 5. 开发机：HTTP 验收与浏览器验收边界

```bash
WEB_CHECK_DIR=$(mktemp -d /tmp/happy-web-check.XXXXXX)
test "$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$WEB_ORIGIN/happy")" = 308
curl --fail --silent --show-error --max-time 30 \
  "$WEB_ORIGIN/happy/" -o "$WEB_CHECK_DIR/index.html"
WEB_ENTRY=$(python3 - "$WEB_CHECK_DIR/index.html" <<'PY'
from html.parser import HTMLParser
import pathlib, sys
class Entry(HTMLParser):
    def handle_starttag(self, tag, attrs):
        source = dict(attrs).get('src', '')
        if tag == 'script' and source.startswith('/happy/_expo/'):
            print(source)
            raise SystemExit(0)
Entry().feed(pathlib.Path(sys.argv[1]).read_text())
raise SystemExit('Missing /happy/_expo/ entry bundle')
PY
)
curl --fail --silent --show-error --max-time 60 \
  "$WEB_ORIGIN$WEB_ENTRY" -o "$WEB_CHECK_DIR/entry.js"
curl --fail --silent --show-error --max-time 60 \
  "$WEB_ORIGIN/happy/canvaskit.wasm" -o "$WEB_CHECK_DIR/canvaskit.wasm"
python3 - "$WEB_CHECK_DIR/canvaskit.wasm" <<'PY'
import pathlib, sys
with pathlib.Path(sys.argv[1]).open('rb') as source:
    if source.read(4) != b'\x00asm':
        raise SystemExit('Expected WASM bytes; an HTML fallback is not a valid asset.')
PY
curl --fail --silent --show-error --max-time 30 \
  "$WEB_ORIGIN/happy/settings" -o "$WEB_CHECK_DIR/settings.html"
cmp "$WEB_CHECK_DIR/index.html" "$WEB_CHECK_DIR/settings.html"
test "$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
  "$WEB_ORIGIN/happy/_expo/missing-$WEB_RUN_ID.js")" = 404
curl --fail --silent --show-error --max-time 15 "$WEB_RELAY_URL/health"
```

这些命令仅证明静态资源和 SPA 回退可访问，不能代替登录与业务验收。
真实浏览器验证须按用户当次授权执行；本地及首次公网冒烟结果见第 0 节。
正式验收还需确认：手机扫码关联同一账号、Web 与 CLI 的会话收发、实时连接与重连、
附件上传下载、已登录后的页面刷新和直接访问会话 URL，以及 Console Error、Toast
和非预期 4xx/5xx。严重错误未解释前不得报告 PASS。

### 6. 回滚

**Web 版本回滚**：同一开发机 Bash 中执行。每次发布的 `previous-target` 记录上一个
相对链接。命令要求当前仍是本次发布，避免误撤销别人后来发布的版本；版本目录与
备份全部保留。首次发布没有上一版时删除的仅是 `happy` 符号链接。

```bash
ssh -o BatchMode=yes root@192.168.99.57 bash -s -- "$WEB_RUN_ID" <<'SH'
set -euo pipefail
WEB_RUN_ID=$1
WEB_ROOT=/root/bim-engine/web/html
WEB_RECORDS=/root/bim-engine/script/happy-web-artifacts
test "$(readlink "$WEB_ROOT/happy")" = ".happy-releases/$WEB_RUN_ID"
WEB_PREVIOUS=$(cat "$WEB_RECORDS/$WEB_RUN_ID.previous-target")
if [ -n "$WEB_PREVIOUS" ]; then
  test -d "$WEB_ROOT/$WEB_PREVIOUS"
  ln -s "$WEB_PREVIOUS" "$WEB_ROOT/.happy-rollback-$WEB_RUN_ID"
  mv -Tf "$WEB_ROOT/.happy-rollback-$WEB_RUN_ID" "$WEB_ROOT/happy"
else
  rm -- "$WEB_ROOT/happy"
fi
SH
```

**撤销首次添加的网关路由**：仅在第 4 步实际修改过配置时执行。配置后来被其他任务
修改时停止整份回滚；此时应只撤销 `BEGIN/END HAPPY WEB` 之间的本次路由块，
重新生成候选文件并检查，不能覆盖其他服务的后续修改。

```bash
ssh -o BatchMode=yes root@192.168.99.57 bash -s -- "$WEB_RUN_ID" <<'SH'
set -euo pipefail
WEB_RUN_ID=$1
WEB_CFG=/root/bim-engine/script/http.nginx.1.30.1.prod.conf
python3 - "$WEB_CFG" "$WEB_CFG.bak.happy-$WEB_RUN_ID" \
  "$WEB_CFG.candidate.happy-$WEB_RUN_ID" <<'PY'
import pathlib, sys
live, backup, candidate = map(pathlib.Path, sys.argv[1:])
current = live.read_bytes()
if current not in (backup.read_bytes(), candidate.read_bytes()):
    raise SystemExit('STOP: gateway changed after this release; remove only the HAPPY WEB block.')
with live.open('wb') as output:
    output.write(backup.read_bytes())
PY
docker exec bim-nginx-1.30 nginx -t
docker exec bim-nginx-1.30 nginx -s reload
SH
```

回滚后重新检查已恢复版本及 `/home-relay/health`。首次发布撤销后，Web 入口应恢复
到发布前的 404。不能以 HTTP 检查代替会话和附件的实际回归验收。

## Kubernetes manifests
Example manifests live in `packages/happy-server/deploy`:
- `handy.yaml`: Deployment + Service + ExternalSecrets for the server.
- `happy-redis.yaml`: Redis StatefulSet + Service + ConfigMap.

The deployment config expects:
- Prometheus scraping annotations on port `9090`.
- A secret named `handy-secrets` populated by ExternalSecrets.
- A service mapping port `3000` to container port `3005`.

## Production deployment order

The `Lab_HappyServer` TeamCity build runs Build, Push, and its private Deploy
recipe in order. The recipe runs `prisma migrate deploy` in a one-off
Kubernetes Job using the new image and `handy-secrets`, then applies
`handy.yaml` and waits for the rollout. A failed migration exits before apply.

GitHub CI continues to apply migrations to its disposable Postgres database.
Production migrations run before the rolling update, so they must remain
compatible with the currently running release; destructive changes require an
expand/contract deployment.

## Local dev helpers
The server package includes scripts for local infrastructure:
- `pnpm --filter happy-server db` (Postgres in Docker)
- `pnpm --filter happy-server redis`
- `pnpm --filter happy-server s3` + `s3:init`

Use `.env`/`.env.dev` to load local settings when running `pnpm --filter happy-server dev`.

## Implementation references
- Entrypoint: `packages/happy-server/sources/main.ts`
- Dockerfile: `Dockerfile.server`
- Kubernetes manifests: `packages/happy-server/deploy`
- Env usage: `packages/happy-server/sources` (`rg -n "process.env"`)

### 连接管理与授权更换

连接管理分为「我的连接」和「Dot 授权」。新令牌先只读验证，预览项目和到期日，再保存；可在 Dot 详情通过「更新服务令牌」同时保存新连接和项目选择，或通过「更换连接」使用已有连接。主列表展示项目名称，机器/授权ID与操作码放在连接详情，不可用连接折叠显示。

此版本需同步升级 TestLoop 的 `testloop-rest-connections` RPC，支持 `preview`、带项目分配的 `add` 和原子 `replace`；前端按宿主能力标记开放新流程。更换只影响明确选择的 Dot 后续派工，不重写旧任务或会话授权。保存前重新核验授权范围；范围变化、过期写入或验证失败时保持原绑定。公网部署仍按上述干净源码与冷备流程执行；手机未执行 OTA 时不视为同步更新。

2026-11-05本轮已发布：Happy源码`51f471bf5227aa200695a80ab5d27ffc28cad652`，TestLoop宿主`8e7903e28a1b859977ceb8c2c4c2b3ee9647cea5`。Web目标`.happy-releases/20261105T024407Z-dots-auth-51f471bf5227`，保留前一版本和46个旧hashed资源，Nginx/Relay未重启。新宿主从固定release目录运行，先验证冷备，原任务/历史/额度保留。

两端类型检查、64项相关后端测试、30项前端测试和8个本地隔离浏览器检查通过；公网静态资源、深层路由、WASM、Relay健康及控制API共11项回读通过。首次回读因归档恢复版本根目录为0700而返回403，已将本版本目录/子目录修正为0755、文件0644并重查；初始失败证据保留，后续激活脚本显式处理根目录权限。证据位于TestLoop本机忽略目录`.e2e-artifacts/dots-connections-20261105/20261105T024407Z-dots-auth/`。

本人指定的「多项目代码助手」已通过实际加密RPC换用新授权全部5项目，凭据为后台密文并可解密使用；换绑回读不创建真实任务或模型调用。历史两项宿主attention告警保留。真实线上登录页面/新派工与原生手机未验收，手机OTA未发布。


### 2026-11-05 动态模型目录发布

源码 `964a5c7e76ba75ba3088de57bb951590c53671d1` 已推送个人 fork。99.55 REST 镜像 `sha256:40847b97f7e798a2e8747439d190987d1079cc77d501e42b167abaa1ae292fcb` 已上线，OpenAPI 1.8.0 回读及匿名访问拒绝通过；宿主仅将该机器的模型策略改为 Claude/Codex/Agy 的 `modelSource: "machine"`，不保存固定型号，原权限模式和状态目录保留。控制服务/网关成对更新，Relay 容器未变且健康。

99.57 已存在同源码、同字节产物 `.happy-releases/20261105T064816Z-964a5c7e76ba`；重复发布的基线保护触发后保留该目标。入口、全部入口 JS、WASM、settings SPA 回退、缺失 JS 404 及 Relay health HTTP 核验通过，未改 Nginx/Relay。此结果不代表浏览器登录和真实业务链路验收。

本机 worker 旧版本仍在运行；新固定运行目录 `/home/dev/.local/share/happy-automation/releases/dynamic-models-964a5c7e` 和 root 维护脚本 `/home/dev/.local/share/happy-automation/maintenance/dynamic-models-964a5c7e/activate.py` 已准备。`--check`、69 项产物哈希及仅动态模型策略变化的配置检查通过。此环境受 no-new-privileges 限制，不能代操作方切换 systemd 服务；完整线上三组模型目录待维护后回读，不宣称已完成。脚本沿用独立 systemd 维护单元及已有会话身份保护，保留原配置/服务回滚材料。

验证：REST/网关/适配器 46 项，CLI 动态目录/发布元数据 43 项，App 选择器 49 项，维护控制器 16 项；Agent/CLI 构建、CLI/App 类型检查通过。精确待发镜像的原生 Nginx/TLS/mTLS 容器夹具 76 项通过，测试资源清理为零遗留。第一次直接以 node 启动 TypeScript 夹具出现模块解析失败，按仓库使用 tsx 后上述完整检查通过。未运行浏览器、原生包/OTA 或真实模型任务。实际只读目录预览来自已登记 machine 元数据及本机 `agy models`，不是固定配置清单。

TestLoop 已发布 `4c1ae0bbe94b8df82229fab074e74170c805a264`，原任务/历史/额度/授权与加密 RPC 校验通过；原有两个 attention 健康告警仍在。发布与检查证据位于 TestLoop `.e2e-artifacts/20261105T064221Z-dynamic-catalog/`，REST 回滚材料位于 99.55 `/data/code/happy-control/rollouts/dynamic-models-964a5c7e/`。
