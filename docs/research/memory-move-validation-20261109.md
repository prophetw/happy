# Dot 与用户级记忆移动：跨仓验收及集成边界

本次需求是开发手机 App 中 Dot ↔ 用户级记忆的一键移动，不是迁移用户的真实记忆。测试只使用临时目录、夹具账号和隔离账本；没有清空聊天、重发历史任务、解除项目锁或部署。

## 源码边界

| 仓库 | 隔离分支 | 基线 |
| --- | --- | --- |
| Happy | `feat/memory-scope-move-20261109` | `ef5383e6161c43114362a5baa8399c0777d574b7` |
| testLoop | `feat/memory-scope-move-20261109` | `ebbd284` |
| Happy Worker 启动修复 | `fix/worker-startup-cleanup-20261109` | `ef5383e6161c43114362a5baa8399c0777d574b7` |

主工作区已有其他工作：Happy 的未跟踪配置和入口文件、testLoop 已暂存的 `DEPLOY.md` 均保留。testLoop 先前返回的项目/会话 busy 不作强制解除。实现及验证在独立 worktree 进行，主线整合与发布状态以本文最后的核验记录为准。

## 必须满足的行为

- 只有 `dot` 和 `user` 两层。列表与详情提供“移至用户级”或“移至当前 Dot”，正常点击一次完成；内部预检不增加用户确认步骤。
- 保留 key、kind、value 和原 expiresAt，记录原 scope、revision 和来源。目标同名有效记录不静默覆盖，冲突时明确拒绝并提示处理名称。
- 目标用户身份由宿主当前认证解析，RPC 不接受任意 userId、owner 或 bank。源读取/删除、目标写入及账号、配置与 Dot 绑定在异步边界重新检查。
- 同时使用源快照 revision 与目标 revision 做 CAS。固定 workspace → user ledger 锁序；先持久化目标再删除源。请求日志及原 requestID 用于中断恢复，不把部分完成称为原子成功。
- 原索引队列与远端清理继续使用 revision 校验，旧索引完成不得复活已移动的源；本地完成、索引中及远端清理中分别显示。
- 联合召回继续保留 scope 与来源，现有 policy v2 及账号隔离不降级。迁移 RPC 不注册为 Agent/MCP 工具，检索文本和后台通知不能发起移动。
- 手机组件测试覆盖点击、请求、回执、双层刷新、失败与账号切换；网页测试不代表原生真机验收。

## 验证记录

| 检查 | 实际结果 |
| --- | --- |
| testLoop 相关回归 | 5 个文件 73/73 通过，0 失败、0 跳过；最后仅来源元数据语义调整后，移动专项 23/23 再验，其余 50 项复用 |
| Happy 原生组件及协议回归 | 4 个文件 42/42 通过 |
| 跨仓客户端 → 加密 RPC → 隔离账本契约 | 6 个场景通过；Node TAP 统计 7/7，包含 1 个父测试，0 失败、0 跳过 |
| Worker 启动修复回归 | 3 个文件 19/19 通过 |
| 类型及格式 | testLoop 后端 TypeScript、Happy App 完整类型检查、Worker CLI 类型检查及各自 `git diff --check` 通过 |

testLoop 覆盖双向内容与绝对期限保留、来源与独立 revision、同名冲突、双方陈旧 CAS、可信身份/跨账号/撤权拒绝、请求重放、两方向三个持久化阶段的真实 SIGKILL、真实多进程竞争、fsync 失败、迟到索引、旧完成日志释放占位、跨 workspace 来源占位、取消竞争及 policy v2 联合召回。没有对真实用户账本做迁移实验。

原生组件覆盖列表和详情入口、正常一键提交、两层刷新、冲突与失败提示、超时及组件重开后的同 ID 恢复、晚到响应遇到账号/密钥/前后台变化、本机存储失败、已完成回执遇到刷新失败、旧索引终态、旧 source revision 的发现及显式停止。非有效记忆还有只读“核对未完成移动”入口；它不因任何返回结果自动提交迁移，已删除记录不展示正文。

