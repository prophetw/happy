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

### 仅部署 relay 服务

已有网关或只需直接访问 API 时，使用 `docker-compose.relay-only.yml`。
它只运行一个 relay 容器，将宿主机 `8193` 直接映射到容器 `3005`：

```sh
cp .env.relay-only.example .env.relay
chmod 600 .env.relay
# 填写 RELAY_PUBLIC_URL 和首次生成的 HANDY_MASTER_SECRET。
docker compose -f docker-compose.relay-only.yml --env-file .env.relay up -d --build
curl --fail http://127.0.0.1:8193/health
```

直连时 `RELAY_PUBLIC_URL` 使用 `http://<服务器地址>:8193`，不加 `/relay`。
如果由已有外部网关提供带前缀的 URL，则网关负责剥离前缀，并将
`RELAY_PUBLIC_URL` 改为客户端最终访问的公网基址。该模式使用相同的
`relay-data` 数据卷和主密钥配置。

采用预构建镜像时，在目标服务器加载镜像并将 `RELAY_IMAGE` 设置为对应标签，
启动命令改为 `up -d --no-build`；部署目录只需要 Compose 文件和 `.env.relay`。

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
