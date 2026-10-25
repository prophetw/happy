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

**2026-10-25 已首次发布到 `/happy/`**，公网 HTTP 与浏览器冒烟检查通过，
浏览器保留已有路由警告。来源、验证边界与回滚记录见第 0 节的公网发布记录。
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
