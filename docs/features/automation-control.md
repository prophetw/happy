# Happy REST 自动化控制（底座已试运行，任务接入未开放）

最新验收（2026-11-04）：已在本人批准的`automation-test`有限scope中完成真实签名REST调用、一个专用Sol High会话的两轮完成结果及运行中取消实停验证；中断turn结果无终态证据，仍为unknown。当前授权到12:38:08 UTC+8失效。当前使用现有运维SSH下的固定签名adapter，专用MCP平台注册仍未配置；详见`deploy/automation/site-99-55/validation.task-2026-11-04.json`。以下试部署/fixture段落保留当时状态，不代表现在仍无worker或无获批连接。

目标是让获授权的云端助手调用 REST，CLI 仅保留为内部适配。开发分支 `clever-ocean`，worktree `/home/dev/code/happy/.dev/worktree/clever-ocean`。2026-11-04已获准把固定快照试部署到99.55，并热加载99.57新路径；仅使用24小时tmpfs内部TLS，client/worker登记为空。没有真实Happy登录/grant、worker/daemon更新或MCP注册。当前服务器结果及截止清理见本文末节和 `deploy/automation/site-99-55/validation.trial-2026-11-04.json`；早期本地fixture只证明模拟边界。

## 信任结构与源码（HTTP MCP 可选，支持 OAuth 或 service-token-v1）

```text
云端助手 → HTTP MCP（外部 OAuth，或显式 service-token-v1 服务令牌）
  → ProofClient 或每请求 ServiceTokenClient
  → 同域 /happy-control/v1 REST 控制进程
      独立连接、批准绑定、scope/expiry/revoke、幂等 intent
  ← 用户机器的 worker 出站 pull / live check / result
      本地再次校验范围、目录和身份；现有 Happy 凭据不外发
  → 原有 AutomationControl / Journal / daemon receipt
      create/cancel/status：本机原控制函数
      send/logs：现 relay v3 密文消息及 localId/seq
```

REST 控制组件和 connector 会看见批准范围内的任务明文。Happy relay 保持密文存转；机器/会话密钥及原有 Happy 凭据留在受信 daemon。授权是控制进程与 worker 强制的范围，不是现 relay 原生的窄权限 token，也不等于文件系统 sandbox。

| 文件 | 职责 |
| --- | --- |
| `packages/happy-agent/src/automation/control.ts`、`journal.ts` | JSONL/REST 共同内核；没有复制任务系统 |
| `automation/rest/gateway.ts`、`grants.ts`、`auth.ts` | REST、专用配对/批准、签名认证、持久撤权 |
| `automation/rest/worker.ts` | 出站通道、实时授权检查、第二层 scope、稳定请求命名空间 |
| `automation/rest/daemonTransport.ts` | 仅使用 daemon 已知的记录密钥；刷新 relay 加密状态；固定本地 RPC |
| `packages/happy-cli/src/daemon/automationControl.ts` | 持久创建/取消回执、实际停止观察 |
| `packages/happy-cli/src/daemon/automationWorker.ts`、`run.ts` | 显式 opt-in 启动接线，验证实际 Happy owner 与机器；默认不启用 |
| `automation/rest/mcp.ts`、`client.ts` | 固定 MCP 输入输出到 REST 的映射，不提供 shell/fetch/任意 RPC |
| `automation/rest/options.ts`、`happy-cli/src/daemon/automationOptions.ts` | 启动选项白名单/解析/按 grant 过滤；daemon 侧目录来自机器元数据中的 Codex/Claude 模型目录 |
| `happy-app/sources/auth/automationApproval.ts`、`app/(app)/settings/automation.tsx` | 同站点专用批准/扫码/撤销/删除记录及服务授权编辑入口；不访问账号 secret |
| `docs/api/automation-control.openapi.json` | 从 `automation/rest/openapi.ts` 生成的 OpenAPI 3.1 |

现有扫码账号登录的源码：`authQRStart.ts` → `/v1/auth/account/request` → 手机 `useConnectAccount.ts` → `/account/response` → `authQRWait.ts` → `TokenStorage`。该流程授予完整账号客户端，Web 保存于 localStorage，不能复用于本自动化 grant。现有 persistent Happy token 没有 exp，24h 是验证缓存 TTL；本方案不改变这套登录/注销语义。

## 任务启动选项与权限白名单（v1.5.0，已部署，真实选项任务待本人验收）

### 跟随 Happy 动态模型目录（v1.8.0）

worker 的 `launchOptions.agents[]` 可显式配置 `modelSource: "machine"`，让该执行端使用当前机器目录里的全部模型，无需枚举型号或随模型新增/移除改配置。`models` 可保持空数组；未设置该字段的历史 worker 仍使用原静态白名单，不隐式升级。配置片段见 `deploy/automation/site-99-55/dynamic-model-catalog.fragment.json.example`。

Claude Code 和 Codex 使用 Happy 选择器读取的 `machine.claudeModels/codexModels`；Agy 复用已安装 CLI 的 `agy models` 动态发现，发布为 `machine.agyModels`，Happy 的新建与现有会话选择器、REST 都读取同一元数据。机器目录发现失败时不拿内置型号冒充实际目录；旧 CLI/旧元数据的 App 兼容回退保留。Agy 的完整模型名可含空格、括号，查询、投影、创建和后续会话控制均保留准确名称。REST 的 agent 值为 `claude`、`codex`、`agy`，不是模型提供方名称。

目录更新后，动态策略的下一次查询和派单校验读取更新的机器目录；旧调用和持久回执不改写。显式 grant 模型子集继续收窄动态目录，权限模式仍独立由原白名单控制。动态模型策略不会增加目录、方法、凭据权限，也不会自动批准新 grant。启用三执行端需要同步 host/worker 的注册配置和实际运行包；只改调用方枚举或展示名称不会让旧 worker 支持 Agy。

> 部署状态（2026-11-05）：55 REST、57 Web、4090 worker 均已上线本节能力，白名单为 Codex 已安装 8 模型 + `auto/safe-yolo/read-only/yolo`，现网未开放 Claude。真实 owner 批准的 options 任务与 `/options` 实测仍待本人验收，证据见 `deploy/automation/site-99-55/validation.launch-options-live-2026-11-05.json`。

委派任务可以在 owner 明确允许的范围内选择 agent（`codex`/`claude`）、模型、权限模式和 effort；`yolo`/`bypassPermissions` 等放权模式因此不再是"永不暴露"，而是"只有 owner 列入白名单才可委派"。默认行为完全不变：不传 `options` 时仍按原固定参数启动 Codex 会话，未配置白名单的 worker 拒绝一切覆盖（`OPTION_DENIED`）。

模型标识允许已安装目录中的上下文窗口后缀（如 `ccs-claude-kimi--k3.1-pro[1M]`）。只增加方括号字符兼容，仍禁止空白、路径和命令字符；不改变 worker/grant 白名单。修复前，daemon 返回完整目录中一个带后缀的 Claude 型号，就会使 Codex-only 授权的 `/options` 也被错误判为 `UNSUPPORTED_VERSION`。该修正需要升级实际 worker 加载的 `happy-agent`，仅构建工作区或更新调用方不能修复已运行进程；部署状态必须以真实 REST 回读为准。

三层强制，任何一层都不能被调用方绕过：

1. **授权创建/审批**：`POST /connections` 与 `POST /service-connections` 可携带 `options` 子集；grants 校验它必须是 worker 注册表 `launchOptions` 的子集，否则 `SCOPE_DENIED`。digest 绑定该子集，审批页展示即冻结。worker 白名单在注册表（host/worker 配置的 `launchOptions`）中由 owner 维护；白名单收缩会使不再可满足的旧 grant 在校验时撤销。
2. **worker 执行前**：`ScopedWorker` 通过 daemon `options` RPC 取回实时目录，把请求的覆盖值同时对 worker 白名单、grant 子集和目录解析（`resolveTaskOptions`），失败返回 403 `OPTION_DENIED`。`options.list` 只返回按本 grant 过滤后的可选键与默认值（`filterCatalogForGrant`），不泄露其他 agent/模型的可用性。
3. **daemon 最终解析**：`automationControl` 在真正 spawn 前用同一份白名单和本机模型目录再解析一次，不信任 worker 的单方判断；解析结果写入回执 `options` 并回显给调用方。幂等 fingerprint 覆盖规范化后的请求选项，同 `requestID` 不同选项返回 `REQUEST_ID_CONFLICT`。

