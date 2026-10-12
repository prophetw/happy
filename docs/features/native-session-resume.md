# 原生会话恢复：Claude 与 Codex

在 Claude 或 Codex 聊天中输入 `/resume`，Happy 会列出当前机器上对应智能体的原生会话，包括未通过 Happy 创建的会话。选择一条并确认后，在该会话原有的工作目录创建一个新的 Happy 会话，接入原有智能体会话、回填历史记录并跳转。

## 会话列表

- Claude：`claude-list-native-sessions` 读取宿主机的 Claude JSONL 会话，最多返回 100 条，按最近活动排序。
- Codex：`codex-list-native-sessions` 调用 Codex app-server 的 `thread/list`，读取最近 100 条非归档会话中的可恢复记录。显式包含 `cli`、`vscode`、`appServer` 来源，排除子智能体和临时会话，按最近活动排序。
- 两个机器 RPC 都接受可选的 `directory` 参数；弹窗展示这台机器上所有项目的会话，优先排列工作目录与当前聊天一致的会话，其余目录的会话随后展示，两部分各自保留最近活动优先的顺序。当前聊天缺少工作目录或没有同目录会话时，保留原有的最近活动排序。每条记录包含原生会话 ID、工作目录、Git 分支、预览、标题和毫秒时间戳。

## 恢复链路

`SessionView` 拦截 `/resume` 并打开 `ResumeNativeSessionSheet`。弹窗按当前会话的 `flavor` 请求对应机器 RPC，确认后调用 `spawn-happy-session`：

- Claude：传入 `agent: 'claude'` 和 `resumeClaudeSessionId`。
- Codex：传入 `agent: 'codex'` 和 `resumeCodexThreadId`。

Codex 恢复会话时，CLI 在 `thread/resume` 成功后才通过 `session-started` 通知 daemon 返回启动成功。恢复或连接失败时，通过本地 `session-startup-failed` 接口传回错误，弹窗保持打开并显示原因；普通进程和 tmux 启动均遵循此行为。

Daemon 使用已有的 `--resume` 启动参数和历史回填环境变量。Codex 运行器通过 `thread/resume` 恢复原线程，再通过 `thread/read` 和 `buildCodexThreadBackfillEnvelopes` 将历史记录同步到新 Happy 会话。此操作延续选中的原生线程，不创建 Codex 分叉。

## 边界与错误

机器必须在线且运行包含对应列表 RPC 的 Happy daemon。Codex 必须支持 app-server 的线程接口，并能访问相同 Codex 配置目录中的原会话。

缺少机器信息、列表请求失败或恢复启动失败时，弹窗显示错误。列表为空时显示当前智能体没有可恢复会话；未选择会话时禁用确认按钮。工作目录不存在时，现有启动流程处理目录错误。

如果原生 Codex 对话仍由其他终端或应用持有写入锁，`thread/resume` 会返回 `already has an active writer`。需要先在原终端或应用中关闭该对话、释放占用，再从 Happy 重试恢复；Happy 会提示此操作，保留原线程内容。

历史回填复用现有逻辑：缺失的本地图片会跳过，读取线程历史失败仍按现有运行器行为记录日志；因此恢复线程成功不等于全部历史附件都已回填。
