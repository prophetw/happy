# Happy Control REST API 使用说明

> **入口已变更（2026-11-07）**：旧 `https://szsp.suitbim.com.cn:7100` 入口已退役（现返回 410）。本文基址与示例已更新为当前 Tailscale 私网地址 `https://desktop-8ut4p0p.taild92624.ts.net`；文中的历史实测结论来自迁移前旧入口，当前线上版本仍需重新核对。

> 基址：`https://desktop-8ut4p0p.taild92624.ts.net/happy-control/v1`
> OpenAPI：`https://desktop-8ut4p0p.taild92624.ts.net/happy-control/v1/openapi.json`
> 线上版本：`1.7.0`（协议 1）
>
> 本文依据 2026-11-05 `main` 分支实现及线上实测结果整理。
> 需要鉴权的示例响应仅表示契约形状；实际字段以响应为准。
>
> **版本提示**：`GET /projects` 及所有授权详情的统一 `projects` 数组为 OpenAPI `1.7.0` 能力。启动选项（`/options`、`tasks.create` 的 `options`、授权白名单）为 `1.5.0` 能力；现网白名单为 Codex 已安装 8 模型 + `auto/safe-yolo/read-only/yolo`。带非默认模型或 yolo 的真实生产任务尚未做端到端实测；旧 worker/daemon 组合的行为见「5.1 创建空会话」。

`/happy-control/v1/` 根路径本身返回 `404 NOT_FOUND`，这是正常行为，不是服务未启动。请直接调用具体路由，或先用 `/compatibility` 做只读探活。

---

## 1. 这是什么

Happy Control 是 Happy 的**受控自动化 REST 接口**：获授权的外部后端或云助手，可以在明确批准的范围（机器、项目目录、方法、会话、期限）内：

- 查看获准的机器与会话；
- 创建一个专用 Codex 会话（空会话）；
- 向该会话发送指令；
- 读取状态、增量日志和指定轮次的结果；
- 请求取消任务；
- 按原始 `requestID` 查询持久回执。

它**不是**：

- 不是 Happy 账号登录接口，不能换取或操作账号主密钥；
- 不是任意 shell / 任意 RPC 执行接口；
- 不支持调用方指定工作目录；agent、模型、权限模式只能在 **owner 配置的允许清单**内选择（见 5.1 的启动选项），未配置清单时一律使用固定默认启动；
- 不是文件系统沙箱；项目范围约束的是控制入口和会话访问，执行代理仍遵循原有权限确认机制。

任务控制适配 **Codex 与 Claude 专用会话**（Claude 需要 worker 白名单显式允许，既有会话也需相应授权）；其他 agent 会返回 `UNSUPPORTED_AGENT`。

---

## 2. 核心概念

| 概念 | 说明 |
| --- | --- |
| Connection / Grant | 一次授权。包含 `id`（即 `grantID` / `connectionID`）、绑定的用户、machine、project、methods、sessionIDs、`expiresAt` 和状态。 |
| Service Token | 服务访问令牌，形如 `hsvc1.<connectionID>.<43位随机串>`。持有即可在批准范围内调用 REST，最长 30 天，不自动续期。 |
| Owner | Happy 账号本人。只有 owner 能在 Web 页面审批、撤销、删除连接记录、签发服务令牌。 |
| Worker | 运行在用户机器上的受信组件，只主动出站轮询，不需要开放入站端口。 |
| Machine | 授权绑定的一台机器，例如 `4090Wsl2`。 |
| Project | worker 上预登记的目录范围。创建任务时必须在授权项目列表中选择一个 `projectID`。 |
| Session | Happy 会话。服务授权默认只能访问由本 grant 新建的专用会话；既有会话必须在批准时显式列出。 |
| Task | 一次创建操作。`taskID` 就是创建时使用的 `requestID`，不是另一个独立 ID。 |
| `requestID` | 幂等键，1–128 位字母/数字/下划线/连字符。创建、发送、取消各用不同的稳定 ID。 |
| `turnID` | 一轮 agent 执行的标识，从日志的 `kind=turn` 消息中取得；不是发送请求的 `requestID`。 |
| `seq` / `cursor` | 日志与分页游标。日志用 `after_seq` 或 `cursor` 向前增量读取。 |

### 授权范围

一次授权固定包含：