白名单在 host 与 worker 配置共用的 worker 注册表中声明（`launchOptions`，见 `docs/api/automation-production.config.schema.json`），例如：

```json
{
  "launchOptions": {
    "version": 1,
    "agents": [
      { "agent": "codex", "models": ["gpt-6.1-sol", "gpt-6-sol"], "permissionModes": ["auto", "yolo"] },
      { "agent": "claude", "models": ["claude-opus-5"], "permissionModes": ["acceptEdits"] }
    ]
  }
}
```

`models`/`permissionModes` 列出的是"允许调用方覆盖的值"，默认启动不需要列入；需要放权委派时才加入 `yolo`（Codex）或 `bypassPermissions`（Claude）。worker 注册的 `methods` 含 `options.list` 时，调用方才能通过 `GET /options` 发现这些可选项；服务授权创建页会把该能力列为可勾选的只读操作。

兼容性：daemon `capabilities.operations` 只有在新版才包含 `options`；缺此能力时，发现与任何带覆盖的创建都返回 426 `UNSUPPORTED_VERSION`，纯默认创建不受影响。目录只含键（模型 ID、模式 ID），不经过自由文本投影；Claude 会话同 Codex 一样支持后续 send/status/logs（其他 flavor 仍 `UNSUPPORTED_AGENT`）。白名单约束的是"覆盖值"，owner 已配置的环境默认启动始终有效。另注意：创建回执的幂等 fingerprint 现在包含规范化后的请求选项，daemon 升级前写入的旧回执若用同一 `requestID` 重发创建，会返回 `REQUEST_ID_CONFLICT` 而不是直接重放；按原 `requestID` 查询回执即可核实原结果，不要换新 ID 重派。

## 独立助手连接协议

签名 REST 通道使用 Node Ed25519 的持有证明，不签发 OAuth Bearer/refresh token。外部 HTTP MCP 可保留独立 OAuth resource-server 适配（AS 必须由已有受控服务提供），也可显式启用 `service-token-v1` 模式，直接复用同一服务令牌与 grant/scope；两种模式都不使用 Happy 全账号 Bearer 执行任务。签名客户端、worker 的公钥由受控注册表预置，私钥由平台/用户主机的 secret provider 托管。库不会隐式发现或创建密钥；OAuth MCP 仅在显式配置后从安全 provider 获取 signer，service-token MCP 不需要签名私钥或 OAuth AS。

1. 已注册的 connector 使用 `POST /connections` 申请固定 worker/machine/project、方法、既有会话 ID 和到期时间。此时没有执行权限。
2. 用户在 Happy 的“账号 → 助手连接”打开 connection ID，页面展示专用 `happy:///automation?connection=<ID>` 二维码；ID 是非秘密标识，不是兑换凭据。
3. 手机进入专用助手连接扫描器，不走账号/terminal 配对。批准页显示账号、客户端/worker 公钥指纹、机器、项目的实际目录、方法、既有会话和到期时间、明文信任声明。
4. 用户显式确认后，页面发送精确 `digest + challenge`。后台验证 owner、请求期限、一次性批准状态及 immutable scope。不能修改 scope 再批准；要缩小范围须拒绝并重新申请。
5. connector 继续以自己的私钥签名，引用已批准 connection ID（即 grantID）调用 REST。不领取浏览器 cookie、Happy token 或账号主密钥。
6. 撤销持久化，并立即解除该 grant 正在等待的 REST 调用；worker 每次操作/底层读写都重新向控制进程检查。断连、撤销、过期或无法验证均拒绝，不用缓存授权继续执行。已经开始的 OS 操作不能被撤权撤回；需要停止时另发明确取消。

Owner 批准接口与 automation API 的认证不同：前者仅通过现有 Happy Bearer 验证本人，正式适配 `happyOwnerVerifier()` 固定请求 relay `/v1/account/profile`，不存储、不转交或复用该 Bearer 执行任务；后者只接受独立签名。Cookie 不认证 automation API。二维码不能指定另一个服务器地址，App 根据已选 Happy relay 的 origin 固定访问 `/happy-control/v1`。

配对待批准 TTL 最多 5 分钟；默认 grant 最长 1 小时，宿主可显式设置更短或经批准的上限。没有永久授权、自动续 grant 或真实 grant 预置。到期/撤销/客户端或 worker 公钥轮换/项目目录重绑定均需要重新审查连接，不会悄悄恢复旧访问。

签名覆盖协议/actor/clientID/grantID/timestamp/nonce/HTTP method/完整 path+query/canonical JSON hash。时间窗口 ±30 秒；按实际 JSON wire 内容规范化（省略 undefined 对象字段），nonce 在验收前持久化；重启不能重放。私钥、签名 header 和 owner Bearer 均不放入 URL、聊天、响应示例或审计。过期 nonce 可安全清理；grant/receipt 不自动删除。owner 可通过 `DELETE /connections/:id/record` 明确永久删除连接：先持久撤销并结束等待 job，再删除服务令牌摘要和连接记录；`intent:` 回执、任务、会话与 journal 不级联删除，已运行任务不会因此自动停止。

### Web 批准页审查体验（2026-11-04）

批准页将真实机器/项目目录、精确方法、既有会话范围和期限直接列出；长ID/公钥指纹与专用二维码按需展开。过期、撤销、等待批准状态使用中文标识，pending确认期限在打开页面期间到期也会禁用批准。未登录时提供返回Happy登录的入口，登录后需重新打开连接链接并单独批准；没有复用账号扫码授予助手权限。

批准、撤销或删除响应丢失时只查询当前状态，不自动重发。无法核实时显示“结果待核实”，保留明确的读取与安全撤销入口；删除成功后详情和一次性令牌组件会卸载，列表与路由参数同步清理。请求代次阻止迟到响应覆盖另一连接。Web更新不表示原生手机专用扫码页面已经发布。隔离fixture浏览器可运行`pnpm --dir packages/happy-app exec node scripts/automation-approval.e2e.mjs`；匿名线上只读冒烟使用同目录`automation-approval-live.e2e.mjs`，不登录、不批准。

## 服务访问令牌 v1（最长30天，Web/REST已上线，真实服务授权待验收）

用户和业务方的操作步骤见 [Happy 服务授权：用户创建与业务后端接入](automation-service-access.md)，包含 Web / App 发布边界及后端示例。

2026-11-04经本人授权，新REST和Web已部署99.55/99.57，沿用现有4090 worker。入口 `https://szsp.suitbim.com.cn:7100/happy/settings/automation-service`，可选“后端联调测试”和 `automation-test`；当前登记不产生grant。52项新镜像/Nginx隔离检查及40项线上匿名浏览器检查通过；本人登录、明确批准、一次性交付、真实接收后端任务及撤销验收尚未执行。未重启relay、57 Nginx或worker/daemon；未发布原生手机页或配置MCP。最新依据为 `deploy/automation/site-99-55/validation.service-token-live-2026-11-04.json`。

此模式供第三方后端直接调用 REST，也可在控制端显式启用 `mcp: { "mode": "service-token-v1" }` 后连接 `/happy-control/mcp`。它不要求后端持有 Happy 账号凭据、SSH 或签名私钥。持有令牌即能使用其已批准范围；现有 HappyProof、账号登录、worker proof、relay 密文和 daemon 控制内核不变。OAuth MCP 与 service-token MCP 是两种独立配置，服务令牌不是 OAuth JWT，也不会被交给 OAuth verifier。

### 显式配置与有限范围

生产 launcher 新增可选 `serviceTokens`。不配置则禁用；原 `maxGrantMs` 仍默认 1 小时、配置上限 7 天。服务模式的 `serviceTokens.maxGrantMs` 默认 2592000000（固定 30×24 小时），允许缩短、禁止超过 30 天；有效期从申请时计算，批准或交付不延期。

配置片段见 `deploy/automation/service-tokens.host.fragment.json.example`：只含服务 `id/userID/name/generation` 等非秘密身份，不含密钥。服务身份当前需操作方预登记；网页选择名单中的服务，不提供公开匿名注册或任意机器/项目输入。每个后端独立身份；更改 generation/归属/登记身份、删除身份或关闭模式，会持久撤销旧 grant，重新开启不能恢复旧访问。签名客户端与服务客户端 ID 不得重名。

