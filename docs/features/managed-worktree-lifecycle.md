# 托管 worktree：成果处置与显式回收

Happy Worker 的 `TaskQueue` 是工作区身份与运行引用的权威；每个工作区在同一机器的
`workspace-lifecycle/` MetadataStore 中有一个有限大小的处置/操作记录。TestLoop 继续保存
任务结果与验收证据，只接收可选的 owner 回执字段，不自行批准或执行删除。

**默认没有自动回收器、定时扫描或远端删除工具。** `happy-control workspaces` 是本机操作者
入口，不新增 MCP/REST grant、模型工具、进程停止权、提交或推送权限。只发布这份源码不会
启用线上回收。操作真实目录前须另获授权，并完成部署/全体 Worker 版本核对。

后续的 [Dots 工作区页面](dots-workspace-management.md) 提供独立的已认证owner管理入口，
复用本文服务与安全门，不接受模型/MCP凭证，不自动启用定时回收；正常用户流程无需CLI。

## 三种事实分别记录

```text
运行：queued / running / blocked / 正式 turn 终态 / 会话进程状态
成果：待提交 → 待集成 → 已主线核销，或明确保留 Git 归档 / 明确弃用
目录：active → 有限期计划 → retiring fence → retired
```

commit、push、业务验收通过、session 退出、目录回收是五种不同事实。`completed` 不代表
已合 main、已推远端、验收 passed、远端进程 stopped 或可以删目录。任务结果仍不明时保留。

- `plan.outcome=pending_commit`：有 staged/unstaged/untracked 或 ignored 数据。
- `pending_integration` / `no_change_unreviewed`：需要操作者核对本次 HEAD 的处置。
- `resolved`：有绑定 HEAD、task evidence digest、目标 main 与 policy 的处置记录；仍可能被运行引用阻止。
- `eligible/reasons`：本次快照是否可回收及逐项拒绝原因，不是自动授权。
- inventory 有本 scope 的总数、分页计数、有限操作回执与最近核验时间；不全盘扫描仓库。

`resolve --kind integrated` 需要 HEAD 为目标 main 祖先，或基线已在 main、整个独有提交区间
无 merge 且每个补丁均由 `git cherry` 证实等价。手工改写/squash 无法证明时保持未核销。
无改动须 HEAD==base 且 base 已在 main。工作区三层修改、被忽略资料及外部 temporary
交付物都不能用 HEAD 的祖先关系掩盖。早期结果 commit 不在当前 HEAD 历史时也拒绝。

若 policy 指定 remote，必须在线 `ls-remote` 回读且所需对象本地可读，local main 与 remote main
一致。CLI 不 fetch、不 merge、不 push；离线/缺对象保留，local-only 不会被说成已经推送。

`archived` / `discarded` 各需 policy 显式 opt-in 和独立 resolve 命令。它们不假称主线已包含。
在删除前创建 `refs/happy/workspaces/<workspaceID>/<HEAD>`，保留所有可达 Git 对象与必要的
来源/结果标识；它是本地 Git 归档，不是离机备份。需要独立灾备时操作者另做经筛选、验证的
代码 bundle。这里不打包用户数据、secret、数据库、真实日志、node_modules，也不自动删 branch/ref。

## 本机入口与 policy

使用当前源码构建的 `happy-control`（`packages/happy-agent/bin/happy-control.mjs`）：

```sh
happy-control workspaces --help
```

policy 与现有 Worker 配置均须本 UID 所有的私有普通文件（0600），目录不得经符号链接。
机器目录由配置的 machineID 和当前用户 home 派生，不能传任意 queue/path。
policy 的 machine、grant、project、canonical root 必须与已登记工作区及 Worker 项目匹配。
示例仅说明格式，**不是本机已批准的在线策略**：

```json
{
  "version": 1,
  "id": "manual-workspace-retention-v1",
  "machineID": "machine-id",
  "grantID": "grant-id",
  "projectID": "project-id",
  "root": "/absolute/repository",
  "mainRef": "refs/heads/main",
  "remote": "fork",
  "allowApply": false,
  "allowArchive": false,
  "allowDiscard": false,
  "protectedDirectories": ["/absolute/daily-dev", "/absolute/service-release"]
}
```

`allowApply` 缺省 false；省略 remote 表示明确只核本地 main。需要实际回收，操作者须在独立授权后
设置 allowApply=true；临时改 policy 会使旧计划失效。不要把 allowArchive/allowDiscard 当默认值。

```sh
umask 077
happy-control workspaces inventory --worker-config /private/worker.json --policy /private/policy.json --limit 20
happy-control workspaces plan --worker-config /private/worker.json --policy /private/policy.json --id <workspaceID>
```

inventory/plan/result 只读：不初始化目录/密钥、不迁移队列、不改 index/ref，不导出或使用任务正文；内部复用既有官方队列验证层。
plan 只核一个登记工作区；重 Git/proc 检查在独立 CLI 异步执行，不在宿主请求或队列事务中跑。
当前默认仍为每个获准的 read-only 任务创建独立 worktree；不把拥有写能力的 Agent 送入共享目录，
不改 permissionMode、并发资源锁或 dirty 现场保护。