- 一个 worker、一台 machine；
- 一个或多个 project：单项目旧格式用 `projectID`；多项目用 `scopeVersion: 2` + `projectIDs`（2–32 个）；目录授权用 `scopeVersion: 3` + `projectIDs/projects`（1–32 个）；
- 一组 method，常用值：
  - `machines.list`
  - `sessions.list`
  - `tasks.create`
  - `sessions.send`
  - `sessions.status`
  - `sessions.logs`
  - `sessions.result`
  - `sessions.cancel`
  - `requests.get`
  - `options.list`（v1.5.0 起，发现可选择的启动选项）
- 允许访问的既有 `sessionIDs`（可为空，默认只访问本 grant 新建的会话）；
- 可选的启动选项子集 `options`（v1.5.0 起）：按 agent 列出允许的 `models` / `permissionModes`，只能比 worker 白名单更窄，审批 digest 会绑定它；
- `expiresAt`（epoch 毫秒）。

多项目授权中的所有项目共用同一套 methods、期限和撤销状态；每个任务仍需明确指定一个 `projectID`。

> 多项目和目录授权格式目前仅用于**服务令牌授权**；签名客户端仍保持单项目 `projectID` 格式。目录授权的 `projectID` 是 `dir_<hash>` 形式的不透明 ID，应同时保存接口返回的 `directory` 供用户识别。

---

## 3. 准备：创建授权并获取服务令牌

服务令牌由 **Happy 用户本人在 Web 页面**创建，后端不需要、也不应该要求用户提供 Happy 密码或账号密钥。

### 3.1 用户操作

1. 打开并登录 Happy Web：
   - `https://desktop-8ut4p0p.taild92624.ts.net/happy/`
2. 进入“设置 → 账号 → 助手连接 → 为后端创建服务授权”：
   - `https://desktop-8ut4p0p.taild92624.ts.net/happy/settings/automation-service`
3. 选择已登记的服务身份、机器、项目、操作方法和有效天数。
   - 默认只读；需要执行任务时勾选“创建任务”“追加指令”，需要停止任务时勾选“取消任务”。
   - 当前线上服务授权最长 30 天，支持小数天数。
4. 点击“创建申请并审查权限”，核对实际目录、方法、会话范围、到期时间后，点击“确认批准以上权限”。
   - 待批准窗口最多 5 分钟，过期需重新申请。
5. 点击“生成服务访问令牌（仅交付一次）”，通过安全渠道交给后端密钥托管系统。

完整令牌只交付一次；服务端只保存摘要，离开页面后**无法再次查看**。如果丢失，可从旧连接进入“编辑并重新授权”，在预填配置上修改并创建替代申请；新申请创建成功后旧连接撤销，仍须再次明确批准并交付新令牌。目录需重新核实，旧 grant 的令牌和幂等回执不会转移。

撤销只阻断访问并保留连接历史；需要清理列表时，在连接详情确认“删除连接记录”。永久删除会先撤销仍有效的权限并清理服务令牌摘要，不会自动停止已运行任务或删除会话/回执。

### 3.2 后端需要保存的资料

| 资料 | 用途 |
| --- | --- |
| REST 基址 | `https://desktop-8ut4p0p.taild92624.ts.net/happy-control/v1` |
| 服务令牌 | 只放 secret provider，运行时注入 `Authorization` |
| connectionID / grantID | 核对授权、查询自身连接 |
| machineID、projectID 列表 | 创建任务时使用 |
| 允许的方法、会话范围、到期时间 | 核对边界、提前提醒重新授权 |

令牌交付时同时提供上述**非秘密资料**即可，令牌本身单独走安全渠道。

### 3.3 令牌使用方式

```http
Authorization: Bearer hsvc1.<connectionID>.<secret>
```

要求：

- 只放在请求头，禁止放在 URL / query；
- 只通过 HTTPS 调用，保留证书校验，禁止跟随重定向；
- 不写日志、不写 APM、不写工单正文、不截图；
- 不用于批准、延长授权或调用 owner / worker 接口；
- 令牌到期时间等于授权到期时间，没有 refresh token，也不会自动延期。

---

## 4. 快速验证

先做两个只读检查。

### 4.1 探活与兼容性（公开，无需令牌）

```bash
BASE=https://desktop-8ut4p0p.taild92624.ts.net/happy-control/v1

curl -sS "$BASE/compatibility"
```

当前线上返回：

