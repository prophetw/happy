# 自定义 Relay URL 可行性调研

调研日期：2026-10-09。源码基线：`feed9fb7`。目标示例：`https://xxx.xxx.com:8193/relay`。本次只新增调研文档，没有修改业务代码或部署服务。

## 结论

**可行，建议在现有实现上改造客户端的服务地址处理，继续复用服务端协议和反向代理。** 当前 `api.cluster-fluster.com` 是默认配置，不是只能使用该域名。域名、端口已有配置入口；缺少完整支持的是 `/relay` 这样的路径前缀。[App 配置](../../packages/happy-app/sources/sync/serverConfig.ts#L9)、[CLI 配置](../../packages/happy-cli/src/configuration.ts#L53)、[happy-agent 配置](../../packages/happy-agent/src/config.ts#L10)。

这里的 relay 是 Happy 的认证、会话存储及实时同步服务，主要由 Fastify REST API 和 Socket.IO 组成。新版本可以保留现有 `/v1`、`/v3` API、消息格式和加密机制，改造地址解析与挂载方式；不需要为这项需求重写中转协议。[服务端路由](../../packages/happy-server/sources/app/api/api.ts#L101)、[实时服务](../../packages/happy-server/sources/app/api/socket.ts#L19)、[服务端职责](../../packages/happy-server/README.md#L21)。

**只改服务端域名或环境变量，不能让现有客户端完整支持带路径的 URL。** Socket.IO 存在两个独立问题：传输路径固定为 `/v1/updates`；传入 URL 的 pathname 又会被当作 namespace。本地依赖连接实验已复现这两个错误，并验证了修正方式。实际 Happy 认证、会话及真机流程尚未验证。

## 当前支持程度

| 地址或行为 | 当前状态 | 证据与限制 |
| --- | --- | --- |
| `https://example.com` | 已有配置入口 | App 设置、CLI 的环境变量/持久配置、happy-agent 的环境变量 |
| `https://example.com:8193` | URL 和连接层支持端口 | 本地 Socket.IO 非默认端口实验成功；公网端口、证书和网络连通性未验证 |
| `https://example.com:8193/relay` | 配置可接受，但实时连接不能直接工作 | HTTP 多数使用字符串拼接保留前缀；Socket.IO 的 namespace 和 transport path 处理不匹配 |
| `https://example.com:8193/relay/` | 缺少统一规范化 | App/CLI 保留尾斜杠，HTTP 拼接可能形成双斜杠；happy-agent 会去除尾斜杠 |
| `example.com:8193/relay` | App 当前不接受 | 校验要求 HTTP/HTTPS；若新版支持省略协议，需明确补全规则 |
| 设置 `PUBLIC_URL` 即可启用服务端前缀 | 不支持 | 该配置影响返回给客户端的文件 URL，不改变路由挂载 |

配置优先级也不完全一致：App 为持久配置 → Web 注入 → `EXPO_PUBLIC_HAPPY_SERVER_URL` → 默认；CLI 为 `HAPPY_SERVER_URL` → `settings.serverUrl` → 默认；happy-agent 只读 `HAPPY_SERVER_URL` → 默认。[App 读取及校验](../../packages/happy-app/sources/sync/serverConfig.ts#L24)、[CLI 读取](../../packages/happy-cli/src/configuration.ts#L57)、[agent 读取](../../packages/happy-agent/src/config.ts#L10)。

HTTP 现有写法如 `${serverUrl}/v1/auth` 和 `${serverUrl}/v1/sessions`，因此非尾斜杠的 `/relay` 前缀通常可以保留，但上游必须处理该前缀。[App 认证](../../packages/happy-app/sources/auth/authGetToken.ts#L7)、[CLI 认证](../../packages/happy-cli/src/api/auth.ts#L22)、[App 会话](../../packages/happy-app/sources/sync/sync.ts#L1265)。

## Socket.IO 的具体阻碍与实验

以下六个客户端连接点均将完整 server URL 传给 `io()`，同时固定 `path: '/v1/updates'`，需要一起检查和修改：

| 客户端 | 连接点 |
| --- | --- |
| App，包含共用此模块的 Web/桌面前端 | [apiSocket.ts](../../packages/happy-app/sources/sync/apiSocket.ts#L110) |
| CLI 会话 | [apiSession.ts](../../packages/happy-cli/src/api/apiSession.ts#L276) |
| CLI daemon / machine | [apiMachine.ts](../../packages/happy-cli/src/api/apiMachine.ts#L522) |
| happy-agent 创建远程会话 | [machineRpc.ts](../../packages/happy-agent/src/machineRpc.ts#L70) |
| happy-agent 恢复远程会话 | [machineRpc.ts](../../packages/happy-agent/src/machineRpc.ts#L144) |
| happy-agent 会话连接 | [session.ts](../../packages/happy-agent/src/session.ts#L111) |

本地安装的 `socket.io-client/build/cjs/index.js:27-51` 解析 URL 后调用 `io.socket(parsed.path, opts)`，因此 `io('https://host/relay', ...)` 会选择 `/relay` namespace。`engine.io-client/build/cjs/transport.js:126-132` 则用 `opts.path` 生成传输 URL。这两者不能混为同一个路径配置。服务端通过根 `io.use()` 和 `io.on('connection')` 注册现有连接处理。[服务端认证与连接](../../packages/happy-server/sources/app/api/socket.ts#L55)。

实际执行了仅绑定 `127.0.0.1` 的实验：后端 Socket.IO 挂载 `/v1/updates`，本地反向代理剥离 `/relay`；使用当前安装的 Socket.IO server/client `4.8.3`、Engine.IO client `6.6.4` 和 `http-proxy-middleware` `3.0.5`。没有访问公共 relay，没有加载 Happy 数据库或真实凭据。

| 实验 | 实际结果 | 含义 |
| --- | --- | --- |
| 根 URL + 非默认端口 + `/v1/updates` | connected，namespace `/` | 端口本身不是连接限制 |
| URL 带 `/relay`，仍使用 `/v1/updates` | `websocket error` | 请求路径没有包含前缀 |
| URL 带 `/relay`，只把 path 改成 `/relay/v1/updates` | `Invalid namespace` | 传输可达，namespace 仍错误 |
| 使用 origin，path 为 `/relay/v1/updates` | connected，namespace `/` | 修正地址拆分后可连接 |
| 输入 `/relay/`，先去除尾斜杠，再按上一行连接 | connected | 尾斜杠规范化方案成立 |
| HTTP `/relay/v1/probe` 经代理 | 200，上游收到 `/v1/probe` | 同一前缀可用于 REST 转发 |

六个实际结果均符合预期，包括两项故障复现，实验进程退出码为 0。实验另出现 Node `DEP0060: util._extend` 弃用警告，已定位到现有 `http-proxy/lib/http-proxy/common.js:3` 和 `index.js:2`；它没有使上述连接失败。这是依赖层可行性证据，不能等同于 Happy 业务流程 E2E 通过。

## 推荐实现方案

将用户填写的 URL 定义为 **API 基址**。以 `https://xxx.xxx.com:8193/relay` 为例，实际请求如下：

| 用途 | 对外地址 | 代理后的服务端路径 |
| --- | --- | --- |
| 认证 | `https://xxx.xxx.com:8193/relay/v1/auth` | `/v1/auth` |
| 会话 | `https://xxx.xxx.com:8193/relay/v1/sessions` | `/v1/sessions` |
| 消息 | `https://xxx.xxx.com:8193/relay/v3/sessions/:id/messages` | `/v3/sessions/:id/messages` |
| 实时同步 | `wss://xxx.xxx.com:8193/relay/v1/updates/`，附 Engine.IO 查询参数 | `/v1/updates/` |
| 检查服务 | `https://xxx.xxx.com:8193/relay/health` | `/health` |
| 本地公共文件 | `https://xxx.xxx.com:8193/relay/files/...` | `/files/...` |

推荐由成熟反向代理剥离前缀，内部 API 保持现有根路径。实验已经复用了项目现有开源代理依赖，不需要自研代理组件；正式部署可沿用实际环境的网关，并配置 WebSocket Upgrade、超时和上传大小。仓库当前 API 部署 manifest 只有 Deployment/Service，没有完成上述 API 前缀转发。[现有部署配置](../../packages/happy-server/deploy/handy.yaml#L25)。

所有客户端应复用一个轻量的 URL 解析/拼接函数，得到 `baseUrl`、`origin`、`basePath` 和 `socketPath`。可考虑放在已有共享包的独立入口，避免各端复制；当前共享包以 wire types/schema 为主，具体放置位置由实施时确认。[共享包出口](../../packages/happy-wire/src/index.ts)。无需额外 URL 库，现有代码已经使用标准 `URL`。

以下为设计示意，**尚未写入业务代码**：

```ts
const parsed = new URL(input.trim());
// 统一校验 http/https；拒绝 userinfo、query、fragment。
const basePath = parsed.pathname.replace(/\/+$/, '');
const baseUrl = `${parsed.origin}${basePath}`;
const apiUrl = (path: string) => `${baseUrl}/${path.replace(/^\/+/, '')}`;

const socket = io(parsed.origin, {
    path: `${basePath}/v1/updates`,
    // 保留现有 auth、重连及 transports 配置。
});
```

不能直接用 `new URL('/v1/auth', baseUrl)` 拼接，因为以 `/` 开头的相对地址会替换 pathname，丢掉 `/relay`。要明确“相对于 API 基址”的拼接规则。

如果要求**不使用反向代理，服务端直接挂载任意前缀**，也可实现，但需修改 Fastify 的统一路由注册、Socket.IO path、本地文件路由、健康检查和相关探针；如果同时托管 Web，还需调整静态路由及 fallback。当前 `StartApiOptions` 没有 `basePath`，所有 routes 直接注册在根 instance，工作范围更大。[API 参数及注册](../../packages/happy-server/sources/app/api/api.ts#L32)、[固定 Socket.IO path](../../packages/happy-server/sources/app/api/socketConfig.ts#L18)、[健康探针](../../packages/happy-server/deploy/handy.yaml#L46)。

## 第一阶段必要改动

1. **统一解析和规范化。** App、CLI、happy-agent 保持各自配置入口，但按同一规则校验及拼接 URL。支持空前缀、多级前缀和尾斜杠，保留现有默认地址的行为。
2. **修复六处 Socket.IO 连接。** 用 origin 连接根 namespace，按 basePath 生成 transport path；CLI machine 当前还会自行替换 `http` 为 `ws`，需纳入统一处理。[machine 连接](../../packages/happy-cli/src/api/apiMachine.ts#L522)。
3. **替换 App 的首页文本校验。** 当前 GET 输入 URL 并强查 `Welcome to Happy Server!`；托管 Web 的 self-host 根页面却返回 `index.html`。已有 `/health` 返回 `service: 'happy-server'` 和数据库状态，可优先复用它，无须先引入新的发现协议。健康检查也不能代替实际 WebSocket 验证。[App 检查](../../packages/happy-app/sources/app/(app)/server.tsx#L98)、[根页面条件](../../packages/happy-server/sources/app/api/api.ts#L64)、[health 响应](../../packages/happy-server/sources/app/api/utils/enableMonitoring.ts#L37)。
4. **明确切换后的生效方式。** 当前 App 保存只写 MMKV、更新本页状态，没有断开并重建连接；sync 初始化还会被 `isInitialized` 拦截。新版应明确重载/重连路径。如果连接的是另一套独立实例，应重新认证，避免继续使用旧实例凭据；无需因此扩展成多账户系统。[保存逻辑](../../packages/happy-app/sources/app/(app)/server.tsx#L154)、[配置写入](../../packages/happy-app/sources/sync/serverConfig.ts#L45)、[sync 初始化](../../packages/happy-app/sources/sync/sync.ts#L3299)、[凭据存储](../../packages/happy-app/sources/auth/tokenStorage.ts#L4)。
5. **配置文件公网基址。** 本地文件模式设置 `PUBLIC_URL=https://xxx.xxx.com:8193/relay`，不加尾斜杠。附件、会话/项目头像与账户公共文件已能基于它生成 URL；未显式配置时，forwarded host/proto 只能恢复 origin，不能恢复被代理剥离的前缀。[附件 URL](../../packages/happy-server/sources/app/api/routes/attachmentRoutes.ts#L38)、[项目头像](../../packages/happy-server/sources/app/api/routes/projectRoutes.ts#L78)、[会话头像](../../packages/happy-server/sources/app/api/routes/sessionAvatarRoutes.ts#L38)、[公共文件](../../packages/happy-server/sources/storage/files.ts#L42)。
6. **区分监听地址与对外地址。** 若继续用 `happy server` 启动，应增加独立公网地址配置或等效能力；它目前强制用 `http://host:port` 写 CLI 设置并覆盖 Web 注入配置。直接 standalone 已支持通过 `HAPPY_INJECT_HTML_CONFIG` 注入公网 serverUrl，可以作为现有入口。[CLI 构造/覆盖](../../packages/happy-cli/src/commands/server.ts#L66)、[注入及持久化](../../packages/happy-cli/src/commands/server.ts#L106)、[standalone 注入配置](../../packages/happy-server/sources/standalone.ts#L123)。

App 的 `rewriteLoopbackHost()` 目前只替换协议和 host，不添加服务器路径前缀；因此不能把它当作遗漏 `PUBLIC_URL` 的补救方案。[loopback rewrite](../../packages/happy-app/sources/sync/serverConfig.ts#L30)。

**总体工作量判断：跨客户端的小到中等规模改造，有明确实现路径。** 最小方案的主要改动在 URL 公共逻辑、App 设置和六个实时连接点，服务端协议可以保持。若目标是连现有未更新客户端也不用改设置就能使用 `/relay`，则此方案不足；旧客户端的 pathname/namespace 行为需要单独兼容，或仍提供根路径入口。

## 新版本需要明确的边界

| 边界 | 当前实现及建议 |
| --- | --- |
| API 前缀与 Web 站点前缀 | 二者应独立处理。建议先让 API 位于 `/relay`，Web 位于根路径或独立域名；整站子路径发布还涉及静态资源、SPA 深链接和 HTML 注入。[静态挂载](../../packages/happy-server/sources/app/api/api.ts#L120)、[Web Nginx](../../Dockerfile.webapp#L59) |
| CLI Web 登录地址 | 独立由 `HAPPY_WEBAPP_URL` / `settings.webappUrl` 决定，不能仅改 API URL 后假定 Web 登录已切到新实例。[配置](../../packages/happy-cli/src/configuration.ts#L61)、[登录 URL](../../packages/happy-cli/src/api/webAuth.ts#L9) |
| 手机扫描登录 | 当前 QR URL 只有 `happy://terminal?` 和公钥，没有服务地址；手机和 CLI 必须先指向同一实例。自动携带服务器地址是可选后续功能。[QR 生成](../../packages/happy-cli/src/ui/auth.ts#L97) |
| S3 存储 | `PUBLIC_URL` 不覆盖 S3 presigned URL。公共文件使用 `S3_PUBLIC_URL`，签名上传/下载由 S3 host/port 配置决定，需要独立可访问。[S3 client](../../packages/happy-server/sources/storage/files.ts#L15)、[签名 URL](../../packages/happy-server/sources/app/api/routes/attachmentRoutes.ts#L137) |
| 语音 | 自定义服务器后，语音默认仍使用官方 API，除非打开“语音使用自定义服务器”；完整独立版本需配置对应语音集成并另行验收。[语音服务选择](../../packages/happy-app/sources/sync/serverConfig.ts#L53)、[语音认证](../../packages/happy-app/sources/sync/apiVoice.ts#L16) |
| GitHub 集成 | callback 可用 `GITHUB_REDIRECT_URL` 设置带前缀地址，但完成/失败跳转仍写死官方 Web。需要独立 Web 时须配置化跳转。[OAuth 参数](../../packages/happy-server/sources/app/api/routes/connectRoutes.ts#L65)、[失败跳转](../../packages/happy-server/sources/app/api/routes/connectRoutes.ts#L103)、[成功跳转](../../packages/happy-server/sources/app/api/routes/connectRoutes.ts#L160) |
| HTTPS 与 HTTP | 当前 App 允许输入两种协议；生产 iOS 只声明本地网络 ATS 例外，未放开任意 HTTP。公网示例建议按 HTTPS 设计，实际 TLS/平台访问未验证。[App 校验](../../packages/happy-app/sources/sync/serverConfig.ts#L109)、[iOS 配置](../../packages/happy-app/app.config.js#L79) |
| 新部署的数据与认证 | 换 URL 不会自动迁移数据库、文件存储和服务端密钥。全新部署应重新认证；复用原数据需要单独迁移方案。[数据关系](../../packages/happy-server/prisma/schema.prisma#L22)、[token 密钥](../../packages/happy-server/sources/app/auth/auth.ts#L36)、[服务端加密](../../packages/happy-server/sources/modules/encrypt.ts#L5) |

自托管已有两种运行入口：根 `Dockerfile` 使用 standalone/PGlite 和 `/data`，`Dockerfile.server` 使用服务端 `start`/`main.ts`。`happy-server-self-host` 是对同一服务端的发布包装，不必为 URL 需求复制一套 server。[standalone 镜像](../../Dockerfile#L48)、[server 镜像](../../Dockerfile.server#L55)、[发布包装](../../packages/happy-server-self-host/scripts/build-runtime.cjs#L24)。

阅读部署资料时发现一个与入口选择相关的不一致：README 说仅设置 `DATABASE_URL` 即可绕过 PGlite，但 standalone 源码默认设置 `DB_PROVIDER=pglite`，数据库分支由 `DB_PROVIDER` 决定。因此外部 Postgres 部署须检查 provider 和对应迁移入口；本次没有修改这处文档或执行迁移。[README](../../packages/happy-server/README.md#L65)、[standalone](../../packages/happy-server/sources/standalone.ts#L111)、[数据库分支](../../packages/happy-server/sources/storage/db.ts#L39)。

## 验证状态与后续验收

**本次状态：部分验证。** 已核对源码和六项本地依赖实验；未进行真实 Happy 后端认证/消息测试、公网部署、TLS 验证、浏览器 E2E 或手机验收。当前实现不能直接支持前缀 URL 的故障已有复现；改造尚未实施。

实施后的最低充分验证建议：

- URL 纯函数：根路径、`/relay`、多级前缀、尾斜杠、非默认端口及 IPv6；检查路径不丢失、无重复拼接，并拒绝不支持的 URL 组成部分。
- 真实 Happy 服务 + 本地前缀代理：认证、会话/机器连接、收发消息、创建或恢复会话、断线重连；兼容原根路径。
- 附件和头像：本地存储的上传/下载；实际使用 S3 时另查签名地址及跨域行为。
- App：保存新 URL、显示错误、切换后生效、重新认证。UI 实施后按仓库 E2E 规则验收，同时遵守用户对浏览器使用的授权限制；本次调研未启动浏览器。
- 公网/真机：HTTPS 证书、8193 端口可达性、WebSocket Upgrade 与超时。启用 GitHub、语音或子路径 Web 时，再覆盖相应流程。

建议先完成“自定义 API 基址 + 前缀代理 + 各端连接及配置生效”，再根据独立版本实际启用的功能扩大验收范围。
