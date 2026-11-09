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

## 集成与交付

testLoop 实现保存在隔离提交 `8a8a37daed9494d83abd3fbc3e20a8ada207f0e6`；Worker 修复保存在 `40a4e419764574d35907894358d30fe4e6e7858c`。App 实现、跨仓脚本及本文一并保留在上述 Happy 功能分支的提交中。均未推送、未合入 `main`，未触碰主工作区其他改动；旧 blocked 任务及其回执保持原状。

后续需要先整合两仓源码，再协调升级 testLoop 宿主与已有 memory gateway，最后交付 App。新账本的可选 `moves` 日志和 `movedFrom` 来源字段不能由旧版 strict schema 读取；发生真实移动后，回滚旧宿主必须另行评审，不能删除这些字段冒充兼容。仅发布 App OTA 不能交付完整功能。

原生 iOS/Android 真机操作、线上 Hindsight 以及生产部署尚未验证；本次不执行 OTA、原生构建、安装包发布或渠道变更。