```json
{
  "version": 1,
  "ok": true,
  "data": {
    "protocol": 1,
    "worker": 1,
    "core": 1,
    "approval": 1,
    "projectScopes": 1,
    "httpMcp": null,
    "auth": "ed25519-proof-v1",
    "serviceTokens": {
      "protocol": 1,
      "maxGrantMs": 2592000000,
      "oneTimeDelivery": true
    }
  }
}
```

说明：

- `maxGrantMs = 2592000000` 即 30 天；
- `projectScopes = 1` 表示支持多项目授权；
- `httpMcp = "streamable-http"` 表示当前部署已启用 HTTP MCP；2026-11-05真实 service-token MCP 联调已通过，服务令牌仍可调用同一 grant 下的 REST。

仓库内 Dot「MCP 工具」面板的 Happy Control 预设只包含 `url`。宿主声明 `capabilities.storedToken=1` 时，首选在掩码 `MCP Token` 字段填写 Token 本身（不含 `Bearer` 前缀），通过加密 `testloop-mcp-connections` RPC 传递 save `token` 字符串，明确清除已保存 Token 时传 `null`；宿主使用 workspace 密钥加密保存。JSON 中的 `bearer_token_env_var` 是可选兼容方式，用于引用宿主环境变量/secret provider，不是首选交付方式。隔离 fixture 不验证真实加密；真实 TestLoop storedToken、双跳 MCP、专用任务生命周期及撤权已于2026-11-05验收，详见 `.e2e-artifacts/mcp-live-20261105T111014Z/`。

### 4.2 核对自身授权

```bash
export HC_TOKEN='hsvc1.xxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
export HC_GRANT='<connectionID>'

curl -sS "$BASE/connections/$HC_GRANT" \
  -H "Authorization: Bearer $HC_TOKEN"
```

返回该连接的非秘密描述，包括绑定的 worker、machine、项目、methods、会话、状态和到期时间。服务令牌只能查询自身连接，不能枚举同一服务的其他 grant。所有 scope 版本都包含 `projects: [{ id, directory }]`；旧版单项目授权也会同时保留原 `projectID/projectDirectory` 字段。

### 4.3 查看获准项目（v1.7.0）

创建任务前直接调用：

```bash
curl -sS "$BASE/projects" \
  -H "Authorization: Bearer $HC_TOKEN"
```

响应：

```json
{
  "version": 1,
  "ok": true,
  "data": {
    "projects": [
      { "projectID": "project_demo", "directory": "/home/dev/code/project_demo" }
    ]
  }
}
```

`POST /tasks` 的 `projectID` 直接取这里的 `projects[].projectID`。接口只返回当前 grant 已批准的项目，不返回机器或账号上的其他项目；不需要额外的方法授权，也不调用 worker。每个 grant 最多 32 个项目，一次全部返回，不分页，也不接受 `limit/cursor` 参数。

### 4.4 查看机器

```bash
curl -sS "$BASE/machines?limit=100" \
  -H "Authorization: Bearer $HC_TOKEN"
```

契约形状：

```json
{
  "version": 1,
  "ok": true,
  "data": {
    "machines": [
      { "machineID": "machine_demo", "availability": "online_hint", "activeAt": 1762300000000 }
    ],
    "nextCursor": null
  }
}
```

`availability` 只是在线提示（`online_hint` / `offline_hint`），不是强一致状态。

---

## 5. 完整任务流程

### 5.1 创建空会话

```bash
curl -sS -X POST "$BASE/tasks" \
  -H "Authorization: Bearer $HC_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "requestID": "job_1001_create",
    "machineID": "machine_demo",
    "projectID": "project_demo"
  }'
```

注意：

- 必须指定**一个**获准的 `projectID`；
- 不能在创建请求里附带任务正文；
- `requestID` 在同一 grant 内必须唯一且稳定；同一 ID 配不同参数（包括不同的 `options`）会返回 `REQUEST_ID_CONFLICT`。

**可选启动选项（v1.5.0）**：body 可额外携带 `options`，四个字段都可省略，省略的字段使用 worker 默认值：

```json
{
  "requestID": "job_1001_create",
  "machineID": "machine_demo",
  "projectID": "project_demo",
  "options": { "agent": "codex", "model": "gpt-6-sol", "permissionMode": "yolo", "effort": "low" }
}
```