跨仓脚本打包实际 App `requestDotMemoryMove`，只替换原生存储和传输适配器，再连接实际 testLoop 加密 workspace RPC 和隔离身份/账本夹具。它检查双向移动及期限、冲突、部分完成后的原 ID/CAS 恢复、取消保留副本、源已编辑后的旧请求发现以及 workspace 失效。该测试没有使用真实 Relay 或浏览器，不代表真机验收。

可复跑命令：

```sh
# testLoop 隔离 worktree
pnpm exec tsc -p tsconfig.json --pretty false
node --test --test-reporter=tap \
  test/assistant-memory-move.test.mjs test/assistant-user-memory.test.mjs \
  test/assistant-hindsight.test.mjs test/assistant-memory.test.mjs \
  test/assistant-memory-gateway-scopes.test.mjs

# Happy 隔离 worktree 的 packages/happy-app
pnpm exec vitest run --reporter=dot \
  sources/components/dots/DotObservationPanel.test.ts \
  sources/components/dots/DotSessionContent.test.ts \
  sources/sync/dotMemoryMove.test.ts sources/sync/dotObservation.test.ts
pnpm typecheck

# Happy 隔离 worktree 根目录；需先准备 testLoop dist
TESTLOOP_MEMORY_MOVE_REPO=/home/dev/code/testLoop-memory-move-20261109 \
  node packages/happy-app/scripts/verify-dot-memory-move-contract.mjs
```

跨仓最终 TAP 保存在 Happy worktree 的 `.e2e-artifacts/memory-move-20261109/contract.tap`；后端两轮 TAP 在相同产物目录的 `backend-related.tap`、`backend-final-move.tap`。Worker 的命令、故障证据及恢复边界见另一个独立 worktree 的 [取证报告](/home/dev/code/happy-worker-startup-20261109/docs/research/worker-offline-20261109.md)。

中间检查失败如实保留：testLoop 首次编译曾因未使用的类型 import 报 TS6196，移除后通过；Happy App 首次类型检查因隔离 checkout 缺少 happy-wire dist 和 CLI 依赖入口失败，补齐该 checkout 的构建产物及依赖链接后通过。最终没有未解释的测试或类型错误。没有运行全仓测试、Expo 导出、Docker 构建或线上故障注入。

## 实现阶段的隔离交付（发布前）

testLoop 实现保存在隔离提交 `8a8a37daed9494d83abd3fbc3e20a8ada207f0e6`；Worker 修复保存在 `40a4e419764574d35907894358d30fe4e6e7858c`。App 实现、跨仓脚本及本文一并保留在上述 Happy 功能分支的提交中。均未推送、未合入 `main`，未触碰主工作区其他改动；旧 blocked 任务及其回执保持原状。

后续需要先整合两仓源码，再协调升级 testLoop 宿主与已有 memory gateway，最后交付 App。新账本的可选 `moves` 日志和 `movedFrom` 来源字段不能由旧版 strict schema 读取；发生真实移动后，回滚旧宿主必须另行评审，不能删除这些字段冒充兼容。仅发布 App OTA 不能交付完整功能。

原生 iOS/Android 真机操作、线上 Hindsight 以及生产部署尚未验证；本次不执行 OTA、原生构建、安装包发布或渠道变更。

## 配套发布验收（2026-11-09）

本节记录用户随后授权“提交、合并 main、推送、发布”的实际结果，前文发布前记录保留。常规发布源码如下；发布后的文档提交不改变已发布产品代码。

| 组件 | 实际发布来源及证据 |
| --- | --- |
| Happy | `0d16e04d38c348822885e5d75010c9242700bab9`；main 保留合并 `cf1d9e36`、`40a4e419` 的历史，并增加手机更新日志 |
| TestLoop | `6d3fc66bef9da2c99e16f9fc6fa37c070d524a73`；main 合并并保留 `8a8a37d` |
| 宿主/recovery | `/home/dev/.local/share/testloop-releases/memory-move-20261109-6d3fc66`；scanner PID `3347034`、recovery PID `3348439`，两用户服务 active |
| memory/MCP gateway | 四个实际进程均使用上述新 TestLoop 目录，旧 gateway 无残留 |
| 托管 CLI / 系统 Worker | `/home/dev/.local/share/happy-automation/releases/memory-move-20261109`；manifest 的 83 个 dist/bin/lock 文件与构建源码一致；Worker 实际 ExecStart/cwd/happy-agent 均在此包 |
| Web | `https://desktop-8ut4p0p.taild92624.ts.net/happy/`；HTML SHA256 `b22e1413de695ebec388402982a2b4ed1451f1d61517d9da0a71c9c87d361bf9`，三入口 JS 与导出一致，旧哈希资源保留 |
| iOS OTA | `@prophetwayen/happy`，project `1d018bd8-34db-4b57-a0a9-61f24671153e`，preview 分支/环境，runtime `21`，bundle `com.prophetwayen.happy.preview` |