worker 的既有项目 realpath 和方法白名单仍是上限，网关与 worker 双重检查。每枚令牌绑定一个 user/client/worker/machine/grant、明确项目范围和期限；旧单项目授权保持原范围，新多项目授权见下节，默认只能访问本 grant 新建的专用会话。网页默认只读方法，创建/发送/取消需要明确勾选；本版创建页不选择既有会话，API仅在批准时显式列出且 worker 已准许的 sessionIDs 才可访问。项目 scope 限制控制入口与会话访问，不是操作系统文件沙箱，代理仍使用既有权限确认机制。

### 多项目服务范围 v2（REST/Web/worker已部署，待本人授权验收）

2026-11-04经本人明确维护授权，REST/Web/worker已更新，A/B测试目录已双边登记；现有grant没有自动扩权。实际部署和保留原会话的证据见 `../../deploy/automation/site-99-55/validation.multi-project-live-2026-11-04.json`，真实新grant/两项目任务仍待本人操作。

只复用既有service grant、令牌、journal及worker通道，不建立授权组/第二套任务系统。同一worker/machine下可明确勾选2–32个已登记项目，单项目继续原`projectID`请求格式，原签名客户端的scope格式不变。多项目创建示意（无凭据）：

```json
{
  "clientID": "service_demo",
  "workerID": "worker_demo",
  "machineID": "machine_demo",
  "scopeVersion": 2,
  "projectIDs": ["project_a", "project_b"],
  "methods": ["machines.list", "sessions.list", "tasks.create", "sessions.send", "requests.get", "sessions.status", "sessions.logs", "sessions.result"],
  "sessionIDs": [],
  "expiresAt": 1893456000000
}
```

`expiresAt`仅为schema示意，实际必须按申请时刻设置且不超过部署上限。不能同时传`projectID`和`projectIDs`，不能空选、重复、混入未登记项目或扩大既有会话。后端规范化项目顺序，冻结完整`projects:[{id,directory}]`并纳入原批准digest；新版批准请求还必须明确带`scopeVersion:2`，旧批准页返回426 `PROJECT_SCOPE_APPROVAL_UPGRADE_REQUIRED`，不会漏审额外目录。所有勾选项目共用方法、期限和整枚令牌撤销，不能原地给旧授权添加项目。

创建任务仍用原`POST /tasks`，每次指定一个获准`projectID`；worker将它映射到冻结的实际目录。会话读取/追加/取消及回执只准本grant新建或明确批准、且位于所选目录的会话。每次底层动作独立检查完整项目绑定与realpath，任一项目被移除/换绑即失败关闭；控制端持久撤销已失配的授权，恢复配置不会复活。requestID仍在整个grant内唯一，跨两个项目复用同一ID/不同内容会冲突，幂等与receipt/cursor/turn/取消unknown语义保持。

最低能力：REST `compatibility.projectScopes=1`，创建页options同样报告`projectScopes=1`，且在线worker的签名poll报告`projectScopes=1`。通道/daemon RPC协议仍为1；新版worker先读取兼容性，旧服务下保持原poll body，30秒重新协商，遇降级拒绝则重新核实。多项目派发以及已排队job交付均拒绝缺此能力的旧worker，返回426 `WORKER_PROJECT_SCOPE_UPGRADE_REQUIRED`。页面多选需要控制端和在线worker都支持，能力不足时仍可创建单项目授权。

本地验证覆盖跨项目/机器/user/method/会话拒绝、完整批准与防重放、旧页/旧worker保护、两项目派发和持久幂等、断连/超时/撤销/到期、实际loopback桌面/手机UI。本地阶段记录保留其当时的未部署边界；后续获准维护已更新worker/daemon及两个测试目录，仍未代本人创建真实grant。本轮验证记录见 `../../deploy/automation/site-99-55/validation.multi-project-local-2026-11-04.json`。此次已配套更新REST/Web和受信worker；除明确获准的两个测试目录外，其他项目仍需另行确定范围，不能由UI任意扩大。原生App仍未发布。

### 用户选择目录 v3（REST/Web/worker已部署，待本人授权验收）

复用现有 `DirectoryPicker` / owner加密machine RPC浏览目录，以及同一个REST/worker/service grant/control/journal；不建立项目平台、不逐项写回静态配置。REST的 `workers[]` 与worker的 `registration` 同时显式配置 `directorySelection: { roots: ["/home/dev/code"] }` 后，用户可以在其中多选具体目录。默认不启用，`/`、非规范路径和直接根目录不能选择。配置模板本身是示例；2026-11-04已获本人明确授权，将/home/dev/code这一policy应用到线上两端。旧授权不扩大范围。

调用链：owner已登录Web → 既有E2EE目录RPC浏览 → owner POST `/service-connections/resolve-directories`（clientID/workerID/machineID/directories）→ 新版worker在现有签名出站poll接收只读核实job → `/worker/directory-check`核对job归属 → 本机realpath/stat → 签名 `/worker/directory-result` → 网关核对自己的根目录政策并返回两分钟selectionID/冻结projects → owner创建scopeVersion=3的pending服务授权 → 本人审查，approve再次向worker核实 → 原单次令牌交付/任务接口。

selectionID不是访问令牌，绑定user/client/worker/machine/worker公钥及全部目录，一次性消费，过期或重放拒绝。申请绑定完整projects/projectIDs；每次命令网关和worker独立检查明确目录及方法/机器/user/专用会话；worker还核对root和目录的canonical path。只读核实job不调用任务transport、不读文件内容、不创建目录或授权，不将账号凭据传入job。断连、超时、服务重启、未知job、旧worker/旧批准页均失败关闭。撤销/expiry/requestID/receipt/cancel的既有语义不变，现有grant不扩权。

兼容性：通道协议仍为1，REST及fresh signed worker poll新增 `directoryScopes=1`；多项目 `projectScopes=1` 保留；v3支持1–32个明确目录、仅新建专用会话。旧单项目/v2继续可用。OpenAPI1.4.0新增owner核实和两个内部worker端点；这些端点不注册成automation/MCP工具。无新依赖。已按本人的维护及根目录scope授权配套更新三端；真实用户E2EE目录RPC、v3批准和后端任务仍待验收。部署片段见 `../../deploy/automation/site-99-55/directory-selection.fragment.json.example`；本地验证记录见 `../../deploy/automation/site-99-55/validation.directory-selection-local-2026-11-04.json`，实际部署与状态保留记录见 `../../deploy/automation/site-99-55/validation.directory-selection-live-2026-11-04.json`。

canonical path绑定不等于inode固定或OS文件沙箱；同一路径下内容变化和并发文件系统替换仍受现有代理/操作系统权限约束。只对明确scope提供控制，不向云端导出账号密钥，relay仍密文；云端能看到本次批准的项目路径和获准指令/结果。

### 本人审查与一次性交付

1. 已登录 Happy 的用户在“助手连接 → 为后端创建服务授权”进入服务授权页；`GET /service-connections/options` 只返回该用户的已登记服务、worker 和允许范围。
2. `POST /service-connections` 创建 pending，body 为 `clientID + 原 scope`，没有执行权限。待批准期限仍最多 5 分钟。
3. 原批准页显示服务令牌模式、服务身份指纹、机器、项目 realpath、精确方法、会话范围及到期。`POST /connections/{id}/approve` 除原 digest/challenge 外必须明确带 `credentialMode: "service-token-v1"`；旧批准页缺少模式确认返回 426，不会默默批准新凭据类型。原签名批准 body 不变。
4. 本人明确点击“生成服务访问令牌”，`POST /connections/{id}/service-token` 仅在该 owner 的已批准服务连接中成功一次。凭据含 256-bit CSPRNG 随机秘密；单个持久原子 claim 只保存 SHA-256 摘要与非秘密绑定、发行时间及原到期时间。完整令牌只在该次 HTTPS/no-store 响应交付，没有可读回明文的 GET。
5. 页面默认隐藏凭据，明确点击才显示/复制；不写 localStorage、sessionStorage、URL、导航参数或日志。账号/API切换、路由失焦、进入后台和卸载清除页面凭据，迟到响应及旧复制/显示 handler 不能恢复；明确复制后的外部剪贴板内容不由页面托管。
6. 交付丢包/超时不能证明未发行，重复发行返回 `SERVICE_TOKEN_ALREADY_ISSUED`。本版轮换可从旧服务连接进入“编辑并重新授权”：旧配置仅用于预填，创建新的 pending grant 成功后撤销旧连接，用户再次审查精确 digest/challenge 并交付新令牌。目录选择必须重新核实，旧 options/sessionIDs 显式保留且不得超出现行白名单；不静默补发、不自动续期，也不延长旧 grant。用户的接收后端通过其安全渠道/secret provider 托管，不把令牌发到聊天、URL 或提交代码。

