# Happy 服务授权：用户创建与业务后端接入

适用：业务后端通过 REST 控制获准的 Happy 机器、项目和专用会话。2026-11-04 目录选择版 REST、Web 和4090受信worker已部署，可在 `/home/dev/code` 内浏览并选择具体目录，原两个隔离项目登记保留。本文说明用户如何审查授权、后端如何调用；真实新目录授权及其后端任务仍待本人批准和验收。

## 先了解交给业务方的是什么

用户用自己的 Happy 账号登录、选择范围并批准，随后生成一枚独立的**服务访问令牌**。业务后端持有它，即可在批准范围内调用 REST，无需登录 Happy、安装 Happy CLI 或取得用户的账号密钥。

服务令牌不是 Happy 网页登录凭据、账号主密钥或可反复兑换的授权码。它本身就是凭据，最长有效 30×24 小时；从申请时计算，批准或生成令牌不会延期。用户可随时撤销；本版没有自动续期、refresh token 或重新查看完整令牌的接口。

每个业务后端应使用独立服务身份和独立授权。当前页面中的“后端联调测试”是已登记的测试身份，不应让多个正式业务方共用。新业务方先把服务名称及所需机器、项目、操作范围交给 Happy 操作方登记；这一步不需要提供用户密码或密钥。用户随后在页面批准具体授权，登记本身不会获得执行权限。

## 用户：在 Happy Web 创建授权

### 入口

- Happy Web：<https://szsp.suitbim.com.cn:7100/happy/>
- 创建服务授权：<https://szsp.suitbim.com.cn:7100/happy/settings/automation-service>
- 管理、查看、撤销和删除连接记录：<https://szsp.suitbim.com.cn:7100/happy/settings/automation>

从界面进入：**设置 → 账号 → 助手连接 → 为后端创建服务授权**。未登录时先按现有 Happy 流程登录，再重新打开创建链接；扫码登录账号和批准服务授权是两个独立步骤。

### 创建、批准与交付

1. **选择服务身份。** 当前联调选择“后端联调测试”；正式对接选择为该业务方登记的专用身份。如果列表中没有，不要把其他服务的令牌转交给它，先联系操作方登记。
2. **选择机器和项目目录。** 当前 Web 可在同一机器下勾选多个已登记项目，共用一次授权和一枚令牌；默认仅勾选第一个，允许取消，至少选一个、最多32个。当前线上登记 `4090Wsl2` 的 `automation-test`（`/home/dev/code/happy-automation-test`）及 `automation-test-b`（`/home/dev/code/happy-automation-test-b`）；不会因为支持多选就自动获得其他目录。也可按下方“浏览机器目录并多选”流程选择 `/home/dev/code` 内的具体目录；不能增加机器或超出操作方允许的根目录。
3. **选择操作。** 默认只读；需要执行任务时额外勾选“创建任务”和“追加指令”，需要停止任务时另选“取消任务”。保留“查询回执、查看状态、读取日志、读取结果”才能可靠观察任务。默认只含本授权新建的专用会话，不包含你的日常或其他授权创建的会话。
4. **填写有效天数。** 当前部署最多 30 天。首次联调建议较短时限，例如填写 `0.04` 天，约 58 分钟；本页支持小数天数。
5. 点击 **“创建申请并审查权限”**。这只生成待批准申请，尚无访问权。若页面提示创建结果未确认，先回连接记录核实，不要连续重复创建。
6. 在审查页核对服务身份、机器、每个勾选项目的实际目录、精确操作、会话范围和到期时间，点击 **“确认批准以上权限”**。待批准窗口最多 5 分钟，过期需重新申请。
7. 点击 **“生成服务访问令牌（仅交付一次）”**，再按需“显示服务令牌”或“复制服务令牌”，通过双方约定的安全渠道交给业务后端的密钥托管系统。

期限计算：创建页提交所选时长 `expiresInMs`（正整数毫秒），由服务端计算并冻结 `expiresAt`，避免浏览器时钟稍快时默认30天被误判为超限。创建接口仍兼容旧 `expiresAt`，但不能同时传两个字段；部署上限、单独批准与令牌到期规则保持不变。上线顺序为先更新REST，再更新Web；旧REST不接受新时长字段。此调整不涉及worker升级。

