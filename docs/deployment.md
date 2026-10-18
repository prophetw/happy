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