### 后端调用与停止语义

后端将专用令牌仅注入 `Authorization` 请求头，调用原 `/happy-control/v1` 的 machines/projects/sessions/tasks/messages/status/events/result/cancel/requests 路由；不必另加 grantID，服务端从令牌定位唯一批准连接。`GET /connections/{id}` 仅可查询自身连接，不能枚举同服务的其他 grant。服务令牌不能用于 owner、原连接申请、worker 或 OAuth MCP 认证，也不会被转发给账号 relay 验证器；只有显式配置的 `service-token-v1` MCP 入口接受它。

最小客户端函数在 `packages/happy-agent/examples/service-token-backend.mjs`，由应用注入 `getToken()`；不自读账号认证文件、不含真实凭据、不启动服务。凭据读取前检查固定 HTTPS origin 和规范化后的 REST 路径，禁止编码目录穿越/重定向；provider 错误固定返回 `SERVICE_CREDENTIAL_UNAVAILABLE, dispatch:not_sent`。网络派发后失败返回 `unknown + 原 requestID`，不自动重发。使用示意（域名、ID均为非真实示例；`secretProvider`由接入方实现）：

```js
const rest = serviceBackend({
  endpoint: "https://happy.example.invalid/happy-control/v1",
  getToken: () => secretProvider.read("happy/partner-a")
});
const created = await rest("POST", "/tasks", {
  requestID: "job_demo_create", machineID: "machine_demo", projectID: "project_demo"
});
// 只有 state=confirmed 且 sessionID 明确后才以另一个稳定 requestID 发送首条指令。
// 超时先 GET /requests/job_demo_create；不能换新 ID 盲目重派。
```

幂等命名空间仍为 client/grant/requestID，与 bearer 文本、请求或进程重连无关。取消依旧先返回 cancel_requested，必须查询 receipt/status 的实际 stopped；没有退出证据时为 unknown。撤销复用 `DELETE /connections/{id}`，会中断等待请求并保留 revoked 记录；永久清理由 `DELETE /connections/{id}/record` 完成，先建立持久撤销屏障，再清服务令牌摘要和连接。两者都由 worker 每次底层动作重新检查，不会自动停止已开始的 OS 任务。到期、身份变更、禁用、断连和元数据损坏均失败关闭。摘要记录损坏会使认证、readiness和启动失败，不作为“未发行”重新生成。审计只记固定路由/身份/状态，投影额外脱敏裸服务令牌。

### 本地验证和兼容性

新 REST 必须宣告 `compatibility.serviceTokens.protocol=1`；批准 UI 必须支持服务模式显式确认和一次性交付。原签名客户端/正常 UI 协议仍为1，原默认期限不变；原单项目能力可复用既有worker协议1（无新RPC或加解密协议）；多项目能力需更新受信worker并明确协商projectScopes=1，旧worker不能执行多项目授权；不要求改变relay加密。原生手机服务授权页未发布，不能声称旧手机已有本功能。

验证命令（只用 fixtures，无真实授权；loopback 浏览器/服务器结束时清理）：

```sh
pnpm --dir packages/happy-agent exec vitest run src/automation/rest/serviceTokens.test.ts src/automation/rest/gateway.test.ts src/automation/production/production.test.ts src/automation/rest/multiProject.test.ts --no-file-parallelism --testTimeout=15000 --reporter=dot
pnpm --dir packages/happy-app exec vitest run sources/auth/serviceAccessUI.test.ts sources/auth/automationConsentUI.test.ts sources/auth/automationApproval.test.ts --reporter=dot
pnpm --dir packages/happy-app exec node --import tsx scripts/service-access.e2e.mjs
```

浏览器流程使用真实本地 REST、原 worker/control/journal 和合成加密 relay，只有 owner身份是fixture；验证桌面/手机30天选择、明确批准、一次性交付、后端REST操作、撤销、无明文持久和无意外请求。截图令牌字段遮挡；不向现有站点或日常会话发送测试。本地实现阶段证据见 `deploy/automation/site-99-55/validation.service-token-local-2026-11-04.json`，该记录的未部署边界保留其当时状态。后续线上启用结果见本节开头；实际grant的项目/方法/期限仍须本人审查批准，接收后端secret provider及安全交付未配置，本次部署没有替本人创建真实token/grant。

### 上线配置准备（历史；当前状态见本节开头）

站点公开计划见`deploy/automation/site-99-55/service-token-rollout.json.example`，操作及回退手册见同目录`service-token-rollout.md`。只读检查命令为`node deploy/automation/site-99-55/service-token-plan.mjs --review`；没有apply功能，不生成或安装真实配置。计划保留源码快照、原签名1小时策略、既有state/反代/TLS/worker；准备阶段的新镜像及接收后端资料未齐全，当时不能称可上线；后来真实部署单独记录，接收后端托管仍未配置。若需要降旧镜像，必须额外验证新增状态兼容且配置/镜像配套回退，绝不恢复旧state来复活撤销或丢失幂等回执。细节与本地检查结果见`validation.service-token-plan-local-2026-11-04.json`。

## REST 契约

基址 `/happy-control/v1`，完整机器契约见 OpenAPI；所有响应为 version 1 envelope。

| 方法/路径 | 必需 scope / 行为 |
| --- | --- |
| `POST /connections`、`GET /connections/:id` | 独立客户端签名申请；签名或服务令牌查询自己的连接，详情包含统一 `projects` 数组 |
| `GET /projects` | 有效已批准授权；只列当前 grant 的项目，返回 `projectID/directory`，无需额外方法或 worker 调用 |
| `GET /connections`、`GET /connections/:id/consent` | 同站点 owner 身份；审查连接 |
| `POST /connections/:id/approve`、`DELETE /connections/:id` | owner 批准/撤权；digest/challenge 防替换和重复批准；撤权保留历史 |
| `DELETE /connections/:id/record` | owner 永久删除记录；先撤权并结束等待 job，再清服务令牌摘要和连接，不删除任务/会话/intent/journal |
| `GET /capabilities` | machines.list；实际探测 worker/daemon core 能力 |
| `GET /machines`、`GET /sessions` | machines.list / sessions.list；cursor/limit 分页 |
| `POST /tasks` | tasks.create；requestID + machineID + projectID，创建空会话 |
| `POST /sessions/:id/messages` | sessions.send；requestID + text，独立发送首条或追加指令 |
| `GET /tasks/:id`、`GET /sessions/:id/status` | sessions.status；进程状态与 turn 证据分开 |
| `GET /sessions/:id/events` | sessions.logs；after_seq 或 cursor、limit、nextCursor、hasMore |
| `GET /sessions/:id/result?turnID=…` | sessions.result；必须指定 turnID，返回分页文本和终止事件证据 |
| `POST /sessions/:id/cancel` | sessions.cancel；独立 requestID，不提供 force/shell 参数 |
| `GET /requests/:id` | requests.get；查 receipt，不重新派发 |
| `GET /openapi.json` | 非秘密协议文档 |
| `POST /worker/poll,check,result` | 内部 worker 签名通道，不映射为助手工具 |

每个 grant 只绑定一个 user/client/worker/machine 和明确的项目集合；只允许固定方法，不支持通配符。默认为本 grant 创建的专用会话，既有会话必须逐 ID 明确选择且属于获准项目。网关与 worker 都检查范围，worker 还检查目录 realpath 和实际 session metadata。

非秘密请求示例（鉴权由 connector 注入，不放入示例）：

```json
{"requestID":"create_demo","machineID":"machine_demo","projectID":"project_demo"}
```

```json
{"version":1,"ok":true,"data":{"taskID":"create_demo","sessionID":"session_demo","state":"confirmed","process":"running"}}
```

随后向明确 session 发送：

```json
{"requestID":"send_demo","text":"检查指定问题并报告证据"}
```

