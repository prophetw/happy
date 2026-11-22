# CodeBuddy CLI

Happy 可以在所选机器和目录中启动 CodeBuddy Code。机器上的 Happy CLI daemon 发现 PATH 中的 `codebuddy` 后，普通新建会话的 Agent 选择器会显示 **CodeBuddy**。

## 使用

1. 在运行 Happy daemon 的账号下确认 `codebuddy --version` 和 `codebuddy --help` 可用。运行 `codebuddy`，通过 `/login` 登录。
2. 在 Happy 新建会话中选机器、项目目录和 **CodeBuddy**。模型和权限菜单显示所选机器的 CLI 通过 ACP 发布的选项。也可以在目标目录运行 `happy codebuddy`，然后从 Happy 向该会话发送消息。
3. 会话启动后，Happy 使用 CLI 通过 ACP 发布的模型、权限和推理选项。工具审批沿用 Happy 会话内的授权界面。

启动参数为 `codebuddy --acp --permission-mode default`。发送首条消息前，Happy 通过 ACP 应用所选的模型和权限。默认模型沿用本机 CLI 的配置，默认权限为询问。探测目录期间无需发送消息，登录状态由本机 CodeBuddy 管理。 [CodeBuddy ACP 文档](https://www.codebuddy.cn/docs/cli/acp) · [CodeBuddy CLI 参考](https://www.codebuddy.cn/docs/cli/cli-reference)

Happy 显示 ACP 文本流，按原生 `session/prompt` 结果记录完成、失败或取消。登录过期的轮次会提示重新登录。停止当前轮次会发送 `session/cancel`。当 CLI 发布 `loadSession` 能力且原始会话仍存在时，**恢复会话**或 `happy resume <Happy session ID>` 会在原机器和目录中加载它。

## Happy 派活

### 同一机器上的 Dot 共用 CodeBuddy 目录

Dot 通过目标机器的 Worker 读取该机 CodeBuddy 登录账号的 ACP 目录。新连接及继承机器策略的已有连接在普通项目授权完成后即可使用。模型增删会在机器刷新目录后反映到 `happy_options` 和创建校验中。连接仍须有相应项目、方法和执行器授权。所有者明确保存的 `options.agents` 继续限制执行器、模型和权限，包括空列表对覆盖值的限制。

在同一机器的 Control 注册及本地 Worker 注册的 `launchOptions.agents` 中，已获准使用 CodeBuddy 的条目采用 `{"agent":"codebuddy","modelSource":"machine","models":[],"permissionModes":["default","bypassPermissions"]}`。可派发的权限是机器策略与原生能力的交集。用户在本轮消息选 **Yolo** 后，Dot 才将其映射为 `bypassPermissions`。普通 **Default** 消息沿用默认权限。其他执行器保留各自的策略。 [注册片段](../../deploy/automation/site-99-55/dynamic-model-catalog.fragment.json.example)

从旧的逐连接开关切换时，只更新目标机器的 CodeBuddy 注册条目并移除 `launchOptions.allowCodeBuddyApproval`，保留其他条目和连接记录。旧的 `codebuddyLaunch` 是在机器基础上追加能力的记录。旧客户端关闭两项时会删除该记录，与从未设置的连接无法区分。这些连接继承机器策略。需要长期收窄的范围由显式的 `options.agents` 表达。只有保留旧开关策略的机器仍展示逐连接追加授权的按钮。

在现有 Worker 的 `launchOptions.agents` 中授权 `codebuddy`，并按连接授权的项目范围派活。`happy_options` 接收 `machineID`，`agents` 中的 CodeBuddy 条目列出机器与连接均允许的启动选项。`default` 模型沿用该机器的 CLI 配置。可以用 `options.model` 或 `options.permissionMode` 选择获准的创建覆盖值，Happy 通过 ACP 确认后报告会话就绪。省略推理档位时由 CLI 决定。使用授权中的 `projectID` 指定工作目录。

`happy_options.data.codebuddy` 仅在得到 ACP 探测结果时出现，包含获准模型和探测会话的默认模型。每个模型的 `effortOptions` 与 `maxInputTokens` 来自 CLI 公布的模型元数据，后者是只读输入上限。`sessionEffort` 和 `contextWindow` 仅在探测会话选中的模型公布对应选择器时出现。Happy 创建接口当前没有 CodeBuddy 推理、上下文或自动压缩参数。`--autocompact` 由 CodeBuddy CLI 管理，表示自动压缩基准。缺少探测结果时，目录退回默认启动选项。 [CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp) · [CodeBuddy CLI 设置](https://www.codebuddy.cn/docs/cli/settings)

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

## 验证

本地构建 Happy CLI，启动 Expo Web 后，可运行以下命令。测试使用临时 relay、Happy daemon 和 ACP 夹具。

~~~sh
HAPPY_CODEBUDDY_WEB_ORIGIN=http://127.0.0.1:8989 \
  node packages/happy-app/scripts/codebuddy-session.e2e.mjs
~~~