确认成果进入 main 后，使用 inventory 的 revision 和实际 head：

```sh
happy-control workspaces resolve --worker-config /private/worker.json --policy /private/policy.json \
  --id <workspaceID> --operation-id review-001 --revision <revision> --head <sha> \
  --kind integrated --source review:change-id
happy-control workspaces plan --worker-config /private/worker.json --policy /private/policy.json \
  --id <workspaceID> > /private/plan.json
happy-control workspaces apply --worker-config /private/worker.json --policy /private/policy.json \
  --plan-file /private/plan.json --operation-id recycle-001
```

resolve 不做 commit/merge/push，不丢弃 dirty 数据；`source` 只填审核/授权记录标识，不填用户正文或 secret。
`retire` 是 apply 的同义入口。新参数须新 operation ID；相同 ID/相同参数重放原回执，参数变化冲突。
计划只在 60 秒内有效；执行前与取得 fence 后都复核，临删除还检查原期限。过期或状态变化须重新 plan，
不是延长旧计划时间戳。操作回执每工作区最多 16 个，满了明确拒绝，不悄悄过期丢幂等身份。

## 保留条件与崩溃

必须是当前机器/UID 创建或显式纳管的真实登记 worktree，路径必须精确为
`<machine queue>/worktrees/<workspaceID>`；root/commonDir、registry、baseline、实际 branch 和 inode
均匹配。主目录、gitdir/shared objects、当前 cwd、protected service/daily 目录及路径重叠均保护。
symlink、穿越、损坏/借用 alternates、锁定 worktree、submodule、assume-unchanged/skip-worktree
或不可确认 Git 状态均拒绝。工作区 gitdir 中的人工文件/恢复状态、仅存在于该 HEAD reflog 的旧成果也会阻止回收；不要删这些文件来强行过关。不收编 clone、release 或普通手工 worktree。

有 queued/running/unknown、会话引用、同 checkout/全局未知恢复锁、其他 workspace 引用，或存在
tracked/untracked/ignored/temporary 交付物时保留。操作者应先单独保全人工资料，不用 git clean/reset。
默认连 node_modules/构建缓存也不代判可丢弃。

默认 Linux 检查须取得受信任的 SessionProcessProofs 会话→PID/进程组映射，再核对进程、cwd、argv
路径、fd 与可见 mount namespace。缺映射、旧 proof 不含进程组、读不到进程/挂载时 fail closed。
idle 会话即使 turn 已结束、已 chdir 也不能删；必须先由已有获授权入口关闭该会话并重新核对。
CLI 不 kill、不设置 remoteStopConfirmed，不把 PID 消失或 turn end 伪装成业务验收。

准备/使用工作区与回收共享 per-workspace flock，Git 子进程继承同一个锁 FD；queue 中短事务设置
retiring fence，阻止新的 send/create/恢复使用。全局 queue 锁不跨 Git/proc/RPC。
正常 `git worktree remove -- <path>`，从不 force/unlock/rm-rf。

- Git 拒绝且完整 checkout 身份/HEAD/index/内容状态仍一致：记录 failed 并释放自己的 fence，可新 plan/新 ID 重试。
- Git 可能已部分删除：保留 applying/unknown fence 与稳定 ref，不因“目录还在”就恢复使用。
- 删除后回执丢失：相同 ID 只在已有 intent/fence、目录与 registry 均缺失、ref 仍正确时归约为
  `absence-after-intent`，与 `git-confirmed` 分开；不再次删除。
- failed 回执已写但 fence 清理中断：相同 ID 验证完整 checkout 后补完清理。
- 无 intent 的 missing 历史目录：unknown，不视为本工具已回收，也不 prune。

## 历史记录与恢复

旧队列/工作区无 managedBy 不默认可删，plan 显示 unknown；显式 adopt 仅在旧机器队列记录、private owner、
管理根、Git registry/commonDir 与 baseline 全部一致时补 owner 身份，不改历史任务/验收状态。

```sh
happy-control workspaces adopt --worker-config /private/worker.json --policy /private/policy.json \
  --id <workspaceID> --operation-id adopt-001 --revision <revision> --head <sha>
happy-control workspaces result --worker-config /private/worker.json --policy /private/policy.json --id <workspaceID>
```

result 返回 source task、处置证据、稳定 ref、最后操作和精确 `git worktree add` 重建参数；无需原目录。
重建是显式的新 recovery checkout，创建新的用户请求/session，不复用旧业务 operation、不重放旧交办。
retired 后旧 create/send 不能悄悄重建已丢失目录，旧 requests.get 仍可回读 owner metadata/保留 commit。

queue 版本不自动改变，旧记录可读；新可选 owner/fence 字段和进程组 proof 会被老的 strict writer 拒绝。
未来启用前须协调升级所有共享机器队列的 Worker，不能混用旧 writer 或把读取失败当空状态。
旧 `cleanCompletedWorkspace(..., booleanCallback)` 不再提供旁路删除，只返回 policy-required。

本次源码验证仅在临时真实 Git 仓库/worktree、假 transport/activity 与隔离会话子进程上进行。
没有对生产目录运行 inventory/plan/apply，没有启用任何线上自动清理策略。