- 每个显式给出的值都必须同时在 **worker 白名单**和**本 grant 的 options 子集**内，否则返回 `OPTION_DENIED`，不会创建任何会话；
- `permissionMode: "yolo"`（Codex）/ `"bypassPermissions"`（Claude）等放权模式只有 owner 在白名单中显式列出才可用，调用方不能借此提权；
- 不传 `options` 时保持原固定默认启动（Codex + `gpt-6.1-sol` + `default` + `high`），旧调用方行为不变；
- worker 未配置白名单时，任何 `options` 覆盖都返回 `OPTION_DENIED`；daemon 不支持 options 能力时返回 426 `UNSUPPORTED_VERSION`；
- 成功响应的 `data.options` 回显完整解析后的启动选择（含默认值），可据此核对实际生效配置。

**发现可选项**：先调用 `GET /options?machineID=<绑定机器>`（需要 `options.list` 方法），返回已按本 grant 过滤的可选值和默认值，供用户选择：

```json
{
  "version": 1,
  "ok": true,
  "data": {
    "defaultAgent": "codex",
    "agents": [
      {
        "agent": "codex",
        "models": ["gpt-6.1-sol", "gpt-6-sol"],
        "permissionModes": ["default", "auto", "yolo"],
        "efforts": ["low", "medium", "high"],
        "defaultModel": "gpt-6.1-sol",
        "defaultPermissionMode": "default",
        "defaultEffort": "high"
      }
    ]
  }
}
```

`models` / `permissionModes` 为空数组表示该 agent 只能用默认启动（无白名单的旧 worker 即如此）；`defaultEffort` 为空字符串表示不向 CLI 传 effort 参数。模型目录来自 daemon 实际安装的 Codex/Claude 目录刷新，随安装变化。

成功响应示意：

```json
{
  "version": 1,
  "ok": true,
  "requestID": "job_1001_create",
  "data": {
    "requestID": "job_1001_create",
    "taskID": "job_1001_create",
    "machineID": "machine_demo",
    "sessionID": "session_demo",
    "state": "confirmed",
    "process": "running"
  }
}
```

`state=confirmed` 只表示会话创建已确认；是否真正开始执行，要继续看状态和日志。

### 5.2 发送指令

创建和发送是两个独立操作，使用不同的 `requestID`：

```bash
curl -sS -X POST "$BASE/sessions/session_demo/messages" \
  -H "Authorization: Bearer $HC_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "requestID": "job_1001_send_01",
    "text": "执行本测试项目内获准的任务，完成后说明结果。"
  }'
```

约束：

- `text` 长度 1–100000 字符；
- 该会话必须属于本 grant，或由本 grant 新建；
- 首次发送前应确认创建回执里已有明确的 `sessionID`。

成功响应示意：

```json
{
  "version": 1,
  "ok": true,
  "requestID": "job_1001_send_01",
  "data": {
    "requestID": "job_1001_send_01",
    "machineID": "machine_demo",
    "sessionID": "session_demo",
    "state": "submitted",
    "messageID": "message_demo",
    "seq": 12
  }
}
```

`submitted` 只表示消息已持久写入 Happy，**不证明 agent 已消费、已开始或已完成**。

### 5.3 查询状态

```bash
curl -sS "$BASE/sessions/session_demo/status?after_seq=0&limit=100" \
  -H "Authorization: Bearer $HC_TOKEN"
```

响应示意：

```json
{
  "version": 1,
  "ok": true,
  "data": {
    "sessionID": "session_demo",
    "process": "running",
    "turn": { "messageID": "msg_1", "seq": 10, "kind": "turn", "turnID": "turn_1", "state": "running" },
    "waitingForPermission": false,
    "messages": [],
    "nextCursor": 12,
    "hasMore": false
  }
}
```

关键字段：

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `process` | `running` / `stopping` / `stopped` / `unknown` | 进程状态，与 turn 结果分开 |
| `turn.state` | `running` / `completed` / `failed` / `cancelled` / `unknown` | 当前轮次证据 |
| `waitingForPermission` | boolean | `true` 时需用户在 Happy 中处理权限，令牌不能自动跳过 |
| `messages` | 数组 | 脱敏投影，见 5.4 |
| `nextCursor` | number | 下一次增量读取的游标 |
| `hasMore` | boolean | 是否还有更多 |

