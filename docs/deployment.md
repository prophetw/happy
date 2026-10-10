# Deployment

This document describes how to deploy the Happy backend (`packages/happy-server`) and the infrastructure it expects.

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

默认 Compose 提供 HTTP，HTTPS 可由已有的宿主机网关终止。例如外部 HTTPS
监听 `8193`，Compose 的内部 HTTP 入口使用 `18193`：

```dotenv
RELAY_PUBLIC_URL=https://xxx.xxx.com:8193/relay
RELAY_BIND_ADDRESS=127.0.0.1
RELAY_PORT=18193
RELAY_BASE_PATH=/relay
```

外层网关将 `/relay/...` 原样转发到 `http://127.0.0.1:18193`，并支持 WebSocket
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

默认目标为 `root@192.168.99.55:/data/code/happy-relay`。开发机需要 Node.js、
Git、Docker、SSH/SCP，服务器需要 Docker Compose 和首次生成密钥用的 OpenSSL。
源代码使用独立的缓存 clone，必须处于干净 `main` 并等于刚 fetch 的 `origin/main`；
不会切换当前工作分支。可用 `--source <path>` 指定已有的合规 main clone。

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

`.env.relay` 已被 Git 忽略，Docker 构建也排除环境文件及本地验证产物。
模板中没有实际密钥。配置关系及客户端行为另见
[自定义 Relay 地址](features/custom-relay-url.md)。

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