完整令牌只交付一次。服务端仅保存摘要；离开页面、切到后台或切换账号会清除页面中的凭据，无法通过连接记录重新找回。不要在交付前切换页面；已明确复制到系统剪贴板的内容不由 Happy 清理。若丢失、响应超时或显示“已交付”，可从旧连接进入“编辑并重新授权”，保留原配置作为预填后创建替代申请、再次批准并交付新令牌；不能反复点击尝试补发旧令牌。

令牌不得放入聊天、工单正文、URL、源码、截图或普通日志。交付时同时提供以下**非秘密资料**，令牌单独走安全渠道：

| 资料 | 用途 |
| --- | --- |
| REST 基址 | `https://szsp.suitbim.com.cn:7100/happy-control/v1` |
| 连接 ID（connectionID / grantID） | 核对授权、查询自己的连接；ID 本身不授予权限 |
| machineID、获准的 projectID 列表 | 从批准页详情记录；每次创建任务指定列表中的一个 projectID |
| 项目实际目录、允许的方法、会话范围 | 供业务方核对边界；当前测试项目为 `automation-test`、`automation-test-b` |
| 到期时间 | 由后端提前提醒用户重新授权，不自动续期 |
| 密钥托管引用 | 后端自己的 provider/reference 名称，不含令牌值 |

同一授权中的所有项目共用操作权限、到期时间和撤销状态；若某个项目需要不同权限或期限，请另建授权。已批准的旧令牌不会扩大范围；新增目录需重新审查批准，可用一次新的多项目授权替代原先多个单项目授权。

项目范围约束任务入口和会话访问，**不是操作系统文件沙箱**；执行代理仍遵循原有权限确认机制。控制组件会处理批准范围内的指令与结果；Happy 账号加解密能力仍由 4090Wsl2 受信 worker 持有，relay 继续存转密文。

### 浏览机器目录并多选（已部署，待本人授权验收）

新版复用 Happy 已有机器目录选择器。本次已获本人授权，在REST和worker两端为同一机器启用 `directorySelection.roots=["/home/dev/code"]`，允许在其中挑选具体项目。根目录仅限定可选择范围，不直接授予整个目录树访问权；不启用时保留现有预登记项目列表。

页面选择服务和机器后：

1. 点击“选择目录”浏览该机器，选择一个具体目录加入本次列表；重复选择即可添加多个，也可输入绝对路径后点击“添加目录到本次选择”。可以移除已选项，最多32个。
2. 点击“让 Worker 核实所选目录”。在线worker通过既有出站签名通道核对目录存在、是目录、真实路径及允许范围。页面展示核实后的真实路径；符号链接最终指向范围外、目录不存在、文件、路径穿越或直接选择根目录均拒绝。相同真实目录不能重复选择。
3. 两分钟内点击“创建申请并审查权限”；选择变化需重新核实。申请不改变全局项目注册配置，也不获得执行权限。
4. 批准页逐个展示实际目录，批准时再核实一次；本人确认后才可一次性交付服务令牌。具体 `projectID` 以本次批准详情为准，新增目录自动得到稳定路径ID，业务调用仍须明确指定其中一个项目。

这一版本需要REST和在线worker均宣告 `directoryScopes=1`，并使用能明确批准 `scopeVersion=3` 的新版Web。旧端只能使用原预登记项目流程；不能省略核实或退回“第一个目录”。既有令牌不扩大范围，目录选择记录不是API凭据。项目范围不是OS文件沙箱，不防范已获准代理使用其原有系统权限；敏感项目仍需遵循原有权限确认机制。

本次已部署三端并应用上述根目录政策，原A/B列表和旧授权保持不变。40项线上匿名页面检查通过；真实用户的E2EE目录RPC、v3批准和业务后端任务仍待本人验收。未替本人创建真实grant/token，原生App/OTA未发布。

### 在手机 App 中怎么操作