也可以按 `taskID` 查询（`taskID` 就是创建操作的 `requestID`）：

```bash
curl -sS "$BASE/tasks/job_1001_create" \
  -H "Authorization: Bearer $HC_TOKEN"
```

### 5.4 增量日志

```bash
curl -sS "$BASE/sessions/session_demo/events?after_seq=0&limit=100" \
  -H "Authorization: Bearer $HC_TOKEN"
```

- `after_seq` 与 `cursor` 不能同时传；
- 保存返回的 `nextCursor`，`hasMore=true` 时继续读取；
- 服务端可能把单页上限收窄到 100 条，即使请求了更大的 `limit`；
- 日志是脱敏投影：不返回思考过程、工具参数/结果、任意 metadata 和密钥；
- 消息类型：
  - `kind=turn`：轮次开始/结束；
  - `kind=text`：可见文本，每条最多 16000 字符，超出时 `truncated=true`；
  - `kind=omitted`：被省略的消息，仍会推进 `seq`。

### 5.5 查询指定轮次的最终结果

先从日志中找到 `kind=turn` 且带 `turnID` 的消息，再查询：

```bash
curl -sS "$BASE/sessions/session_demo/result?turnID=turn_1&after_seq=0&limit=100" \
  -H "Authorization: Bearer $HC_TOKEN"
```

响应示意：

```json
{
  "version": 1,
  "ok": true,
  "data": {
    "sessionID": "session_demo",
    "turnID": "turn_1",
    "attribution": "session_turn_only",
    "ready": true,
    "outcome": "completed",
    "messages": [],
    "nextCursor": 12,
    "hasMore": false
  }
}
```

- `ready=true` 才表示当前分页已观察到该 turn 的终态；
- `outcome` 为 `completed` / `failed` / `cancelled`；
- 没有终态证据时 `outcome=unknown`、`ready=false`，不能自行判定成功；
- `attribution=session_turn_only` 表示结果归因于会话轮次，不归因于某次发送的 `requestID`；
- 完整文本需要累计分页并按 `seq` / `messageID` 去重。

### 5.6 请求取消

```bash
curl -sS -X POST "$BASE/sessions/session_demo/cancel" \
  -H "Authorization: Bearer $HC_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{ "requestID": "job_1001_cancel" }'
```

响应示意：

```json
{
  "version": 1,
  "ok": true,
  "requestID": "job_1001_cancel",
  "data": {
    "requestID": "job_1001_cancel",
    "machineID": "machine_demo",
    "sessionID": "session_demo",
    "state": "cancel_requested",
    "process": "stopping"
  }
}
```

`cancel_requested` 只表示取消请求已受理，**不证明进程已停止**。之后要查询：

```bash
curl -sS "$BASE/requests/job_1001_cancel" -H "Authorization: Bearer $HC_TOKEN"
curl -sS "$BASE/sessions/session_demo/status" -H "Authorization: Bearer $HC_TOKEN"
```

只有明确看到 `process=stopped` 才能报告“已停止”。`stopping`、`unknown` 或仅收到 kill ack 都不能算停止。

### 5.7 按原 requestID 查询回执

```bash
curl -sS "$BASE/requests/job_1001_create" \
  -H "Authorization: Bearer $HC_TOKEN"
```

返回该请求的持久回执，不会重新派发操作。用于：

- 网络超时、连接中断后核实结果；
- 202 `UNAVAILABLE_OR_UNKNOWN` 后确认是否已经执行；
- 核对创建是否已有 `sessionID`。

---

## 6. 响应信封与状态语义

所有 JSON 响应都是 version 1 envelope：

```json
{ "version": 1, "ok": true, "data": { } }
```

```json
{ "version": 1, "ok": false, "error": { "code": "SCOPE_DENIED", "retryable": false } }
```

修改类操作的成功响应还会带顶层 `requestID`。判断结果必须同时看：

1. HTTP 状态码；
2. `ok`；
3. `error.code`；
4. `data.state` / `data.process` / `data.ready` 等领域字段。

### 状态含义

| 值 | 含义 | 不能推断什么 |
| --- | --- | --- |
| `pending` | 回执尚未确认 | 不能推断失败 |
| `confirmed` | 创建操作已确认 | 不能推断任务已完成 |
| `submitted` | 消息已持久化 | 不能推断 agent 已消费 |
| `cancel_requested` | 取消请求已受理 | 不能推断进程已停止 |
| `unavailable` | 当前不可用 | 不代表从未执行 |
| `unknown` | 证据不足 | 不能当作成功或失败 |
| `process=stopped` | 有停止证据 | 不代表该 turn 一定有 `cancelled` 结果 |

