# 个人 Fork 维护说明（prophetw/happy）

本仓库按个人项目独立维护，用于自己的手机、CLI / daemon 和自建 Relay。
上游 `slopus/happy` 是按需吸收更新的来源，不是个人发布必须追平的基线。
默认不公开上架 App Store / Google Play，也不发布上游 npm 包。
已有的个人 TestFlight 安装方式可以继续使用；TestFlight 测试分发与公开上架分别处理。

默认中文回复。优先复用项目已有实现和开源组件，只修改当前任务需要的内容。
结论以代码、日志和实际验证为依据；没有验证的内容明确标为“未验证”。

## 1. 文档与操作入口

- 本文件定义个人 Fork 的维护和发布约定。
- 部署前先读 `DEPLOY.md`；Relay 的详细操作见 `docs/deployment.md`。
- 执行原生构建、TestFlight 提交、OTA 或其他发布前，完整阅读
  `.agents/skills/release/SKILL.md`。其中上游专用的仓库、账号、主线和发布目标，
  以本文件的个人配置与发布检查为准，不照搬上游默认值。
- 同一会话中已读且未变化的规则与技能文档无需逐轮重读；同一次发布的最终源码、配置
  与依赖未变时复用验证结果和已有授权。每次实际发布仍执行当次 fetch、项目身份、
  渠道映射与最近 OTA 的远端核验。
- `DEPLOY.md` 中旧 worktree 路径、未提交的个人配置、固定 runtime 等记录是历史信息，
  使用前核实当前代码和环境。个人发布配置应可复现，不能只靠某个旧目录的未提交修改。
- 用户要求修改文档，不代表授权构建、发布、提交商店或重启运行中的服务。

## 2. Git 远端与分支

当前远端约定如下；操作前用 `git remote -v` 核对实际地址，不擅自改名或改 URL。

| 名称 | 仓库 | 用途 |
| --- | --- | --- |
| `fork` | `git@github.com:prophetw/happy.git` | 自己的仓库，开发、集成与发布基线 |
| `origin` | `git@github.com:slopus/happy.git` | 上游，仅在用户要求时吸收更新；不向它推送 |

- `main` 是个人开发与常规发布的统一主线，对应 `fork/main`。
  手机原生构建、TestFlight、OTA、CLI 和 Relay 都从这条主线发布，
  不再维护一条必须额外合并的手机发布分支。
- `test/my-testflight-build` 是历史 TestFlight 发布分支，仅用于查阅旧发布和个人配置。
  切换到 `main` 发布前核对它的内容差异，把需要保留的增量带回 `main`；
  不再向该分支例行同步，也不自动删除历史分支。
- 用户未要求时，不自动合并 / rebase 上游，不把“落后于上游”视为发布失败。
  吸收上游时保留个人功能、Relay 支持和发布配置，按需 merge 或 cherry-pick。
- 用户说 `sync to main` / `synt to main` 时，在本 Fork 中表示：fetch `fork/main`，
  将当前分支 rebase 到它，完成相关验证后普通推送 `git push fork HEAD:main`。
  这不包含吸收上游或执行发布；禁止 force push。

第一次写文件前运行 `git rev-parse --show-toplevel` 和
`git status --porcelain=v1 -uall`，记录已有改动。只追踪、修改和暂存本任务路径；
不覆盖其他任务的改动，不使用全局 `git add .` / `git add -A` / reset。
默认不 commit、不 push，除非用户要求；提交前检查暂存文件清单。

## 3. “preview prophet” 的个人发布目标

“preview prophet” / “prophetw preview” 指下面的个人项目与渠道，
不是名为 `prophet` 的 Git 分支或 EAS channel。
下表是当前发布约定：Git 来源统一为个人 `main`；Expo 身份依据既有发布记录
（最近核对到 2026-10-23），每次发布仍要核验实际目标。

| 项目 | 个人发布约定 |
| --- | --- |
| Git 来源 | 个人 `main`，与 `fork/main` 一致 |
| Expo owner / slug | `prophetwayen` / `happy`（`@prophetwayen/happy`） |
| EAS project ID | `1d018bd8-34db-4b57-a0a9-61f24671153e` |
| App variant | `APP_ENV=preview` |
| EAS environment | `preview` |
| EAS channel | `preview` |
| EAS update branch | `preview` |
| iOS bundle identifier | `com.prophetwayen.happy.preview` |
| 已有原生 runtime | `21`，以手机安装包和构建记录为准 |