[OTA 更新组 131cc65a](https://expo.dev/accounts/prophetwayen/projects/happy/updates/131cc65a-3538-4204-a2dc-e4a27ceb7490)，iOS update ID `01a1bdb5-180f-79e6-8b28-53f24a210ca2`。EAS list/view 回读提交、平台、runtime、分支均匹配；environment 由明确的 `--environment preview` 命令及 effective identity 检查核实，API view 未单列该字段。preview 和 production 既有映射都指向 preview，本次没有修改；两渠道下发 manifest 均为本次 update、个人项目/包名、runtime 和 `buildCommitSha=0d16e04d...`。与最近实际 OTA `82509012` 比较，没有原生依赖或配置变化，保持 runtime 21。

### 最终版本验证

- 合并 main 后重新运行 TestLoop 五文件 **73/73**、App 四文件 **42/42**、Worker 三文件 **19/19**、切换器安全回归 **16/16**，相关类型检查及 CLI 构建通过。
- 合并最终客户端与后端的跨仓契约 **6 个场景通过**（TAP 7/7 含父测试）；真实浏览器使用同一最终 `/happy` 产物及隔离认证账号/Relay/账本完成六组业务流程，覆盖双向移动、其他 Dot 同名私有记忆保护、冲突、重载恢复、停止和过期来源只读发现，错误集合为空，脚本模型调用 0。
- 实际线上首页和 `/happy/dots` 均 200；浏览器加载的 HTML 和三个 JS 逐字节核对，页面/Console/非预期 HTTP 错误为空。匿名工作台显示既有账号/服务器守卫，不把匿名入口验证称为生产登录态业务验收；验证来自本机 tailnet 的 390×844 Chromium，不代表手机或外部移动网络。
- 两个原 Dot 的生产加密新 RPC 对随机未知 requestID 的只读 `status` 均返回 `memory_move_not_found`；两层只读查询、namespace、canonical memory 摘要保持。测试没有向真实用户账本发送 move/write 或聊天消息。
- 真实 Hindsight 验收使用临时账本、新 namespace、夹具认证账号和两个无碰撞独立 bank。原 collector 完成索引、Dot→user 移动后联合召回仅返回 user、源远端清理及最终 forget。两个 bank 文档归零后删除，复核原 bank 总数仍为 9、临时账本已删除。未强制控制实际远端完成时序，确定性迟到由隔离回归覆盖；实际服务 embedding/LLM 调用量未独立计数，不能将该项计入“模型 0”的脚本夹具。
- 系统 Worker PID `3309144`、state/lock 匹配、心跳正常、同 machine `/status connected=true`、`NRestarts=0`；五个原会话根 PID/startTicks 保持。真实配置/registration 摘要、凭据、重试、Tailscale 访问范围未改。root 私有协调回执未读取，不用 transient unit GC 后的默认 Result 作为原始成功证明。

### 数据备份、健康与回退

宿主在无 pending input 安全点通过独立用户协调服务串行切换。冷备在 `/home/dev/.local/state/testloop-backups/memory-move-20261109-6d3fc66` 和同名 `-extras`：1364 个 assistant 文件、七个原生 home、Happy profile 及解析凭据私密副本、用户记忆 namespace/账本、旧 unit/config 均逐文件校验并落盘。Hindsight 单容器冷归档 147240960 字节，SHA256 `8af2cdc5fc78be1d1152bb98dace3e652c419b04431c773c95dba38b9e841c55`，随后恢复服务。原 session/thread、输入历史、记忆及授权保持。

系统 Worker 由用户在外部 WSL 终端执行已审阅的独立 root 激活入口；当前通道的 NoNewPrivileges 没有被绕过。新 drop-in 只改变工作目录/ExecStart，原 `on-failure`、10 秒、三次/五分钟限速保留。旧 release 和受限显式回退入口留在 `/home/dev/.local/share/happy-automation/maintenance/startup-cleanup-20261109/`。

Web 完整旧版本在本次证据目录 `previous-web/`；激活脚本失败会恢复旧表面，保留新哈希资产。未执行 OTA 回退，上一兼容更新组为 `3ba69aa4-47b2-40d7-9346-21a85595fd06`（`82509012`，runtime 21）；必要时使用个人项目的 `eas update:republish --group <group> --destination-branch preview --platform ios --non-interactive`，并考虑 preview/production 共享分支影响。新账本写入后，旧 strict-schema 宿主不能直接启动；不得以覆盖冷备、删除字段或抹掉发布后聊天来回退。

当前宿主仍 degraded，仅有原 `assistant_runs_need_attention`、`assistant_conversation_needs_attention`、`assistant_happy_push_needs_attention`。历史 `dot-recovery-upgrade-20261108.service` 仍为 failed/exit 1（原 metrics 健康断言），本次未重跑或清除；新协调的锁内 health 没有该新增告警。不称全系统健康。

### 失败记录及未验证边界

CDN 主包下载探针返回 HTTP 403（Python、Node 和按实际 SDK 构造的请求均未下载成功）。两渠道实际 manifest 与 EAS 发布信息已核对，本地导出主包为 10001316 字节、SHA256 `544ac938041fe578d68749bded12235139c49414fd498de487e913b73b215da8`；**没有获得 CDN 主包字节一致或手机已接收的证明，也没有证据据此断言手机必然失败。** 手机应用更新后核对提交 `0d16e04d` 与实际移动入口；真机点击、移动网络及后续自然稳定性未验证。

其他验收失败如实保留：匿名路由首轮脚本误要求跳转登录，按真实源码守卫修正后通过；PGlite 自有服务 SIGTERM 后出现既有关闭诊断，业务期错误为空且自有进程退出确认；运行包最小体积断言不适用于 pkgroll 分块，已改为全部构建文件哈希和 CLI smoke 核验；OTA 探针补齐 SDK Accept 并按真实 `extra.app.buildCommitSha` 解析后 manifest 验证通过。最初 Python 默认 User-Agent 得到 Cloudflare 1010，按[官方文档](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)使用明确自报身份的验证器后 manifest 可读，CDN 主包 403 仍保留为未解决验证限制。没有关闭安全检查或改访问范围。EAS 指纹耗时正常等待完成，未设置跳过指纹。

本次任务 diff 的凭据特征扫描未发现匹配；取证只输出白名单，没有复述先前日志中的鉴权值，也没有因此轮换正在使用的凭据。

### 证据与截图

Happy 证据根：`/home/dev/code/happy-native-dot-release/.e2e-artifacts/memory-move-release-20261109/`，含最终测试/构建、`contract-final.tap`、`browser/final/report.json`、`online-browser-final/report.json`、EAS 摘要及实际 manifest、`ota-served-verification.json`、`hindsight-live/report.json`。宿主证据在固定 TestLoop release 的同名 `.e2e-artifacts` 目录。Worker 独立白名单核验在上述 maintenance 目录 `verified-live.json`。

| 隔离/线上验收节点 | 截图 |
| --- | --- |
| 隔离双向移动 | [查看](http://100.116.89.36:3210/img-bed/images/93c40638-5706-4371-8f65-a7ce9dd1c19a.png) |
| 同名冲突 | [查看](http://100.116.89.36:3210/img-bed/images/effb9e22-bf12-492d-80d6-efda15c16a8c.png) |
| 停止并保留副本 | [查看](http://100.116.89.36:3210/img-bed/images/145ffd7d-9fd6-4e16-83b8-21006eeb35dd.png) |
| 过期来源只读核对 | [查看](http://100.116.89.36:3210/img-bed/images/ea2d94fa-b7e8-4b7a-bb40-20748fc2fb04.png) |
| 实际私网入口 | [查看](http://100.116.89.36:3210/img-bed/images/dc688e2a-d74b-4896-b173-377da673928a.png) |

