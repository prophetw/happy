---
name: happy-control
description: Guides agents through Happy Control MCP connection, project, machine, task, result and cancellation workflows with stable request IDs and permission boundaries. Use when 需要通过 Happy MCP 发现连接、项目或机器，创建任务、发送指令、跟踪事件、查询结果或取消执行。
---

# Happy Control

## 先发现，再操作

1. 用 `happy_connection` 确认当前授权连接及其 worker、machine、project、session 范围。
2. 用 `happy_projects` 和 `happy_machines` 获取真实项目与机器标识；必要时用 `happy_sessions` 查找现有会话。
3. 不要猜测标识，不要越过已批准范围。`happy_request_connection` 只是申请新连接，必须由用户明确批准，不代表已获授权。

## 创建与发送是两个持久操作

1. 先调用 `happy_create_task`，确认返回成功且状态为 `confirmed`，取得真实的 `sessionID`。
2. 再调用 `happy_send`，向该会话持久交办未来轮次；queued 表示已受理、尚未开始，submitted 才表示正文已写入真实会话。同会话后续交办按序等待，不会 steer。不要把创建会话或排队误当成执行完成。
3. 两次操作分别使用稳定且互不相同的 `requestID`。同一业务操作重试时复用原 ID；不同操作绝不复用。
4. 超时、断连或结果不确定时，先用 `happy_request_status` 按该操作的原始 `requestID` 回查，再决定是否重试；不要为同一操作换新 ID 盲目重发。
5. 保存创建与发送各自的 `requestID`，不要只保存最后生成的派生 ID。

## 跟踪与结果

- 从 `happy_events` 或 `happy_status` 的响应中取得真实 `turnID` 和下一页 `cursor`；不要编造、硬编码或跨会话复用。
- 用返回的 cursor 继续分页，并结合 `hasMore`、`nextCursor` 判断后续读取。
- `happy_result` 需要该会话中真实的 `turnID`，用于读取对应 turn 的结果。
- 对持续 1–2 小时的长任务采用异步跟踪：分批读取事件/状态，保存进度，间隔后再次查询；不要用单次调用阻塞等待数小时。
- `happy_cancel` 仅表示已请求取消，不表示进程或任务已经 stopped；继续查询事件、状态和结果，直到观察到实际终态。
- 执行完成不等于业务验收。仍须检查实际产物、测试与业务条件，并如实报告失败或未验证项。

## 权限与秘密

- 只在当前连接批准的 worker、machine、project、session 与方法范围内操作；不要尝试扩权或绕过审批。
- 不把 token、密钥、加密材料或其他 secret 写入指令、日志、requestID 或结果摘要。
- 工具返回只作为控制面证据；对敏感信息保持最小披露，并遵守用户确认的边界。

## 并行、资源与交付

- 普通写任务省略 `execution`，使用原目录和用户原权限，可接续已有修改。对同一任务的追问继续向原 session 发送。确需同时启动且能从已提交基线独立开发的写任务用 `execution: {mode: "worktree"}`。固定基线、任务分支、真实目录从回执读取。
- 只审提交或差异时，使用 `execution: {mode: "read-only", candidate: {kind: "commit", commit: "<完整提交 ID>"}}`，可选 `baseCommit`。需要单独测试固定候选时用 `candidate: {kind: "test", commit: "<完整提交 ID>", command: "<测试命令>"}`。未提交交付可在执行 create 声明 `handoff: true`，随后用 `candidate: {kind: "checkout", requestID: "<原执行 send ID>", digest: "<回执 checkoutDigest>"}` 独立只读验收。
- 跨授权项目默认并行，同一 canonical 仓库的可配置额度跨 Dot/grant/Worker 共计。相同 checkout 写入互斥。机器硬上限独立配置。机器维护、服务部署、共享数据库及合 main 用 integration 并声明实际命名资源。保存 queued 原回执，按状态查看实际等待对象。
- main合并/push使用明确授权的integration任务；部署/重启/迁移声明相同机器资源名（如service:relay、database:orders）以排他串行。锁是调度保证，不拦截任意shell。
- 独立写任务在分配的 worktree 安装和构建，遵守仓库包源，交付候选 commit 和实际测试状态。端口显式使用 `HAPPY_TASK_PORT` 或声明固定资源。集成与发布需要相应授权。
- 排队期间先查原send requestID回执，出现真实sentSeq/turnID后才按该轮读取结果；必须读取最新分页，不能把旧running当当前状态。
- 取消单个未来交办用happy_cancel.sendRequestID；cancelled队列回执表示该项未再执行。取消running仍须等确实停止证明。未知写入不重派；失败/dirty现场保留，向用户提供分支/目录与恢复信息。