---

## 7. 错误码与处理

| HTTP | code | 含义 / 处理 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 请求体/参数不合法；修正后再调用 |
| 400 | `INVALID_CURSOR` | 游标格式错误；使用服务端返回的 `nextCursor` |
| 401 | `AUTH_REQUIRED` | 缺少凭据 |
| 401 | `INVALID_SERVICE_TOKEN` | 令牌格式错误、摘要不匹配或已失效；检查 secret provider，不要打印令牌 |
| 401 | `OWNER_AUTH_REQUIRED` | owner 接口需要 Happy 登录，不是给后端用的 |
| 403 | `OWNER_ORIGIN_REQUIRED` | owner 接口只允许同源 Web 请求 |
| 403 | `SCOPE_DENIED` | 方法、机器、项目或会话不在批准范围 |
| 403 | `OPTION_DENIED` | v1.5.0：启动选项不在 worker 白名单或本 grant options 子集内，或模型/effort 不在当前目录中；改用 `GET /options` 返回的可选值 |
| 403 | `GRANT_NOT_APPROVED` | 授权尚未批准 |
| 403 | `GRANT_EXPIRED` | 授权已到期；请用户重新授权，不能自动续期 |
| 403 | `GRANT_REVOKED` | 授权已撤销；停止调用 |
| 403 | `SERVICE_TOKENS_DISABLED` | 服务令牌模式未启用 |
| 404 | `NOT_FOUND` | ID 不存在，或不属于当前 grant |
| 409 | `REQUEST_ID_CONFLICT` | 同一 `requestID` 使用了不同参数；停止并核对业务映射，不能换 ID 掩盖 |
| 409 | `SERVICE_TOKEN_ALREADY_ISSUED` | 令牌已交付过，不能重复读取；撤销后重新创建 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体过大 |
| 426 | `WORKER_PROJECT_SCOPE_UPGRADE_REQUIRED` | 在线 worker 不支持多项目；降级为单项目或更新 worker |
| 429 | `RATE_LIMITED` | 触发限流；有界退避 |
| 503 | `WORKER_UNAVAILABLE` | worker 离线/未轮询，附带 `dispatch: not_sent`；恢复后用**同一个 `requestID` 和相同正文**重试，或先查询 |
| 503 | `MACHINE_UNAVAILABLE` | 机器当前不可用 |
| 503 | `STORE_UNAVAILABLE` | 控制端存储异常；重试前先核实原请求 |
| 400/503 | `UNAVAILABLE_OR_UNKNOWN` | 结果不确定；保存原 `requestID`，用 `GET /requests/{id}` 核实，**禁止换新 ID 盲目重派** |

补充：

- HTTP `202` 表示“修改结果不确定”；响应体仍是 `ok:false` + `UNAVAILABLE_OR_UNKNOWN`，必须按原 `requestID` 回查。
- `TASK_NOT_CONFIRMED`：`taskID` 存在但会话尚未确认；先查询创建回执。
- `TARGET_CONFLICT`：请求中的 `taskID` 与 `sessionID` 不一致；停止并核对。
- `UNSUPPORTED_AGENT`：目标会话不是当前支持的 Codex/Claude 会话。
- `UNSUPPORTED_VERSION`（426）：worker/daemon 版本不支持所请求能力（例如 options 发现或带覆盖的创建）；升级或保持默认启动。
- 401 区分“缺少凭据”和“凭据无效”；403 区分范围、到期、撤销；409 区分参数冲突和批准/签名重放。

---

## 8. 幂等、超时与重试

### 幂等规则

- 幂等命名空间：同一 client / grant 下的 `requestID`。
- 同一业务动作始终复用同一个 ID；
- 创建、每次追加、取消使用不同的稳定子 ID；
- 多项目授权下 `requestID` 仍在整个 grant 内唯一，不能跨项目复用；
- 重新授权后不会沿用旧 grant 的去重记录。

推荐命名：

```text
<jobID>_create
<jobID>_send_01
<jobID>_send_02
<jobID>_cancel
```

### 超时处理