`confirmed` 仅确认创建了空会话。`submitted` 仅确认 relay 持久化消息，不证明 agent 已消费；只有真实主会话 turn 事件产生 running/completed/failed/cancelled。idle、ready、active=false 都不能推导成功。

`cancel_requested` 是取消回执；只有 daemon 证明已知归属的 Unix 父进程及进程组均消失，才报告 stopped。Windows、daemon 重启后归属不明、外部/tmux 无 child handle 或权限不足会保持 unknown；不自动升级 SIGKILL，不拿 relay offline 当停止证明。

幂等命名空间为稳定 clientID/grantID/requestID，不跟随访问凭据或进程重连变化。worker 对 relay localId 和 daemon requestID 做相同稳定映射。所有变更先落 intent；同 ID 改 payload 返回 409 REQUEST_ID_CONFLICT。创建、发送是两个操作，`startTask()` 提供稳定的 create/send 子 requestID（两阶段可单独回查）。跨 grant 不盲目重放旧操作。

网关确定 worker 离线时返回 503 WORKER_UNAVAILABLE、dispatch:not_sent，不排离线任务；可能已经派发而超时，变更返回 202 + UNAVAILABLE_OR_UNKNOWN，必须用原 requestID 查询。OS spawn 与最终回执之间崩溃留下 unknown，不承诺跨 OS/磁盘恰好一次。查无 receiver 回执为 unavailable，绝不以新 requestID 隐藏不确定窗口。

结果为 `attribution:session_turn_only`，不会把其他 UI 插入的 turn 误归属于某个 send requestID。result 是分页证据，ready 仅表示该页观察到指定 turn 的终止事件；完整文本要累计分页。文本每条最多 16000 字符并标记 truncated；工具参数/结果、reasoning、任意 metadata、key 不返回，被省略消息仍推进 seq。

401 区分缺少/无效 proof；403 区分 scope、到期、撤销和绑定变更；409 区分 payload 冲突、批准或签名重放；426 表示旧协议；429 限流；413 过大请求；503 是服务不可用/读取结果不确定。无底层 HTTP/socket 错误对象回传。

## 本地运行与验证

依赖复用仓库已有 Fastify 5、Zod 4、MCP SDK 1.29.0 的锁定解析。新建隔离 checkout 缺少依赖时按项目规则使用阿里镜像安装，不在运行中的目录安装/构建：

```sh
pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com
# happy-wire dist 缺失时，先构建共享包
pnpm --filter @slopus/happy-wire build
pnpm --filter happy-agent build
pnpm exec tsx packages/happy-agent/examples/rest-fixture.ts
```

fixture 自建临时目录、模拟 owner、临时 Ed25519 密钥和 AES 记录、临时 127.0.0.1 端口，调用真实网关、worker、控制内核和 daemon receipt；退出关闭 listener/worker 并删除临时资料。只打印状态，不打印密钥、授权 header 或凭据。

```sh
cd packages/happy-agent
pnpm exec vitest run src/automation src/api.test.ts --reporter=dot
cd ../happy-cli
pnpm exec vitest run --config vitest.automation.config.ts --reporter=dot
cd ../happy-app
pnpm exec vitest run sources/auth/automationApproval.test.ts sources/auth/automationConsentUI.test.ts sources/auth/AuthContext.test.ts sources/hooks/useScanQrCode.test.ts --reporter=dot
```

分别执行 happy-agent build（包含类型检查）、CLI/App 的 tsc --noEmit。CLI 专用测试配置不触发原 globalSetup 的完整 build，不启动 CI、后台 daemon 或用户会话。OpenAPI 由 openapi.ts 生成，生成命令见源码导出入口。

## 库安装、托管与工具注册契约

`happy-agent/automation` 是无 CLI parse 副作用的库入口，导出：

- `createGateway(options)`：返回 Fastify app，不自动 listen；传入固定主 origin、可选 `additionalBrowserOrigins` 精确白名单、非秘密注册表、受限存储目录、owner verifier 和脱敏 audit sink。单进程文件存储不可用于多副本网关。
- `ProofClient(baseURL, identity, actor)`：identity 由宿主 secret provider 提供 signer（兼容既有 KeyObject）；不从工具参数/URL 取密钥。`ServiceTokenClient(baseURL, token)` 是每请求 bearer 适配，只在固定 REST origin 转发已认证服务令牌。两者实现同一 `ControlClient`，正式只接受 HTTPS，loopback 例外须显式仅用于 fixture。
- `createDaemonTransport(bindings)`、`HTTPWorkerRunner`：daemon 自己提供既有 token、machine、已知记录密钥和原 control callback。不会导出凭据到网关。
- `createControlMcp(client, grantProvider)` / `connectControlStdio()`：注册 SDK MCP 工具，grantProvider 由宿主保存已批准的非秘密连接 ID。

`startDaemon({automation})` 是显式受信 bootstrap 接点；默认调用不启用 worker。bootstrap 先验证实际 Happy owner/machine 和 dataKey 模式，再启动出站 runner；正常退出会 abort runner。操作方需将它接入自己的 secret provider/服务启动配置，不能把私钥放命令行、普通配置文件或日志。专用生产入口使用 existingOnly 模式；bundle 替换清理后以75退出，交由 Restart=on-failure 的 supervisor 按原配置重启，不自动交接成普通 daemon。状态/lock 残留必须核验原进程与锁后处理，不能称崩溃后自动恢复。

MCP 固定工具：happy_machines、happy_projects、happy_sessions、happy_create_task、happy_options、happy_send、happy_status、happy_events、happy_result、happy_cancel、happy_request_status，以及签名客户端可用的 happy_request_connection。前十一项通过 grantProvider 选择当前批准连接；`happy_projects` 只列当前 grant 项目，`happy_options` 发现已批准启动项；连接申请只申请、不能批准。service-token MCP 不注册连接申请工具。SDK 工具发现/调用已有 InMemoryTransport 与真实 HTTP contract test。没有任意 fetch、shell、URL、RPC 或自动批准工具。

现有 stdio factory 与 HTTP MCP transport 均可供平台适配。App 的 Dot「MCP 工具」面板提供通用 Streamable HTTP/stdio 配置及 Happy Control 预设，通过加密 `testloop-mcp-connections` RPC 交给 TestLoop 宿主；宿主声明 `capabilities.storedToken=1` 时首选掩码 Token 输入与 save RPC 的 `token` 字段，由宿主以 workspace 密钥加密保存，`bearer_token_env_var` 仅作可选兼容。真实宿主的服务注册、加密保存/secret 注入和工具调用仍需单独验收；代码与隔离 fixture 不等于真实 Dot 已接通，也不证明真实加密。

建议控制进程运行在用户控制的 HTTPS 入口后，通过新 /happy-control 路由与 /happy 静态页面、/home-relay 并存；worker 只需出站 HTTPS。反向代理、证书、7100 端口可达性和平台网络规则仍待实地核验。现有 daemon 的本地 control HTTP 不应公开。

## 安全/兼容边界与上线前确认

- 服务端只保存非秘密 grant/intent/指纹与过期 nonce；目录 0700、文件 0600，fsync 和原子替换。任务文本/结果不持久明文。锁目录只允许一个网关进程；崩溃留下的 owner lock 不自动抢占，需先核验旧进程再由操作方处理。
- nonce 清理与限流惰性进行，没有后台维护进程。grant/receipt 不自动清空，保留幂等历史。注册表公钥轮换不允许继续使用旧 grant。
- 同站点 owner 请求需要正确 Origin 或 same-origin Fetch Metadata。默认仍只接受固定主 origin；确需本地 Web 开发时，可在 host 配置 `additionalBrowserOrigins` 显式加入最多16个规范化 HTTPS 或 loopback HTTP Origin（例如 `http://localhost:8989`），不接受通配符、路径、凭据、query/hash、重复项或非 loopback HTTP。额外 Origin 的 `/happy-control/v1/` 预检返回空204，固定允许 GET/POST/DELETE 与 Authorization/Content-Type，响应只回显该精确 Origin 并带 `Vary: Origin`；不启用 credentialed CORS。预检不执行 owner 鉴权或变更，所有实际 owner 请求仍逐个验证 Happy Bearer。automation API 必须独立 proof；不使用 cookie 认证。普通消息体限 256KiB；worker/result 单独限 32MiB，发送前先投影脱敏；日志请求 limit 最多 500，但每页实际最多 100 条以约束最坏 JSON 字节数，按 nextCursor/hasMore 继续。按 IP/身份/配对请求限流；部署前按实际并发配置，不能靠代理伪造身份。
- audit sink 只接收路由模板、已验证的非秘密身份 ID 和状态，不接收 body/header/原始错误；worker 状态回调也只接收固定 code。文本脱敏不能识别任意自然语言中的秘密，批准范围内的内容本来就会交给获准助手。
- 首版单进程网关、Unix/WSL、生产建议 Node >=22；不支持多副本文件共享。正式 worker 要求 dataKey 模式，只能访问 daemon 已知记录密钥的会话；未知/legacy 记录拒绝，不退回复制账号主密钥。
- relay 继续使用已有 v2 sessions / v3 messages / 唯一 localId。新 core/worker/proof 都是协议 1；能力实时探测，不按未变的 npm 版本号猜测。旧 App 登录和普通 CLI/daemon 路径保留。
- App 批准页有纯 adapter/模拟原生 UI 测试及类型检查；没有真实浏览器、手机扫码、推送或在线服务验收。