当前已经发布的是 Web 页面；本功能的原生 App 页面源码已有，**尚未发布到手机安装包或 OTA**，不能假设现有 App 菜单已有上述入口。

当前可用方法：在手机浏览器打开同一创建链接，完成 Happy Web 登录，再在浏览器内创建和批准。若账号登录需要手机 App 扫码，按既有账号登录流程完成，然后回到 Web 操作；账号扫码不会自动批准服务。

后续原生版本包含本功能并通过发布验收后，才可在 App 使用“设置 → 账号 → 助手连接 → 为后端创建服务授权”的同一流程。专用 `happy:///automation?...` 二维码只供支持该协议的新版本审查连接，不能要求旧 App 通过扫码获得这项新功能。本文档变更不包含 App 发布。

## 业务方：后端如何调用

### 接入条件

- 后端能通过 HTTPS 访问上面的 REST 基址，保留证书校验，禁止把令牌放在 query 中或跟随重定向转交给其他站点。
- 由后端 secret provider 在运行时注入服务令牌到 `Authorization` 请求头；前端页面、浏览器存储和 Happy 账号登录态不作为业务 API 凭据。
- 保存业务任务与 `grantID / requestID / taskID / sessionID / cursor / turnID` 的映射，所有修改操作先持久化 requestID。
- 4090Wsl2 受信 worker、机器和 relay 可用。worker 仅主动出站，业务方不需要访问 4090 的入站端口。