网关等待 worker 的调度超时默认为约 15 秒（部署可配置）。超时不代表操作未执行，按下面的规则处理：

| 场景 | 处理 |
| --- | --- |
| 请求超时 / 连接中断（修改类） | 保存原 `requestID`，先 `GET /requests/{requestID}` 核实；不确定时不要换新 ID 重派 |
| HTTP 202 / `UNAVAILABLE_OR_UNKNOWN` | 同上 |
| `WORKER_UNAVAILABLE` + `dispatch:not_sent` | 没有派发；可稍后用相同 `requestID` 和相同正文重试 |
| 查询类超时 | 只读接口可退避重试 |
| 429 | 有界退避，降低并发和轮询频率 |

### 轮询建议

- 不要在未核对前一轮结果时并发发送多个需要精确归因的任务；
- 同一会话建议串行发送；
- 日志按 `nextCursor` 增量拉取，不要每次从 0 重扫；
- 结果按 `seq` / `messageID` 去重累计；
- 缺少终态证据时继续观察，不要把“没查到”写成“已完成”或“已失败”。

---

## 9. 限制与约束

| 项目 | 当前限制 |
| --- | --- |
| 服务令牌有效期 | 最长 30 天，从申请时计算，批准/交付不延期 |
| 待批准窗口 | 最多 5 分钟 |
| 授权项目数 | 单项目旧格式 1 个；多项目 2–32 个 |
| 每任务项目 | 每次 `POST /tasks` 只能指定一个获准 `projectID` |
| 指令文本 | 1–100000 字符 |
| 单条日志文本 | 最多 16000 字符，超出 `truncated=true` |
| 普通请求体 | 最大 256 KiB |
| 分页 | machines/sessions 单页最多 200；日志/状态/结果请求最多 500，服务端可能收窄到 100 |
| 限流 | 服务身份约 240 次/分钟；单 IP 约 12000 次/分钟（以部署配置为准） |
| 支持的 agent | Codex、Claude 专用会话（Claude 需 worker 白名单允许；其他 agent 返回 `UNSUPPORTED_AGENT`） |
| 启动选项 | 仅 worker 白名单与 grant options 子集内的值；未配置白名单时仅固定默认启动 |
| 离线排队 | 不支持；worker 离线时返回 `WORKER_UNAVAILABLE` |
| 权限确认 | `waitingForPermission=true` 时必须由用户在 Happy 中处理 |

---

## 10. 安全注意事项

1. 令牌只注入 `Authorization`，运行时从 secret provider 读取；不要写入源码、配置文件、URL、聊天或日志。
2. 关闭对 `Authorization`、请求/响应正文、错误原文的普通日志与 APM 捕获。
3. 固定 HTTPS origin，保留证书校验，禁止重定向到其他站点。
4. 服务令牌不是 OAuth JWT，不要填进 OAuth MCP 字段。它只能用于 REST 或显式启用的 `service-token-v1` MCP；当前部署已启用该模式并完成专用联调，但仍不代表任意第三方平台已注册。
5. 撤销和永久删除连接都只阻断后续访问，**不会自动停止已经运行的任务**。需要停止时，先在仍有效的授权下请求取消并确认 `stopped`，再撤销；若怀疑凭据泄漏，优先撤销，再在 Happy 中处理运行中的任务。
6. 项目范围不是 OS 文件沙箱；已获准的 agent 仍使用其原有系统权限和权限确认流程。
7. 业务后端应保存 `grantID / requestID / taskID / sessionID / cursor / turnID` 的映射，避免跨授权猜测或复用 ID。

---

## 11. 常见问题

| 现象 | 排查 |
| --- | --- |
| 打开 `/happy-control/v1/` 返回 404 | 正常；根路径没有页面，使用 `/compatibility` 或具体路由 |
| 401 `INVALID_SERVICE_TOKEN` | 检查令牌是否完整、是否只放请求头、secret provider 是否读到了期望值；无法恢复时撤销重建 |
| 403 `GRANT_EXPIRED` / `GRANT_REVOKED` | 请用户重新审查并批准新授权；不要尝试自动续期或复用旧令牌 |
| 403 `SCOPE_DENIED` | 方法、机器、项目或会话不在批准范围；不能通过改路径或伪造 ID 绕过 |
| 503 `WORKER_UNAVAILABLE` | worker/机器离线；没有离线队列，恢复后再调用 |
| 202 / `UNAVAILABLE_OR_UNKNOWN` | 可能已经执行；先按原 `requestID` 查询回执 |
| 409 `REQUEST_ID_CONFLICT` | 同一 ID 被用于不同参数；停止并修正业务映射 |
| 426 项目范围升级 | 在线 worker 不支持多项目；改用单项目或更新 worker |
| 令牌显示已交付但手上没有 | 完整值无法读回；撤销连接，重新申请、批准、交付 |
| 只能选一个项目 / 多选不可用 | 检查新版 Web、服务身份和在线 worker 是否报告 `projectScopes=1` |
| 创建成功但没有输出 | 查看 `waitingForPermission`、`process` 和 `events`；`confirmed` 不等于完成 |

