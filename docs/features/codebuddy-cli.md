# CodeBuddy CLI

Happy 可以在所选机器和目录中启动 CodeBuddy Code。机器上的 Happy CLI daemon 发现 PATH 中的 `codebuddy` 后，普通新建会话的 Agent 选择器会显示 **CodeBuddy**。

## 使用

1. 在运行 Happy daemon 的账号下确认 `codebuddy --version` 和 `codebuddy --help` 可用。运行 `codebuddy`，通过 `/login` 登录。
2. 在 Happy 新建会话中选机器、项目目录和 **CodeBuddy**，再发送首条消息。也可以在目标目录运行 `happy codebuddy`，然后从 Happy 向该会话发送消息。
3. 会话启动后，Happy 使用 CLI 通过 ACP 发布的模型、权限和推理选项。工具审批沿用 Happy 会话内的授权界面。

启动参数为 `codebuddy --acp --permission-mode default`。模型沿用本机 CLI 的配置。登录状态由本机 CodeBuddy 管理。 [CodeBuddy ACP 文档](https://www.codebuddy.cn/docs/cli/acp) · [CodeBuddy CLI 参考](https://www.codebuddy.cn/docs/cli/cli-reference)

Happy 显示 ACP 文本流，按原生 `session/prompt` 结果记录完成、失败或取消。登录过期的轮次会提示重新登录。停止当前轮次会发送 `session/cancel`。当 CLI 发布 `loadSession` 能力且原始会话仍存在时，**恢复会话**或 `happy resume <Happy session ID>` 会在原机器和目录中加载它。

## Happy 派活

在现有 worker 的 `launchOptions.agents` 中授权 `codebuddy`，并按连接授权的项目范围派活。`happy_options` 接收 `machineID`，在有能力且获授权的机器上返回 `codebuddy`。启动沿用本机 CLI 模型及默认权限，推理档位由 CLI 决定。使用授权中的 `projectID` 指定工作目录。

例如，先调用 `happy_create_task`。

~~~json
{
  "requestID": "example-create",
  "machineID": "authorized-machine",
  "projectID": "authorized-project",
  "options": { "agent": "codebuddy" }
}
~~~

取得 `sessionID` 后，用独立的 `requestID` 调用 `happy_send`。当前 CodeBuddy 派活支持授权目录及既有 worktree 路径。`read-only` 候选执行需要支持该权限档位的 Agent。 [Happy 派活协议](automation-control.md)

TestLoop 的 `src/happy-control-contract.ts` 和 `src/loop-contract.ts` 仍只接受 Claude、Codex 和 AGY。通过这些配置入口选用 CodeBuddy 需要 TestLoop 更新校验。

## 验证

本地构建 Happy CLI，启动 Expo Web 后，可运行以下命令。测试使用临时 relay、Happy daemon 和 ACP 夹具。

~~~sh
HAPPY_CODEBUDDY_WEB_ORIGIN=http://127.0.0.1:8989 \
  node packages/happy-app/scripts/codebuddy-session.e2e.mjs
~~~