真实任务接入仍需明确授权：持久secret provider与签名调用端；client/worker公钥和owner绑定；准确机器、项目realpath、方法、既有会话ID、期限；批准页实际发布；daemon受信bootstrap/更新窗口；实际工具或平台适配。99.55/99.57短期TLS、REST服务和新路由已试部署，真实账号身份/grant及worker仍未配置。


## 生产接入代码（host已试部署，worker/MCP未启用）

新增入口 `happy-agent/automation/production` 无启动副作用；导出严格 `hostConfigSchema`、`workerConfigSchema`、`prepareHost`、`startHost`、`mountHttpMcp`、`oauthVerifier`、`SecretProvider`。机器契约由 `docs/api/automation-production.config.schema.json` 给出。

```sh
# 两个独立启动示例；本次host由容器/systemd启动，worker命令未执行
node packages/happy-agent/bin/happy-control.mjs --config /etc/happy-control/host.json
node packages/happy-cli/bin/happy-control-worker.mjs --config /etc/happy-control/worker.json
```

只有 host 监听，schema 强制 127.0.0.1；worker 只向固定 HTTPS `/happy-control/v1` 出站。worker 入口先验证 provider/pin/项目 realpath，再显式加载指定 HAPPY_HOME_DIR 与 relayURL；持久 relay override 与配置不一致时拒绝。该入口只读已有 dataKey 认证和 machineID，通过 GET `/v1/machines` 验证服务器上的既有机器，不新建账号/机器、不走登录、不以离线最小对象继续。已有 daemon 状态（包括损坏内容）、未知锁均拒绝，不抢占；原 UI/普通 daemon 默认路径不变。必须安排更新窗口把现有 daemon 换成显式受管入口，不能旁边起第二个同机器 daemon。

`/livez` 表示进程可响应；`/readyz` 检查本地 state/proofs 可读及审计健康，不要求 grant 已批准，避免 bootstrap 死锁。secret provider 在 listen 之前加载并校验 pin，失败不开 listener；运行期签名失败拒绝请求。readiness 不证明手机、反代、AS 或 worker 在线，真实依赖分别验收。`GET /happy-control/v1/compatibility` 是无秘密版本协商；`/capabilities` 仍需已批准 grant 并实际探测 worker/core。

`EncryptedCredentialProvider` 只读显式引用的加密 PKCS8，与 service manager 私有凭据目录里的口令组合，返回 signer、不返回私钥。拒绝明文 PEM、错误公钥、owner/mode 不符、symlink/hardlink、缺失资料；错误不带底层路径/口令。目录需当前 uid 所有、0700/0500，文件0600/0400，路径不得穿 symlink。无默认明文密钥文件、环境口令或生成命令；`SecretProvider` 可替换为受控 vault/HSM，不必导出私钥。fixture 产生的临时加密文件退出清理；Node KeyObject 的内存不承诺可显式零化，provider.close 后 signer 拒绝继续使用。

非秘密配置与服务/反代样例在 `deploy/automation/`；99.55 site派生host单元已安装试运行，通用worker/MCP样例未应用。配置文件要求0600，JSON只含公钥/ID/路径/refs，禁止放private key/token/master key。实际99.55系统与OS操作用户、短期TLS权限已核验；4090 worker、持久加密credential provider和LoadCredentialEncrypted仍待安全通道配置及验收。

## HTTP MCP 与认证注册契约

`POST /happy-control/mcp` 使用 SDK 1.29.0 Streamable HTTP，逐请求创建独立 server/transport；无共享可变 grant getter、无跨租户 MCP session、无工具通知订阅持久授权。GET/DELETE 由 SDK stateless 语义处理。固定工具输入输出仍调用原有 REST adapter。

### service-token-v1 模式

在已有 `serviceTokens` 的 host 配置中加入 `mcp: { "mode": "service-token-v1" }` 即可显式启用，完整非秘密片段见 `deploy/automation/service-token-mcp.host.fragment.json.example`。MCP 与 REST URL 从同源 `origin` 派生；此模式不需要 OAuth、binding、grantID 或签名 secrets。未启用 `serviceTokens` 时配置拒绝启动。

每个 MCP HTTP 请求都通过 gateway 内同一个 `ServiceTokens.authenticate` 验证 `Bearer hsvc1...`，然后创建独立 `ServiceTokenClient` 调回原 REST。工具调用仍执行 grant、方法、项目、会话和 worker 检查；撤销、到期、登记变化或令牌损坏会阻断后续请求。该分支不注册 `happy_request_connection`，不发布 OAuth protected-resource metadata，也不返回虚构的 OAuth challenge。

Dot 的 App 面板可选择「Happy Control 配置示例」，保存的 JSON 只有 MCP URL。宿主声明 `capabilities.storedToken=1` 时，首选在掩码 `MCP Token` 字段填写 Token 本身（不含 `Bearer` 前缀），通过加密 `testloop-mcp-connections` RPC 的 save `token` 字符串交给 TestLoop 宿主，由宿主使用 workspace 密钥加密保存；编辑时留空保留旧 Token，明确清除则传 `token: null`。`bearer_token_env_var: "HAPPY_CONTROL_SERVICE_TOKEN"` 是可选兼容方式，由宿主环境/secret provider 注入。不同项目范围继续使用不同服务 grant；MCP 不扩大原授权。隔离 fixture 只验证 RPC 形状与脱敏，不证明真实加密或线上接通。

2026-11-05已完成真实专用联调：55控制镜像`sha256:7a8f1983655a7ca4fe93f3f60a19911aa1283f05a448f88e04441dbbe2d0fb42`成对部署，57持久`/etc/happy-control-proxy/route.conf`增加精确MCP路由并由TLS ensure保持；Relay和4090 worker未改。原生容器fixture84项通过，公网匿名MCP 401、metadata 404、异Origin 403。真实TestLoop storedToken、只读、create/send/status/events/result、取消stopped和撤权拒绝均通过；测试连接、Dot绑定和加密Token已清理。Dot多步回复超时已在TestLoop单独修复并部署回归，详见其`.e2e-artifacts/mcp-timeout-20261105T135744Z/`。Happy证据位于本仓库`.e2e-artifacts/mcp-live-20261105T111014Z/`。

### MCP Skills 操作指南

Happy 使用官方 `@modelcontextprotocol/server@2.4.0` 的 SEP-2640 SkillsExtension 发布 `packages/happy-agent/skills/happy-control/SKILL.md`，URI 为 `skill://happy-control/SKILL.md`。catalog 在 host 启动时严格加载一次，OAuth/service-token 的每个 stateless server 在 connect 前复用 attach；npm 包和 control 镜像显式包含该文件，不能依赖运行时下载或写入。

指南覆盖真实连接/项目/机器发现、create/send 分离、稳定 requestID、原 ID 回查、turnID/cursor、取消实停、权限与秘密边界、长任务异步跟踪及业务未验收。TestLoop 只对当前 Dot 显式绑定且启用的服务发现 Skills，使用官方 SkillsClient 校验 URI、大小、SHA-256 与 frontmatter；dynamic/未验证或含凭据的正文在模型启动前拒绝。验证后的正文与摘要封存到本轮 context.mcpSkills 和 inputDigest，prompt/invocationDigest 同步绑定；恢复及 optionsDiscovery 不重新读取或升级 Skill，空快照也不重复请求。Skill 不增加工具、grant、项目或模型权限。