---

## 12. 接口速查

所有路径相对 `/happy-control/v1`。

| 操作 | 方法与路径 | 需要批准的方法 |
| --- | --- | --- |
| 探活/兼容性 | `GET /compatibility` | 公开 |
| 协议文档 | `GET /openapi.json` | 公开 |
| 核对自身授权 | `GET /connections/{grantID}` | 有效服务令牌 |
| 列获准项目 | `GET /projects` | 有效已批准授权；只读自身项目范围 |
| 能力探测 | `GET /capabilities` | `machines.list` |
| 列机器 | `GET /machines?limit=100` | `machines.list` |
| 列会话 | `GET /sessions?limit=100` | `sessions.list` |
| 创建空任务会话 | `POST /tasks` | `tasks.create` |
| 发送指令 | `POST /sessions/{sessionID}/messages` | `sessions.send` |
| 按原 ID 查回执 | `GET /requests/{requestID}` | `requests.get` |
| 查询任务状态 | `GET /tasks/{taskID}` 或 `GET /sessions/{sessionID}/status` | `sessions.status` |
| 增量日志 | `GET /sessions/{sessionID}/events?after_seq=0&limit=100` | `sessions.logs` |
| 指定轮次结果 | `GET /sessions/{sessionID}/result?turnID={turnID}` | `sessions.result` |
| 请求停止 | `POST /sessions/{sessionID}/cancel` | `sessions.cancel` |

以下端点仅供用户 Web 审批或内部 worker 使用，后端不应调用：

- `GET /connections`、`GET /connections/{id}/consent`、`POST /connections/{id}/approve`、`DELETE /connections/{id}`
- `GET /service-connections/options`、`POST /service-connections`、`POST /connections/{id}/service-token`
- `POST /worker/poll`、`POST /worker/check`、`POST /worker/result`

---

## 附录 A：签名客户端模式（仅运维接入）

除服务令牌外，控制端还支持 Ed25519 持有证明，用于操作方预注册的受管 connector。此模式**不能自助开通**：client/worker 公钥必须提前登记在控制进程配置中，私钥由平台 secret provider 托管。

请求头格式：

```http
Authorization: HappyProof client.<clientID>.<grantID或->.<毫秒时间戳>.<nonce>.<base64url签名>
```

签名内容：

```text
happy-control-v1
client
<clientID>
<grantID 或空>
<毫秒时间戳>
<nonce>
<HTTP_METHOD>
<完整 path + query>
<sha256(canonical JSON body)>
```

约束：

- 时间窗口 ±30 秒；
- `nonce` 一次性，重启不重置重放保护；
- 签名覆盖完整路径和 query，反代不得重写；
- 私钥、签名头、owner Bearer 都不能放入 URL、聊天或日志。

操作方可通过受管的 `happy-control-call` 入口调用同一契约；它不是公开 SDK，也不接受任意 URL、私钥或 shell 参数。

## 附录 B：参考

- 线上 OpenAPI：`https://desktop-8ut4p0p.taild92624.ts.net/happy-control/v1/openapi.json`
- Happy Web：`https://desktop-8ut4p0p.taild92624.ts.net/happy/`
- 服务授权创建页：`https://desktop-8ut4p0p.taild92624.ts.net/happy/settings/automation-service`
- 连接管理与撤销：`https://desktop-8ut4p0p.taild92624.ts.net/happy/settings/automation`
- 仓库内架构与安全边界（clever-ocean 分支）：`docs/features/automation-control.md`
- 仓库内用户/后端接入说明（clever-ocean 分支）：`docs/features/automation-service-access.md`
