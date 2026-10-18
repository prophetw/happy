# 自定义 Relay 地址

默认服务仍为 `https://api.cluster-fluster.com`，协议与原有根路径连接方式保持兼容。用户可以通过现有配置入口指定自建 Happy server 的 API 基址，例如 `https://xxx.xxx.com:8193/relay`。

## 客户端配置

- App：进入“设置”，点击右上角的服务器按钮，在服务器设置页填写完整 HTTP/HTTPS URL。默认服务器和自建服务器均显示此入口。保存前检查服务器；确认后保留账户密钥、设备配对、草稿和本地偏好，在线 CLI / daemon 及运行中会话自动切换。App 重载以重新同步目标服务器；无需重新扫码，也无需手动重启 CLI、daemon 或 Relay。
- CLI / daemon：首次连接可设置 `HAPPY_SERVER_URL`，或使用 `settings.json` 的 `serverUrl`。App 成功发起在线切换后，CLI 将目标 URL 和新令牌原子写入 `access.key`，保留原有加密密钥与机器 ID。后续进程优先使用此明确选定的地址，再回退到环境变量 → settings → 默认值，避免旧环境变量搭配新令牌。只有手工修改环境变量而没有通过 App 切换时，已有进程仍需重启。
- happy-agent：设置 `HAPPY_SERVER_URL`；未设置时使用原默认地址。

例如，在自己的运行环境中：

```sh
export HAPPY_SERVER_URL='https://xxx.xxx.com:8193/relay'
```

URL 必须包含 `http://` 或 `https://`，可包含自定义端口和多级路径前缀。首尾空白及结尾斜杠会规范化；不接受 URL 内的用户名/密码、查询参数或 fragment。清除 App 的覆盖配置会恢复原配置优先级，通常回到默认服务；如果构建环境或 Web 注入指定了服务器，则恢复那个地址。

## 在线切换，无需重新配对

目标 Relay、App 和在线 CLI 均需包含此功能。App 使用已有账户密钥向目标 Relay
完成签名认证并获取新的令牌；目标必须允许该账号访问。`GET /v1/relay` 在鉴权后
返回 `{ liveSwitch: 1 }` 标识协议支持，旧服务器不支持时会提示失败并保留原连接。

App 通过原 Relay 的加密 `relay-switch` RPC 通知在线机器和活跃会话，依次执行
`prepare`、`commit`、`finish`。准备阶段登记机器与活跃会话、检查目标 WebSocket；
确认阶段在原进程内重建连接，保留 RPC 处理器、编码进程、会话 ID、加密密钥及待批准权限。
全部设备确认后才保存 App 的新登录状态。旧连接短暂保留以支持失败回退；未完成事务
会尝试自动回退。回退无法确认时明确报错，不能视为设备已恢复。

`PUT /v1/relay/sessions/:sessionId` 只登记当前加密 metadata、agentState 和包装后的
会话密钥，不复制历史消息或附件。已有同 ID 会话必须属于当前账号，更新时保留历史
和消息序号。切回曾使用过的 Relay 时不向编码进程重放旧提示词。

在线切换依赖旧 Relay 仍可达，并仅通知当时在线的机器与活跃会话。离线设备、其他
App 以及独立的 happy-agent 不会自动发现新地址；旧 Relay 宕机后的备用发现通道
不在本次范围。切服不迁移历史消息、项目或附件，原数据继续保存在原 Relay。

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

原有路由的挂载方式不变；在线切换新增能力探测和当前会话登记入口。反向代理需要剥离基址前缀并转发 HTTP 和 WebSocket Upgrade，同时保留认证头及查询参数。前缀改为其他名称或多级路径时，代理的匹配和剥离规则也要对应调整。

App 优先检查 `{baseUrl}/health`，要求 `service: 'happy-server'` 和 `status: 'ok'`。如果该接口返回 404/405，继续使用旧版首页 `Welcome to Happy Server!` 校验。其他健康检查失败不会被欢迎页掩盖；检查请求有 10 秒超时。

## 服务端与独立 Web 配置

服务器测试可直接使用根目录 `docker-compose.yml` 和 `.env.relay.example`。
它复用 standalone 后端，由 Nginx 剥离可配置的前缀并转发 WebSocket，数据保存
在命名卷中；完整操作见 [部署文档](../deployment.md#自建-relaydocker-compose-测试部署)。
已有外部网关或只需 API 直连时，改用 `docker-compose.relay-only.yml`，直连基址
不带路径前缀。

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

公网 HTTPS、真实手机及外部集成需要按实际部署另行验收。合并上游时，主要维护共享 URL 模块、六处 Socket.IO 接入点及在线切换接口；原有服务端业务路由保持兼容。

在线切换验收脚本（两套独立临时 PGlite 数据与服务端密钥、独立 CLI 测试进程、真实 Web App）：

```sh
pnpm --filter @slopus/happy-wire build
pnpm --filter happy build
pnpm exec tsx packages/happy-app/scripts/relay-live-switch.e2e.mjs
```

脚本覆盖现代 dataKey 配对、进程不重启、草稿保留、不迁移历史、切换后消息收发及
原有权限请求的批准。仅 provider 启动/回复由本地 fixture 替代，不调用外部模型。
执行前需正常完成 `pnpm install` 的仓库补丁与 Prisma 生成步骤，并安装 Playwright Chromium。

本地验收（2026-10-17）：CLI 75 项、App 16 项、服务端 21 项针对性测试通过，
相关类型检查通过；原有前缀流程 9 项及双 Relay 在线切换流程 6 项真实浏览器检查通过，
最终两组浏览器报告均无非预期 HTTP、Console 或页面错误。双 Relay 流程另外覆盖
切回原服不重放提示词，以及设备提交失败时回退并批准切换期间新产生的权限请求。
真实手机、真实外部模型及公网网络环境尚未验证。

| 验收节点 | 截图 |
| --- | --- |
| 新 Relay 收发消息并显示原有权限请求 | [查看](https://szsp.suitbim.com.cn:7100/img-bed/images/043ebac8-e21c-451c-af62-d4fee5914e7d.png) |
| 失败回退后继续处理权限请求 | [查看](https://szsp.suitbim.com.cn:7100/img-bed/images/10f0c8a4-c234-4aaf-befe-4ff4efef29e8.png) |