2026-11-06真实验收：Happy 控制镜像`sha256:2657e5fb4359262d7c3e5526063204337f51f0b6b2848d025435f1bd3b1a2132`已部署，86项原生镜像检查及23项协议/权限测试通过；TestLoop 使用`dots-mcp-skills-20261106T000033Z`，快照32项检查通过。真实Dot轮次`21d31c06-bfb8-4a9b-9f90-12d46e3d4228`为applied，Skill digest与打包文件一致、prompt digest正确、happy_projects实际完成，未创建业务任务。专用grant撤权后访问拒绝，测试连接、Dot绑定及加密Token已清理。证据见TestLoop `.e2e-artifacts/mcp-skills-20261106T000033Z/`。

### OAuth 模式

`GET /.well-known/oauth-protected-resource/happy-control/mcp` 与 401 WWW-Authenticate 发布受保护资源元数据。`oauthVerifier` 只验证可信 AS 的 JWT access token：固定 HTTPS issuer/JWKS（同 origin、拒绝重定向）、固定 audience=完整 MCP resource、算法白名单、exp/iat、最多15分钟 lifetime、`happy:control`、subject/tenant/client_id 或 azp。**它不提供 AS、OAuth 登录、PKCE、动态 client registration、refresh 或 token 颁发/撤销端点。** 上线需既有标准 AS 提供这些能力并核验平台接受的注册/redirect URI/resource 协商，不能称 OAuth 集成已验。

每条配置绑定 `(issuer, subject, tenant, oauthClientID)` 到固定 Happy client/user、key ref、grantID 与最大 worker/machine/project/method/session/期限范围。注册表 client 上的 `externalIdentity` 与之必须完全相同，并进入批准 digest/页面；更改映射会使旧 grant 持久失效。每次工具执行重新查询 grant，撤销/过期/网络故障均拒绝，REST/worker 再做实际范围检查。OAuth identity 本身不给 Happy 权限。

初始可不配 grantID，此时只能在绑定的最大 scope 内调用 happy_request_connection。用户在原 Happy 选定 relay 的“账号→助手连接”或专用 QR/deep-link `/automation?connection=ID` 审查、批准；普通账号 QR 不参与。运维将已批准的非秘密 connection ID 固定到该绑定，重载新增控制进程的配置；不会自动挑另一条历史 grant 或复活撤权连接。这个首版显式绑定步骤是已知限制，不是假装已有自动 OAuth-grant 兑换。

公钥 pin 改变需重新批准；口令/provider轮换且公钥不变可保留原 grant；OAuth subject/tenant/client 变更需重新批准。Happy grant 撤销立即阻断后续工具/内容返回；AS JWT 离线验证不能立即发现 AS 单独撤销，最长受15分钟寿命约束。需要更短即时撤销时由 AS 提供 introspection，并以同一 TokenVerifier 接口适配，不宣称本版已有 introspection。平台应安全托管 OAuth 凭据；不要求用户在聊天粘贴任何 credential。

`deploy/automation/mcp-registration.json.example` 是 service-token-v1 的 Dot 注册契约示例，包含完整 MCP URL、`delivery: "storedToken"` 和固定工具清单，不包含真实令牌或环境变量引用。OAuth 模式仍按上面的外部 AS、binding 和 protected-resource 契约配置。真实 TestLoop 宿主的支持、加密 RPC、workspace 密钥保存和工具调用必须单独验收，不能把示例或本仓库 fixture 当作线上已注册或真实加密已验证。

手机与Web的批准页面在本仓库 `packages/happy-app/sources/`；Expo `app.config.js` 当前 runtime=21，个人preview目标为 owner `prophetwayen`、项目 `1d018bd8-34db-4b57-a0a9-61f24671153e`、channel/environment `preview`、iOS bundle `com.prophetwayen.happy.preview`。app.config.js 缺少个人覆盖时仍会回到上游默认；preview-store/submit 不能直接照搬，发布前须按 AGENTS.md 核验。本轮改动为JS页面与适配，没有新增原生模块；这不替代实际手机runtime/连通性验收。本次未执行Expo/native/OTA构建或发布。

## 分阶段上线与撤回（待专门授权）

1. 确认实际 HTTPS/反代主机、路由、证书与7100可达性；确定控制主机、OS用户、AS和平台已支持的注册方式。历史部署文档不作为现网证明。
2. 在独立发布目录按锁文件安装/构建；注册 client/worker 公钥与外部身份，通过安全 provider 托管新组件密钥。并行新 REST+MCP 进程，现 UI/relay 不替换。没有批准 grant 时应 healthy/ready，但任务接口拒绝。
3. 反代仅增新路径，proxy_pass 不带 URI，保持完整路径/query参与签名；不记录 Authorization、请求/结果正文、原始 query。用 fixture 检查正确路径成功、被重写 query 必须 INVALID_PROOF。样例不调整现 TLS 或站点安全规则。
4. 经同意的 daemon 更新窗口启用受信 worker；核验已有 owner、机器ID、公钥pin、project realpath。保守示例可选4090Wsl2；`/home/dev/code/agent-runtime-bridge` 仅在当前任务结束并单独选定测试范围后考虑，本次从未读取其任务或发送测试指令。推荐另建隔离测试目录/专用会话。
5. 用户通过专用助手页审查固定 machine/project/method/session/expiry/外部身份，真实扫码批准一次。只对专用测试会话验收 create→send→cursor/result→cancel+stopped/unknown、断连回查、expiry/revoke；UI/relay原有会话保持可用。
6. 确认真实平台 registration/网络/安全凭据托管后，才接我方 MCP 并验收工具发现与调用。URL存在不等于助手能访问或已有认证。
7. 失败时先撤销 grant，停新 REST/MCP/worker，撤回新增反代段；按核验备份恢复原 daemon 的启动方式。任务取消与组件撤回分开处理，不靠停控制进程推断任务 stopped。保留最新 grant/receipt/revocation 元数据，禁止回滚到撤权之前的 state；stale gateway owner/daemon state/lock 仅在证实原进程退出后由操作方处理。

必须逐项批准的剩余范围是：client/worker身份及公钥、准确user/machine/project realpath与methods/session/期限、撤销/轮换、持久provider和调用工具、批准页发布、daemon更新窗口、真实扫码。2026-11-04只执行了明确批准的99.55/99.57空注册试部署、短期TLS与反代；长期provider、全新完整安装、AS/dot集成及真实任务授权仍未验。

## 早期本地验证记录（截至2026-11-03）

当时本地相关测试：Happy Agent 74项、CLI 17项、App 27项，共118项通过；Agent build与CLI/App类型检查通过，隔离目录worker入口pkgroll与模块加载通过。覆盖真实SDK HTTP MCP→签名REST→受信worker→原控制/receipt，全部使用短时fixture。当时没有真实外部发证/登录、relay或用户会话；本次目标服务器结果另列于末节。

```sh
# 可立即本地执行，会自行退出并清理临时loopback listener
pnpm exec tsx packages/happy-agent/examples/rest-fixture.ts
pnpm exec tsx packages/happy-agent/examples/http-mcp-fixture.ts
```

在全新空临时workspace复制当前所有manifest/lockfile，执行离线 `pnpm install --offline --frozen-lockfile --ignore-scripts`：冻结锁一致性检查通过（resolution skipped），零下载；完整安装因缓存缺少 `@react-native/virtualized-lists@0.83.1` tarball 失败，临时目录已清理。不能把复用现有node_modules的build称为全新安装成功；本次也没有执行全新依赖的postinstall/native构建。

pkgroll 提示 bin wrapper 不在dist和空声明chunk；React UI测试有react-test-renderer弃用提示，需与真正失败分开记录。真实扫码、服务器集成、手机/浏览器E2E、本助手工具注册均未验证，没有启动浏览器或CI。


## 99.55部署配置准备（2026-11-03，当时未上线）

以下保留当时的准备结论；2026-11-04已完成部分现场验收，以末节真实试部署记录为当前状态。

2026-11-03已只读SSH核实：relay实际运行在99.55:8193；网页与7100 HTTPS入口由99.57的bim-nginx-1.30提供，原/home-relay/转发到99.55。99.55宿主Node10，不适合直接运行新控制组件；两套已有NGINX属于其他应用。

