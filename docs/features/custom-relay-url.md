# 自定义 Relay 地址

默认服务仍为 `https://api.cluster-fluster.com`，协议与原有根路径连接方式保持兼容。用户可以通过现有配置入口指定自建 Happy server 的 API 基址，例如 `https://xxx.xxx.com:8193/relay`。

## 客户端配置

- App：在服务器设置页填写完整 HTTP/HTTPS URL。保存前检查服务器；确认切换后退出当前账号、清理本地账号缓存并重载。请先备份当前账号的账户密钥，再登录新实例。取消确认不会更改配置或登录状态。
- CLI / daemon：设置 `HAPPY_SERVER_URL`，或保留在现有 `settings.json` 的 `serverUrl` 字段。优先级仍为环境变量 → 持久配置 → 默认。已运行的 daemon 需要在带新配置的环境中重启。
- happy-agent：设置 `HAPPY_SERVER_URL`；未设置时使用原默认地址。

例如，在自己的运行环境中：

```sh
export HAPPY_SERVER_URL='https://xxx.xxx.com:8193/relay'
```

URL 必须包含 `http://` 或 `https://`，可包含自定义端口和多级路径前缀。首尾空白及结尾斜杠会规范化；不接受 URL 内的用户名/密码、查询参数或 fragment。清除 App 的覆盖配置会恢复原配置优先级，通常回到默认服务；如果构建环境或 Web 注入指定了服务器，则恢复那个地址。

## 请求地址与代理

这里的 `/relay` 是 API **基址前缀**，不是 Socket.IO namespace：

| 用途 | 对外请求 | 服务端原路径 |
| --- | --- | --- |
| 认证 | `/relay/v1/auth` | `/v1/auth` |
| REST API | `/relay/v1/...`、`/relay/v2/...`、`/relay/v3/...` | `/v1/...`、`/v2/...`、`/v3/...` |
| Socket.IO transport | `/relay/v1/updates/`，保留 Engine.IO 查询参数 | `/v1/updates/` |
| 检查服务 | `/relay/health` | `/health` |
| 本地公共文件 | `/relay/files/...` | `/files/...` |

客户端使用 `@slopus/happy-wire/serverUrl` 共享入口统一规范化地址。HTTP 保留完整基址；Socket.IO 用 origin 连接根 namespace，并将前缀加入 transport path。默认空前缀仍对应原来的 `/v1/updates`。

服务端路由没有修改。反向代理需要剥离基址前缀并转发 HTTP 和 WebSocket Upgrade，同时保留认证头及查询参数。前缀改为其他名称或多级路径时，代理的匹配和剥离规则也要对应调整。

App 优先检查 `{baseUrl}/health`，要求 `service: 'happy-server'` 和 `status: 'ok'`。如果该接口返回 404/405，继续使用旧版首页 `Welcome to Happy Server!` 校验。其他健康检查失败不会被欢迎页掩盖；检查请求有 10 秒超时。

## 服务端与独立 Web 配置

服务器测试可直接使用根目录 `docker-compose.yml` 和 `.env.relay.example`。
它复用 standalone 后端，由 Nginx 剥离可配置的前缀并转发 WebSocket，数据保存
在命名卷中；完整操作见 [部署文档](../deployment.md#自建-relaydocker-compose-测试部署)。

使用本地附件和头像存储时，将服务器 `PUBLIC_URL` 设为完整公网基址，不带尾斜杠：

```sh
export PUBLIC_URL='https://xxx.xxx.com:8193/relay'
```

这会让文件上传/下载地址包含代理前缀。S3 的公共或签名 URL 继续使用独立存储配置，不能靠 `PUBLIC_URL` 更改签名地址。

Web App 地址与 API 地址可以不同。CLI Web 登录继续由 `HAPPY_WEBAPP_URL` / `settings.webappUrl` 配置；Web 页面继续由现有注入配置或 `EXPO_PUBLIC_HAPPY_SERVER_URL` 指定 API。手机扫描 CLI 登录时，两端必须先配置到同一个实例。

本次没有改变 `happy server` 本地启动命令的地址生成规则，也没有新增服务端原生 basePath。经公网代理运行 standalone 时，可以使用现有 `HAPPY_INJECT_HTML_CONFIG` 指定对外 API 地址；若把整个 Web App 也部署到子路径，还需单独处理静态资源与 SPA 路由。

语音默认仍沿用原有服务选择规则，GitHub OAuth 的 Web 跳转规则也没有改变。独立实例的数据和密钥不因修改地址而自动迁移。

## 验证与维护

URL 纯函数、各客户端配置、旧版健康检查回退及切换清理顺序有相关回归测试。可复用的本地流程脚本位于 [relay-custom-url.e2e.mjs](../../packages/happy-app/scripts/relay-custom-url.e2e.mjs)：

```sh
pnpm --filter @slopus/happy-wire build
pnpm --filter happy build
pnpm exec tsx packages/happy-app/scripts/relay-custom-url.e2e.mjs
```

脚本需要本机 Playwright Chromium。它使用临时 PGlite 数据、loopback 服务和前缀代理，验证真实认证、加密消息、机器 RPC、附件以及 App 保存/取消/切换/恢复。RPC 路由测试的 provider 启动回调使用本地 fixture，不启动外部编码服务。结束后关闭服务并删除临时数据库；关键截图和结果保存在 `.e2e-artifacts/<run-id>/`。

公网 HTTPS、真实手机及外部集成需要按实际部署另行验收。合并上游时，主要维护共享 URL 模块与六处 Socket.IO 接入点；原服务端协议和业务路由继续沿用上游实现。
