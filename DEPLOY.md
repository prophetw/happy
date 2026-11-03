# 个人 Fork 部署入口（prophetw/happy）

本文件提供当前部署入口；个人项目身份、Git 发布线、授权范围与最低充分验证规则以
[AGENTS.md](AGENTS.md) 为准。历史发布结果只证明当时状态，每次发布仍需核对线上版本。

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

详细构建、上传、验收和回滚步骤见
[Web 部署手册](docs/deployment.md#web复用现有-https-域名并挂载到-happy)。

| 项目 | 当前部署约定 |
| --- | --- |
| 公网入口 | <https://szsp.suitbim.com.cn:7100/happy/> |
| Relay API 基址 | `https://szsp.suitbim.com.cn:7100/home-relay` |
| 网关 | `root@192.168.99.57`，Nginx 容器 `bim-nginx-1.30` |
| Nginx 配置 | `/root/bim-engine/script/http.nginx.1.30.1.prod.conf` |
| 宿主机静态目录 | `/root/bim-engine/web/html` |
| 版本目录 / 当前入口 | `.happy-releases/<run-id>` / 相对符号链接 `happy` |
| 发布记录与静态包 | `/root/bim-engine/script/happy-web-artifacts/` |
| 构建入口 | `Dockerfile.webapp` 的 `builder` 阶段 |

构建时设置 `HAPPY_WEB_BASE_PATH=/happy`、`HAPPY_SERVER_URL` 为上述 Relay 基址，
并注入来源提交 SHA 与提交时间。构建导出静态文件后，上传到新版本目录，再原子切换
`happy` 符号链接。切换前核对当前线上来源提交，确认新版本包含已发布功能。

现有 `/happy/` Nginx 路由已配置，常规更新无需重复插入路由或重启网关。
保留上一版本、静态包校验值、来源 SHA 和 `previous-target`，按详细手册回滚。
验收包括入口、JS/CSS、WASM、深层路由、缺失资源的真实 404 和 Relay 健康检查。
真实浏览器按用户当次授权执行；未验证登录、消息收发或附件时，明确报告验证边界。

## Relay

详细说明见 [Relay 部署手册](docs/deployment.md#自建-relaydocker-compose-测试部署)。

- 现有实例：`192.168.99.55:/data/code/happy-relay`，内网 API 为
  `http://192.168.99.55:8193`；公网由 `99.57` 的 `/home-relay` 转发。
- `docker-compose.relay-only.yml` 只运行 API；`docker-compose.yml` 包含路径网关。
- SSH 部署脚本为 `scripts/deploy-relay.mjs`，默认目标是 `192.168.99.56`。
  部署现有 `99.55` 时必须显式指定目标；先用 `--dry-run` 预览、`--check` 只读检查。
- 保留已有密钥、账号和数据卷。客户端与 daemon 使用相同的最终 API 基址，
  `RELAY_PUBLIC_URL` 也必须对应公网基址。不要将历史健康检查当作当前业务验收。

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