上述 project ID 已通过 `eas project:info` 和
[2026-10-23 个人 OTA 记录](https://expo.dev/accounts/prophetwayen/projects/happy/updates/f23f8391-afa6-4770-b3a4-05cb6b951c01)
交叉核验，可直接用于后续发布的身份检查，无需重新搜索旧目录或历史会话。
Apple team ID、App Store Connect app ID 仍须在原生构建 / 提交前从个人项目核验；
不猜测、不从 update ID 推导。
仓库根目录的 `app.json` / `eas.json` 也不能作为手机 App 的身份依据；
不要将其中的 project ID 作为候选去试探发布目标。Expo / EAS 命令在
`packages/happy-app` 下执行。

`packages/happy-app/app.config.js` 仍包含上游默认值，个人发布终端必须显式设置以下
非敏感身份变量，并检查最终配置：

```bash
export EXPO_OWNER=prophetwayen
export EAS_PROJECT_ID=1d018bd8-34db-4b57-a0a9-61f24671153e
export EXPO_UPDATES_URL=https://u.expo.dev/1d018bd8-34db-4b57-a0a9-61f24671153e
export EXPO_IOS_BUNDLE_ID_PREVIEW=com.prophetwayen.happy.preview
export APP_ENV=preview
```

检查 `expo config` 的最终 owner、slug、project ID、updates URL、bundle identifier 和
runtime，并用 `eas project:info` 核对目标。只输出必要的非敏感身份信息。
不得使用上游 `bulkacorp`、上游 project ID `4558dd3d-cd5a-47cd-bad9-e591a241cc06`
或 `submit` 配置中的上游 Apple 账号 / app ID。
原生云构建还需保证 EAS environment / build profile 中有相同个人配置，
不能只在本机 export，远端构建却回退到上游默认值。
核验构建实际使用的 EAS environment，不能仅从 `channel=preview` 推断环境也是 preview。

## 4. 个人发布的共同检查

先确定用户要求的是 OTA、原生构建还是 TestFlight 提交。
用户已明确说“热更新到 preview prophet”时，按上述个人 iOS OTA 目标执行，
无需重新询问上游 / 个人项目或生产 / preview。其他平台仅在用户要求时包含。

所有个人发布必须满足以下检查，任何一步失败立即停止，不继续发布：

1. 常规发布从已提交的个人 `main` 执行。
   当次 `git fetch fork main`，确认当前分支为 `main` 且 HEAD 与 `fork/main` 完全一致。
2. 发布 checkout 的工作树干净，包括未跟踪文件；不擅自 stash、清理或提交别人的改动。
   需要隔离时可用独立 clone 或干净 worktree，但必须核验同一发布提交与个人配置。
3. 将 HEAD 与该个人渠道最近一次发布的提交比较，确认不会遗漏已发布功能。
   发现分叉或缺失提交先调查，不能靠“最后发布的 OTA 会覆盖旧包”掩盖功能回退。
4. 核验个人 Expo 项目、渠道映射、平台、bundle identifier 和 runtime。
   历史记录中个人 `production` channel 曾与 `preview` 指向同一 update branch；
   发布前检查实际映射并说明影响范围，不擅自修改 channel 映射。
5. 完成与变更相匹配的验证。在 App 目录运行
   `pnpm exec tsx sources/scripts/parseChangelog.ts`，确认生成的
   `sources/changelog/changelog.json` 与已提交版本一致；有差异时先按授权处理源码提交，
   再重新检查干净工作树与远端一致性，不能在发布后才补提交。
6. 执行前说明发布目标、来源 SHA、变更及验证结果。按用户已有授权执行，
   发现目标或范围不一致时先澄清。

**现有脚本的差异：** `packages/happy-app/sources/scripts/releasePreflight.mjs` 仍硬编码要求
本地 `main == origin/main`，`pnpm ota` 和 `release:build:*` 会调用它。
该检查针对上游发布，尚未适配本 Fork 的发布线；修改本文件不会改变脚本行为。
个人 `main` 应与 `fork/main` 对齐，不要求与上游 `origin/main` 对齐。
在脚本适配前，个人发布以本节的完整检查代替其上游主线检查，再运行下述显式 EAS 命令。
不能直接套用旧脚本，也不能用 `HAPPY_RELEASE_ALLOW_OFF_MAIN=1` 把脏文件、错误项目、
检查失败或缺失个人功能一起放行。上游落后情况仅作参考，不要求为发布而追平上游。

## 5. OTA 热更新

适用于与当前原生安装包兼容的 JS / 资源修改。新增或升级原生模块、Expo SDK、
权限 / entitlements 等原生配置时，先评估兼容性；需要新的原生层时走原生构建。
runtime 不必永远固定为 `21`：纯 JS 更新保持兼容 runtime，原生接口变化时更新 runtime
并重建安装包，避免不兼容 OTA 送到旧包。

完成第 3、4 节检查并加载已核验的个人配置后，在 `packages/happy-app` 执行：

```bash
pnpm typecheck &&
  eas update --branch preview --environment preview --platform ios \
    --message "<本次变更说明> (<来源短 SHA>)" --non-interactive
```

不要用 `--auto` 代替明确的 EAS branch；Git 发布分支为 `main`，
EAS update branch / channel 仍为 `preview`，无需为了统一 Git 主线而改名。
不使用指向 production workflow 的 `pnpm ota:production` 代替个人 preview 发布。

发布后在同一个人项目下回读：

```bash
eas update:list --branch preview --limit 1 --non-interactive --json
```

核对最新 update 的来源 SHA、平台、runtime 与本次发布一致，记录 update ID 和链接。
EAS 发布成功与手机已经接收分别报告；真机未验证时明确说明。
真机检查重启 / 加载更新后的界面、Relay 连接、会话收发，以及本次修改的关键操作。

回滚应使用个人项目的 EAS 回滚 / 重发机制，明确恢复的版本、原生兼容性和受影响渠道。
不能直接从旧源码重发而忽略之后已经上线的其他功能。

### 执行顺序与耗时控制（2026-10-23 实操经验）

按“确定最终源码 → 准备发布目录和依赖 → 一次预检 → 发布 → 回读”执行。
第 4 节检查仍全部适用；减少重复探索，不省略发布条件。

1. **先明确 Git 授权和最终 SHA。** 核对本任务文件及暂存清单，需要提交 / 推送授权时，
   在改动与目标可审阅后一次集中确认。已有当次授权不因切换目录或跨消息再次询问。
   只发布 OTA 时不顺带更新 CLI；只改文档不执行构建、发布或 daemon 重启。
2. **优先复用干净的发布 clone。** 在该目录 fetch `fork/main`，确认 `main`、HEAD、
   `fork/main` 一致且无未跟踪文件。没有合适目录才新建隔离 clone，保留原工作区的其他改动。
   复用依赖时只处理该 checkout 实际存在的 workspace；不要遍历复制旧目录里所有
   `packages/*/node_modules`，其中可能有未提交的历史包目录。
3. **在 App 检查前准备共享包产物。** `happy-wire` 的包入口和类型声明指向 `dist`，
   新 clone 不包含这些被忽略的构建产物，仅复用 `node_modules` 不够。
   `dist` 缺失或共享包源码变化时，先在仓库根运行
   `pnpm --filter @slopus/happy-wire run build`，再运行 App 类型检查。
   避免先让整次 typecheck 因缺少共享包入口失败，再补构建、重跑。
4. **先确认身份，再并行查询元数据。** 用第 3 节固定身份完成 `eas project:info` 和
   最终 `expo config` 核验，通过后再并行查渠道映射与最近 OTA。预检期间每项查一次即可，
   不在每条命令前重查同一项目。最近发布提交必须从本次远端记录读取，不把本文链接
   当作永久发布基线；原生兼容性按该提交到最终 SHA 的实际差异判断。
5. **复用验证结果，避免重复构建。** 同一最终源码及依赖下已通过的相关测试无需因为
   “进入发布阶段”重跑。常规 OTA 的 App 类型检查和 changelog 一致性各检查一次；
   更换依赖环境或修复失败后再重跑对应检查。CLI 的 Vitest global setup 会触发 build，
   调用前看清测试入口；`eas update` 会自行导出 JS 包，不提前重复 `expo export`。
6. **限制 EAS 输出。** `channel:view --json` 可包含完整 manifest、资源列表和签名 URL；
   先在本机解析，只输出渠道 / 分支映射、来源 SHA、平台、runtime、environment 和必要身份。
   `update:list` 用 `--limit 1`；发布后结合 `update:view <group-id> --json` 核对真实提交。
   不反复打印完整配置、环境变量值、manifest 或资源清单，也不为裁剪输出重复发送同一查询。
7. **区分平台耗时和失败。** 打包、上传、项目指纹计算需要等待；
   “Computing the project fingerprints is taking longer than expected” 本身不是失败。
   正常等待并给出阶段进展，不为加速跳过指纹、类型检查或干净工作树要求。
8. **CLI 更新单独做最小闭环。** 用户同时要求更新 CLI 时，先确认 `happy` 的实际路径。
   已指向本仓库且依赖未变时，构建一次、顺序停止 / 启动 daemon、核验 PID 与实际
   `dist/index.mjs` 路径即可，不重复 `npm link`。源码更新可能保持相同版本号，
   不能仅凭版本号认定已更新；已有会话进程不会因此热替换代码，新会话使用新构建。

## 6. 原生构建与 TestFlight

| 用途 | 仓库已有 build profile | 分发 / channel |
| --- | --- | --- |
| 继续个人 TestFlight 安装 | `preview-store` | `store` / `preview` |
| 用户要求直接安装包 | `preview` | `internal` / `preview` |

`preview-store` 是构建配置名称；其中 `store` 不表示授权公开上架。
个人 bundle identifier、签名凭据及远端构建环境必须先通过身份核验。
仓库 `eas.json` 的 `submit.preview-store` 仍是上游配置，不能直接用于个人提交。

完成共同检查后，TestFlight 原生包的构建命令为：

```bash
eas build --profile preview-store --platform ios --non-interactive
```

若用户要求构建并送达 TestFlight，先核实 / 配置指向自己 Apple team 与 app 的
submit profile，再用 `--auto-submit-with-profile <已核验的个人 submit profile>`，
或构建完成后按明确的 build ID 提交。不能使用上游 `production` submit profile，
也不能只构建就报告“已送达 TestFlight”。
不运行会顺带构建 / 提交多个上游 variant 的 `release:build:developer` 或
`release:build:appstore` 作为个人发布快捷方式。

回读构建与提交记录，核对 Git SHA、bundle identifier、runtime、build number 及
Apple app 目标。构建完成、上传完成、TestFlight 可安装、真机已验证分别报告。
公开商店上架和 npm 发布必须另有用户明确要求。

## 7. CLI、Relay 与最低充分验证

- CLI 默认从个人源码构建 / 安装，参考 `.agents/skills/dev/SKILL.md`。
  使用根 `package.json` 指定的 pnpm 版本（当前 `10.11.0`），不发布上游 npm 包。
  安装会替换全局 `happy` 并重启 daemon，应属于用户明确要求的操作范围。
- Relay 部署按 `DEPLOY.md` / `docs/deployment.md`；确认 App、CLI / daemon 的实际
  服务端配置一致，保留已有密钥、账号和数据卷，不把文档中的历史验证当作当前在线状态。
- 文档、文案和小型样式修改通常不运行单元测试；局部逻辑只跑直接相关测试。
  不自动全量测试、完整 build、Docker 部署或大量读日志。
- 关键用户流程、前后端联动执行对应 E2E，存在 `E2Etest.md` 时优先参考。
  真实浏览器操作遵循用户当次授权，未获授权时不启动浏览器并说明未验证部分。
  严重错误未解释时不能报告 PASS；后端测试通过不能替代页面或真机验证。
- 结束时简述修改、验证结果、未验证项 / 错误，以及 Git 暂存、提交和发布状态。