具体本地配置见 `deploy/automation/site-99-55/README.md`：独立Node22 REST与NGINX容器，REST继续127.0.0.1监听，通过共享namespace访问；55只发布内网9011→NGINX9443，57新增完整路径代理，内部HTTPS双向证书验证。仅选择直接REST签名，没有启用MCP/OAuth。示例的公钥/身份/镜像/expiry/PKI都未配置，不能直接上线。

配置检查：`node deploy/automation/site-99-55/check.mjs --templates`；合同测试：`node --import tsx --test deploy/automation/site-99-55/config.test.mjs`。不读取真实env/凭据，也不联系服务器或Docker daemon。`happy-control-pair.service.example` 使用systemd管理前台Compose整组，Docker自身restart关闭，任一容器退出后成对重建，每300秒最多3次、间隔10秒；仅本地语法与模拟管理策略下的真实Compose已验，目标systemd未启用/验证。REST健康不能证明网关恢复，活进程卡死不在退出恢复范围。57新增PKI mount可能需要容器重建，不能承诺仅reload。目标镜像/NGINX/TLS/NAT、worker更新、批准页面发布及助手调用端仍未验。


该site配置的新增6项本地合同测试通过，覆盖Compose隔离/暴露、跨范围拒绝、readiness失败关闭及两层模拟代理验签。独立临时两workspace按冻结lockfile完成离线安装、wire/agent构建、production-only离线安装和产物模块加载，未使用现node_modules冒充干净安装。首次legacy deploy元数据解析失败已改为同lockfile的第二次production-only冻结安装，未修改依赖版本。此结果仅涵盖选定Node workspace，不替代此前未完成的全量monorepo安装或Docker/NGINX实测。


## 本地原生容器验证（2026-11-03，未部署）

`deploy/automation/site-99-55/container-fixture.mjs` 已实际构建Node22.23.2镜像，并在回环端口运行原生NGINX1.31.6两层代理、fixture PKI与生产REST。本轮复用同一fixture镜像验证38项原生检查，另有14项site合同/中断管理/成对策略测试通过；SIGINT/构建CLI中断的清理有实际记录。具体结果、边界及镜像ID见同目录README和validation.local.json。owner、worker transport、daemon及relay仍是模拟，未真实扫码/授权/更新机器或注册云端工具。

此前Docker单独重启control会让namespace分离、入口15秒未恢复；现在真实前台Compose观察REST直接restart（退出0）或NGINX强杀（137），模拟systemd策略成对重建，未手工reload外层代理即恢复，授权/receipt/幂等/撤权/过期均保留。REST硬杀的stale owner lock不自动删除，三次尝试后两成员停止、入口不可用；这需获准人工恢复，不能称所有崩溃均自动可恢复。目标Docker27、NGINX1.30.1、systemd运行/限流/主机重启、实际PKI/NAT/SecretProvider仍未验，不能据本地结果直接上线。TLS叶私钥默认/run内存投送；未配置真实凭据。

## 真实目标受控试部署（2026-11-04）

用户当次明确批准当前固定源码快照例外和24小时tmpfs内部mTLS；没有commit/push/merge。新REST/网关已在99.55运行，99.57原NGINX仅热加载可选内存glob路由，没有重建；原Happy/relay保持200，原容器ID/启动时间不变。运行配置clients/workers为空，没有真实Happy grant、4090 daemon更新或云端签名凭据。TLS网关证书是传输材料，不是助手API身份或Happy账号授权。

Docker27.3.0、Compose2.27.3、systemd239与NGINX1.30.1的真实链路已验：mTLS正确链200、错误CA/SAN/缺失或不可信client拒绝、其他来源持有效测试cert仍403；公网9项未授权稳定JSON合同均401。真实systemd下REST/网关退出成对恢复、人工停止、三次启动失败限流与有效配置恢复均已验。显式stop的Compose退出130由SuccessExitStatus正确分类，实际容器停止另行核验；systemd239限流证据使用journal与NRestarts，不靠单个Result字符串。

一次性截止清理为2026-11-05 00:01 Asia/Singapore；脚本检查/定时状态已验，未来触发本身未发生。撤下/恢复内存route已实测404→200，原站均正常。长期secret provider、真实批准/worker/任务控制/助手调用仍未完成；本次不等于完整产品上线。完整公开证据、主机路径、回退边界与截止信息见 `deploy/automation/site-99-55/validation.trial-2026-11-04.json` 和同目录README。


## 2026-11-04 长期REST基础设施与固定签名接入

用户明确批准root-only持久TLS私钥及服务解锁材料（可包含明文）的例外，助手签名私钥仍加密PKCS8。55/57分别建立本机专用CA，互换公有根；内部leaf30天、每日续期/每分钟恢复，原24小时trial timers已撤。真实新链、剔旧根、两端各一次leaf轮换已验证；未来timer触发和整机重启尚未验证。root/主机被攻破可取得本机解锁能力，不能描述成所有secret静态加密。

固定`happy-control-call`复用同一REST/MCP工具契约；受控Root wrapper仅通过既有SSH接收JSON，短时隔离容器装载签名器，完整路径/query送至原站新增REST路径。当前本助手已能以这条明确调用链发出真实签名REST请求；没有真实grant时被拒绝，未调用任务/会话操作。当时动态MCP平台注册未配置，不影响这条已有执行工具的等价REST接入；2026-11-05的真实Dot MCP联调另见上节记录。

新的caller角色配置见`docs/api/automation-production.config.schema.json`：显式endpoint、公钥pin、identityRef、grantID或受控connectionScope，以及加密provider引用。命令输入不含URL、私钥或任意shell。`happy_request_connection`只提交预置scope；task create/send仍各自持久幂等，unknown后查同一requestID。

配置maxGrantMs仍默认1小时；schema允许操作方显式设定不超过7天的上限，实际部署策略仍1小时。扩大期限、机器/项目/method/已有session范围都必须在用户批准页精确确认。当前workers=0、真实grant=0；用户选择等维护窗口更新现有机器daemon。本次未更新该daemon或影响bridge会话。批准页本地构建/类型检查通过，线上网页、真实扫码/worker/任务闭环仍待维护窗口验收。

生命周期修复：生产host在启动前安装SIGINT/SIGTERM listener，启动中暂存shutdownRequested，关闭阶段用closing guard去重，避免supervisor与Compose的重复信号打断异步关闭而遗留owner锁。隔离子进程先复现失败后通过；部署遇旧锁仅在确认无owner后一次原子移至审计备份，保留state/proofs，不增加自动清锁。源码/部署路径与证据：`deploy/automation/site-99-55/README.md`及`validation.production-2026-11-04.json`；前文trial和local结果是各自历史范围。


## 2026-11-04 现有机器worker维护窗口

用户明确开启维护窗口，原21个会话进程PID/starttime/cgroup保持，旧Main源与dist未覆盖；同机已有账号/machine的数据密钥由本地正常客户端验证，使用独立固定release运行受管worker。完整CLI+happy-agent+happy-wire冻结安装/类型/打包及原生spawn helper验证通过，已真实签名worker busy通道探针与same-machine连通，且真实worker stop/start自然释放其state/lock。CLI仅补声明已锁定版本的类型SDK，未升级运行时依赖。

worker与恢复controller均显式KillMode=process，恢复CG独立。managed退出取消签名HTTP、限时drain/远端声明，专属ownership guard核验state PID、UID与锁FD inode；发现foreign owner不删除其文件、heartbeat不覆盖。控制器只有当前invocation/时间归属的PID才可作已知owner，失败回退不强杀/重启现有sessions；未真实故障触发rollback，不能声称灾难恢复已验。

Web批准页现已原子发布并保留旧hashed资源，实际HTTP/JS/WASM路由检查通过；浏览器权限未获明确答复，尚无真实浏览器或扫码/owner批准验收。用户在已有Happy网页登录后单独批准有限automation连接，不向助手转交cookie/master key。首次scope仅专用测试项目、新建session、有限方法与55分钟，真正授权需要本人按钮确认；pending申请本身不授予控制权。

公开当前证据：deploy/automation/site-99-55/validation.worker-2026-11-04.json。既有运维执行通道可调用签名REST，独立平台MCP注册仍未做；真实任务create/send/receipt/cursor/turn/cancel闭环等待owner批准，任何unknown均不得当作已停止。