公开接口契约：[线上 OpenAPI](https://szsp.suitbim.com.cn:7100/happy-control/v1/openapi.json)、[仓库 OpenAPI](../api/automation-control.openapi.json)。公开 `GET /compatibility` 应宣告 `serviceTokens.protocol=1`。当前部署已于2026-11-05启用 `service-token-v1` MCP，真实双跳反代、storedToken、只读及完整任务/取消/撤权联调通过；证据见仓库 `.e2e-artifacts/mcp-live-20261105T111014Z/`。

代码同时支持显式 `service-token-v1` HTTP MCP 模式：在 host 已有 `serviceTokens` 配置后加入 `mcp: { "mode": "service-token-v1" }`，客户端连接同一 origin 的 `/happy-control/mcp`。Dot 的「MCP 工具」面板可使用「Happy Control 配置示例」，预设 JSON 只保存 URL。宿主声明 `capabilities.storedToken=1` 时，首选在掩码字段填写 Token 本身（不含 `Bearer` 前缀），通过加密 `testloop-mcp-connections` RPC 传递 save `token` 字符串或明确清除时的 `null`，由宿主使用 workspace 密钥加密保存；`bearer_token_env_var: "HAPPY_CONTROL_SERVICE_TOKEN"` 仍可作为环境变量/secret provider 注入的可选兼容方式。MCP 与 REST 共用同一 grant、项目/机器/方法/会话范围和撤销/到期语义，但服务令牌不是 OAuth JWT，不能用于原 OAuth MCP。真实宿主支持、真实加密和线上反代已于2026-11-05完成专用范围联调；撤权后访问拒绝，测试凭据已清理。

### 调用顺序与接口速查

以下路径均相对于 `/happy-control/v1`，鉴权由后端安全注入，示例不包含凭据值。

| 操作 | HTTP 方法与路径 | 必须批准的方法 |
| --- | --- | --- |
| 核对自身授权 | `GET /connections/{grantID}` | 有效服务令牌；仅能读取自身连接 |
| 列获准项目（v1.7.0） | `GET /projects` | 有效已批准授权；无需额外方法，返回 `projectID/directory` |
| 列机器 | `GET /machines?limit=100` | `machines.list` |
| 列可访问会话 | `GET /sessions?limit=100` | `sessions.list` |
| 创建空任务会话 | `POST /tasks` | `tasks.create` |
| 发现可选启动项（v1.5.0） | `GET /options?machineID={绑定机器}` | `options.list` |
| 发送首条或后续指令 | `POST /sessions/{sessionID}/messages` | `sessions.send` |
| 按原 requestID 回查 | `GET /requests/{requestID}` | `requests.get` |
| 查询任务状态 | `GET /tasks/{taskID}` 或 `GET /sessions/{sessionID}/status` | `sessions.status` |
| 增量日志 | `GET /sessions/{sessionID}/events?after_seq=0&limit=100` | `sessions.logs` |
| 指定 turn 的最终结果 | `GET /sessions/{sessionID}/result?turnID={turnID}&after_seq=0&limit=100` | `sessions.result` |
| 请求停止 | `POST /sessions/{sessionID}/cancel` | `sessions.cancel` |

任务控制适配 Codex 与 Claude 专用会话（Claude 需 worker 白名单显式允许），不提供任意 shell 执行接口，也不接受调用方任意指定工作目录或代理。v1.5.0 起 `POST /tasks` 可携带可选 `options {agent,model,permissionMode,effort}`：每个显式值都必须同时在 worker 白名单与本 grant 的 options 子集内，否则返回 `OPTION_DENIED`；不传时保持固定默认启动。可选值与默认值通过 `GET /options` 按 grant 过滤后发现；`yolo`/`bypassPermissions` 等放权模式只有 owner 显式列入白名单才可用。详见 `happy-control-api-usage.md` 5.1 节。

创建和发送是两步：`POST /tasks` 每次仍必须明确传入一个获准的 `projectID`，只创建该目录中的专用空会话，不接收项目数组或任务正文。先通过 `GET /projects` 获取当前授权的 `projectID/directory` 列表（也可从 `GET /connections/{grantID}` 的 `projects[].id` 读取），再等待创建返回 `state=confirmed` 和明确的 `sessionID`，最后发送指令。对返回的实际 ID 操作，不自行拼出 sessionID，也不能把其他授权的会话拿来使用。

三个修改请求的 JSON body 示例（仅示意，ID 必须来自实际批准范围）：

```json
{
  "requestID": "order_1001_create",
  "machineID": "machine_demo",
  "projectID": "project_demo"
}
```

```json
{
  "requestID": "order_1001_send_01",
  "text": "请执行本测试项目内获准的任务，并在完成后说明结果。"
}
```

```json
{
  "requestID": "order_1001_cancel"
}
```

它们分别对应创建、发送、取消，不能将三个 body 混用。`taskID` 是本授权内创建操作的逻辑 requestID，例如 `order_1001_create`；`sessionID` 是创建回执给出的 Happy 会话 ID。

### Node.js 最小后端示例

复用 [service-token-backend.mjs](../../packages/happy-agent/examples/service-token-backend.mjs)，将它放入业务后端项目中。它是仓库示例文件，不是已发布的 npm SDK；示例建议使用 Node.js 22。`secretProvider.read()` 由接入方实现，不要求用户提供 Happy 密码或主密钥。

下面的函数以业务系统已经持久化的稳定 `jobID` 生成两个子 requestID。调用方必须保存返回的阶段和回执；结果不确定时先回查，不自动重新派发。

```js
import { serviceBackend } from './service-token-backend.mjs';

export async function startJob({ secretProvider, machineID, projectID, jobID, text }) {
  if (!/^[A-Za-z0-9_-]{1,110}$/.test(jobID)) throw Error('INVALID_BUSINESS_JOB_ID');
  const rest = serviceBackend({
    endpoint: 'https://szsp.suitbim.com.cn:7100/happy-control/v1',
    getToken: () => secretProvider.read('happy/business-service')
  });
  const createID = `${jobID}_create`;
  const created = await rest('POST', '/tasks', {
    requestID: createID, machineID, projectID
  });
  if (!created.ok || created.data?.state !== 'confirmed' || !created.data.sessionID) {
    return { stage: 'create', requestID: createID, reply: created };
  }
  const sessionID = created.data.sessionID;
  const sendID = `${jobID}_send_01`;
  const sent = await rest('POST', `/sessions/${sessionID}/messages`, {
    requestID: sendID, text
  });
  return { stage: 'send', taskID: createID, sessionID, requestID: sendID, reply: sent };
}
```

接入方需关闭 Authorization、请求/响应正文的普通日志、APM 捕获和错误原文输出，尤其不能记录令牌交付响应。示例客户端已限制 HTTPS origin/路径、拒绝重定向、对 provider/网络错误返回固定错误，不会自动重发修改请求。

### 回执、日志和最终结果怎样判断

响应使用稳定 envelope，业务方同时检查 HTTP 状态与 JSON 的 `ok`、`error.code`、`data`，不能把 HTTP 200 当作任务完成。

```json
{
  "version": 1,
  "ok": true,
  "requestID": "order_1001_send_01",
  "data": {
    "requestID": "order_1001_send_01",
    "sessionID": "session_demo",
    "state": "submitted",
    "messageID": "message_demo",
    "seq": 12
  }
}
```

`submitted` 表示消息已经持久写入 Happy，并不证明代理已消费、已开始运行或已完成。创建回执的 `confirmed` 只证明任务会话已确认；任务是否运行、等待权限、完成或失败，要读状态与 turn 证据。

- **分页与增量：** 机器/会话列表按 `nextCursor` 翻页，即使过滤后当前页为空也继续到 cursor 为空。日志使用 `after_seq` 或 `cursor`，不能同时传两者；保存返回的 `nextCursor`，`hasMore=true` 时继续读取。单页数量可能被服务端收窄。
- **结果归因：** 从日志中观察主会话 `kind=turn` 的 `turnID`，再查询对应 `/result`。`turnID` 不是发送 requestID；本版没有发送 ID 到 turn 的强因果绑定，不能凭“最新一轮”替某次发送宣告成功。建议专用会话串行发送，并核对该轮证据。
- **最终结果：** `ready=true` 才表示当前分页已观察到指定 turn 的终态，`outcome` 为 `completed / failed / cancelled`；没有证据就是 `unknown`。`ready=false` 时继续增量取证，不改成完成；分页结果由业务后端按 seq/messageID 去重汇总。日志是脱敏投影，不包含全部原始事件、思考过程或子代理结果。
- **取消：** 先得到 `cancel_requested`，随后查询原取消 requestID 和 `/status` 的 `process`。只有明确 `process=stopped` 才可报告进程已停止。`stopping / unknown` 或仅收到 kill ack 均不能报告已停；进程停止也不等于该 turn 有 `cancelled` 的结果证据。
- **权限等待：** `waitingForPermission=true` 时需按 Happy 现有流程由用户处理，服务令牌不会自动跳过代理权限确认。

### 超时、离线与幂等

`requestID` 必须为 1–128 位英文字母、数字、下划线或连字符。同一业务动作始终使用同一个 ID，创建、每次追加和取消使用不同的稳定子 ID。多项目授权下 requestID 仍在整个 grant 内唯一；不能对不同项目复用同一个创建 ID，否则返回 REQUEST_ID_CONFLICT。幂等范围是同一 client/grant，重新授权后不会沿用旧 grant 的去重记录。

| 返回或现象 | 业务处理 |
| --- | --- |
| `WORKER_UNAVAILABLE` / `unavailable` | worker/机器当前不可用；本版没有离线自动排队，恢复后先回查原请求 |
| HTTP 202、`UNAVAILABLE_OR_UNKNOWN`、网络超时/断连 | 可能已经执行，保存原 requestID，用 `GET /requests/{requestID}` 核实；不得换新 ID 盲目重派 |
| 回查 `NOT_FOUND` | 核对 grant 和 ID；单次没有查到不能证明在途操作从未发生，不自动补派 |
| `REQUEST_ID_CONFLICT` | 同一 ID 使用了不同目标或内容；停止并检查业务持久映射，不能换 ID 掩盖冲突 |
| `pending / unknown` | 继续有界退避、只读观察；不声称已经确认或运行 |
| `submitted / confirmed` | 已达到对应持久化/会话确认阶段，继续读取状态和日志 |

业务方自行限制并发和轮询频率，遇 429 有界退避；不要同时对同一会话派发多个需要准确结果归因的任务。旧授权到期/撤销后不能靠新令牌跨 grant 查询旧会话；需保留先前已获准读取的业务记录，是否能再次访问由新的明确授权决定。

## 撤销、过期、丢失与轮换

用户打开“助手连接”的“连接记录”，选择该服务连接，核对范围后点击 **“撤销连接”**。待批准申请可以“拒绝连接”。撤销、到期、登记身份变更或禁用均会阻断访问，重连不会恢复已撤销权限。撤销仍保留历史记录；点击 **“删除连接记录”** 并经确认后，才会先撤销仍有效的权限、使等待请求和令牌失效，再永久移除连接及其服务令牌摘要。删除不会清理任务、会话或操作回执。

**撤销和删除都不自动停止已经运行的任务。** 若需要停止且不是紧急泄漏，先在仍有效的授权下请求取消并确认 `stopped`，再撤销；若凭据可能泄漏，优先撤销，尚运行任务需在 Happy 中核实并处理。业务令牌本身不能批准、延长授权或调用 owner 撤销/删除接口。

轮换步骤：停止业务派发 → 核实在途请求及运行任务 → 从旧连接点击 **“编辑并重新授权”**，检查预填范围并修改 → 创建替代 pending 申请（成功后旧连接会撤销）→ 再次明确批准并交付新令牌 → 更新后端 secret provider → 在新授权专用会话验证。目录选择会重新由 worker 核实；原启动选项和既有会话范围不会静默丢弃。旧记录可另行确认删除。不要通过删除摘要补发旧令牌，也不要自动延长旧授权。

常见问题：

| 问题 | 检查与处理 |
| --- | --- |
| 只能选一个项目或多选后无法创建 | 先刷新新版 Web，预登记多选需服务/在线worker报告projectScopes=1，浏览新目录还需directoryScopes=1及根目录政策；worker离线、版本不匹配或未登录时不可使用。当前允许在/home/dev/code内选择具体目录 |
| 服务/机器/项目未列出 | 账号或站点是否正确；该身份、worker 项目是否已登记给这个账号；页面不能自行扩大白名单 |
| 创建页提示未启用、未登录或暂不可用 | 先确认登录同一 Happy 站点；仍失败再由操作方核对服务模式、注册和可达性 |
| `OWNER_AUTH_REQUIRED` / `OWNER_ORIGIN_REQUIRED` | 账号批准接口只供用户同源界面使用；不要给业务后端浏览器凭据来绕过保护 |
| `INVALID_SERVICE_TOKEN` | 核对后端 secret 引用及完整性，不打印凭据；无法恢复时撤销重建 |
| `GRANT_EXPIRED / GRANT_REVOKED` | 停止调用，请用户重新审查新的授权，不自动续期 |
| `SCOPE_DENIED` / `FORBIDDEN` | 方法、机器、项目、会话不在批准范围；不能通过改路径或伪造 ID 绕过 |
| HTTP 426 / 版本不支持 | 批准页必须支持服务模式明确确认，REST 宣告 serviceTokens.protocol=1，worker/daemon 具备 automation 协议1；旧手机页不可替代新版 Web |
| 令牌显示已交付但手上没有 | 完整值不能读回；撤销后重新申请、批准和交付 |

## 本版状态与进一步资料

已上线：支持浏览目录授权的99.55 REST、99.57 Web及4090受信worker，允许根目录/home/dev/code，A/B登记、原机器身份及旧授权保留。精确镜像76项Nginx/mTLS隔离检查、40项线上匿名浏览器检查及维护后的同machine/原会话身份核验通过；没有代本人批准新grant。真实 owner 签发服务令牌、业务后端密钥托管和新模式端到端任务验收仍待本人/接入方完成。原签名模式此前的任务验收不代表服务令牌模式已经完成真实业务验收。

- 用户/业务方按本文操作；不要把运维 SSH、公钥登记、账号主密钥作为业务调用参数。
- 完整架构与安全边界：[automation-control.md](automation-control.md)。
- 操作方部署状态与回退：[站点 README](../../deploy/automation/site-99-55/README.md)、[最新部署证据](../../deploy/automation/site-99-55/validation.directory-selection-live-2026-11-04.json)。
- 部署与项目登记不会自动授予权限；真实服务授权仍由本人审查批准。原生 App/OTA 本次未发布。
