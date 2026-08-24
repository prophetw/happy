# Antigravity (agy) Session Resume Support

Feature document for resuming Antigravity (`flavor: "agy"`) sessions across Happy CLI, daemon, and the mobile/web client.

## 功能目标

在 Happy 客户端（iOS / Web / Desktop）中支持直接展示、拉起并一键恢复（Resume）处于非活跃（`inactive`）状态的 Antigravity (`agy`) 会话，保持与 Claude 和 Codex 会话一致的恢复体验。

## 核心入口

| 组件 | 文件 | 角色 |
|---|---|---|
| App 前端 | `packages/happy-app/sources/hooks/useSessionQuickActions.ts` | 校验会话是否具备可恢复 ID（`agyConversationId`），决定渲染「Resume Session」按钮还是终端命令 |
| App 会话视图 | `packages/happy-app/sources/-session/SessionView.tsx` | 会话界面底栏渲染恢复提示/按钮及 Agent Goal 状态同步 |
| CLI 会话恢复解析 | `packages/happy-cli/src/resume/resolveHappySession.ts` | 会话元数据解析与 schema 校验（包含 `agyConversationId`） |
| CLI 恢复命令构建 | `packages/happy-cli/src/resume/handleResumeCommand.ts` | 将 `flavor: "agy"` 映射为 `happy agy --resume <conversationId>` 启动参数 |
| Daemon 运行器 | `packages/happy-cli/src/daemon/run.ts` | 后台守护进程响应 `resume-happy-session` RPC 并拉起对应子进程 |

## 架构关系与数据流

```
Happy iOS App (SessionView)
   │
   ├─[判断] getResumeAvailability(session, machine, isConnected)
   │        检查 session.metadata.agyConversationId 是否存在
   │
   ├─► 若可一键恢复 (在线机器 + 有 ID):
   │     点击「Resume Session」 ──RPC: resume-happy-session──▶ Happy Daemon (run.ts)
   │                                                           │
   │                                                           ├─ buildResumeLaunch()
   │                                                           │   args: ['agy', '--resume', conversationId]
   │                                                           │
   │                                                           ▼
   │                                                      拉起本地 happy agy 子进程
   │                                                      重新同步会话并切为 active
   │
   └─► 若不可一键恢复 (机器离线或缺少 Daemon):
         展示终端命令: cd '<path>' && happy agy --resume <conversationId>
```

## 关键数据结构

- `Session.metadata.agyConversationId`: `string`，对应 Antigravity CLI 的会话 UUID（例如 `ff7de001-44eb-4736-9d05-8b8dac3a8281`）。
- `ResumeAvailability`:
  ```typescript
  export type ResumeAvailability = {
      canResume: boolean;
      canShowResume: boolean;
      subtitle: string;
      message: string;
  };
  ```

## 异常路径

1. **会话无 `agyConversationId`**：
   - 触发 `resumeSessionMissingBackendId`，`canResume: false`，App 降级为仅展示提示信息或复制命令。
2. **目标机器离线 (`!isMachineOnline(machine)`)**：
   - 触发 `resumeSessionMachineOffline`，`canResume: false`，App 提供终端复制命令让用户在电脑端手动运行。
3. **会话已在线连接 (`isConnected: true`)**：
   - `canResume: false`，`canShowResume: false`，隐藏恢复栏。

## 测试验证方式

1. **单元测试**：
   - `packages/happy-app/sources/hooks/useSessionQuickActions.test.ts`：验证 `getResumeAvailability` 在 `agy` 会话存在 `agyConversationId` 且机器在线时返回 `canResume: true`。
   - `packages/happy-app/sources/utils/resumeCommand.test.ts`：验证 `buildResumeCommand` 与 `buildResumeCommandBlock` 正确生成 `happy agy --resume <conversationId>` 命令。
   - `packages/happy-cli/src/resume/handleResumeCommand.test.ts`：验证 CLI 端 `buildResumeLaunch` 映射 `flavor: "agy"` 到 `['agy', '--resume', conversationId]`。
2. **全量回归测试**：
   - `pnpm --filter happy-app test -- --run`
   - `pnpm --filter happy test`

## 变更记录

- `2026-08-24`:
  - 修复 `useSessionQuickActions.ts` 中 `hasBackendResumeId` 缺少 `session.metadata?.agyConversationId` 导致 iOS App 无法直接展示「Resume Session」按钮的问题。
  - 在 `SessionView.tsx`、`agentGoalStatus.ts` 以及 `resolveHappySession.ts` 中补充 `agyConversationId` / `agy` 相关的依赖与 schema 支持。
  - 新增 `useSessionQuickActions.test.ts` 测试套件覆盖 `agy`、`claude`、`codex` 恢复可用性判定。
