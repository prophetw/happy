# 30 天服务令牌：99.55 / 99.57 发布与回退

2026-11-04 本人随后明确批准部署：固定应用树 `d587ffdf686c46509cc59a4cc88a63991ad638a1` 已上线55 REST和57 Web，公开记录见 `validation.service-token-live-2026-11-04.json`，当前操作入口见同目录README首节。登记“后端联调测试”只是公开身份配置；没有替本人批准、生成真实token或配置接收后端托管。接收后端secret-provider/安全交付引用仍未配置，所以只读plan审阅器继续返回deploymentReady:false，不可拿它冒充现场执行证据。

以下配置包说明与步骤保留准备阶段的状态（其中“本轮未执行”“尚未构建”等指准备阶段）；当前制品、容器、状态和HTTP/浏览器结果以最新线上记录为准。执行其他发布时仍须重新核实基线，不能重用旧assertion覆盖并发变更。

## 配置文件及最小变更

- `service-token-rollout.json.example`：站点、固定应用源码树、历史回退基线、候选镜像/Web 摘要、非秘密服务身份、测试 scope、交付引用及不可放宽的边界。
- `service-token-plan.mjs`：只审阅公开 JSON，或在公开资料完整后导出单字段 host patch；没有 apply、SSH、Docker、授权或文件安装能力。
- 通用 host 字段示意继续复用 `deploy/automation/service-tokens.host.fragment.json.example`；本站点实际补丁应由已填写的 rollout plan 导出，不能直接把通用示例覆盖现用 host.json。
- 本文给出未来执行顺序与停止条件，不是本次执行指令。

| 位置 | 拟变更 | 保留 |
| --- | --- | --- |
| 99.55 | 经验证的新 REST 镜像；host.json 仅新增 serviceTokens | 9010 loopback、9011 私网网关、原签名身份/worker表/maxGrantMs、状态目录、mTLS、成对恢复单元 |
| 99.57 | 原子切换 `/happy/` 静态发布目录，带新版服务授权页 | 现有 Nginx 容器、7100 HTTPS、证书、`/happy-control/v1/` 代理、`/home-relay/` |
| 4090Wsl2 | 沿用现有 worker 与 automation-test scope | 当前 daemon/worker、Happy 凭据/记录加解密能力、原有会话 |
| 接收后端 | 后续独立托管自己的服务令牌 | 不接收账号主密钥、本助手签名私钥、运维 SSH 凭据 |

`/happy-control/v1/` 的现有前缀代理已覆盖 `/service-connections`、`/service-connections/options` 与 `/connections/{id}/service-token`。无需新增公网端口或 MCP 路由；不能改 proxy_pass URI、丢 query、关闭 TLS 校验或开启请求/响应内容日志。该结论来自模板合同；当次现场路由、证书有效性和网络可达仍须核实。

## 已固定与待填写的资料

应用源码为当前已验证服务令牌实现的 Git tree `d587ffdf686c46509cc59a4cc88a63991ad638a1`，是固定源码快照，不是提交。它包含上轮 129 项暂存状态；本包的说明/审阅器不改变应用代码，也不要求 commit/push/merge。后续镜像构建必须来自该固定树的干净隔离归档，不能把后来工作区文件混入；正常发布若改用已提交 main，应重新核验对应源码、个人 fork 和现网已发布功能，不自动合并。

已另存本地 Git 忽略的源码归档：`.e2e-artifacts/service-token-rollout-preparation/application-source-d587ffdf686c.tar.gz`，包含应用、CLI fixture daemon、wire、锁文件和部署模板等必要源码；具体包含范围、SHA-256 见同目录`source-archive.json`及本轮验证记录。它不含 node_modules、运行状态或未跟踪文件，不是镜像，也未传输到服务器。未来从该归档构建并先核对摘要，不依赖悬空 Git 对象长期存在。

记录中的旧 REST image ID、网关 image ID、Web target/index digest 仅是历史基线。若现场 image、路径、静态目录或配置不匹配，停止，先查清其他发布；不能拿本包覆盖之后上线的修复。

候选 REST 镜像尚未构建，`controlImageID` 和归档摘要故意为 null。这里使用已装载 Docker **本地 image ID**（`sha256:…`、pull never），不是 registry manifest digest；不能把 image ID 拼成任意 `repository@sha256:…` 来拉取。网关沿用已经核实的镜像，部署前重新 inspect 比较 ID。

Web index 摘要对应已本地导出验证的 `/tmp/happy-service-token-web-final-20261104`。该目录不是长期制品库；未来归档/传输必须计算 `webArchiveSHA256` 并核对 index SHA。如果丢失或重建产生新摘要，先重新验证与更新制品记录，不伪称相同产物。

仍需确定：

1. 接收后端的服务名称。技术 ID、Happy owner userID、公开 generation 由操作方从获准账户/登记流程核实后填入，无需用户手抄 ID 或提供密码。
2. 正式业务项目及方法。当前计划只提出 `/home/dev/code/happy-automation-test`、新建专用会话、首次 1 小时验收；不是已授权 scope。业务项目不在本包内自动加入 worker 白名单，更不涉及 agent-runtime-bridge。
3. 对方后端的 secret-provider 与安全交付渠道，只填非秘密引用 ID。页面只交付一次；不能在聊天、URL、日志或 Git 中转交令牌。
4. 新镜像/Web 制品摘要，以及 REST 控制面短暂不可用的执行窗口。30 天是可选上限，不会因启用配置自动创建长期 grant。

## 本地审阅及公开补丁导出

在仓库根运行，仅读本地示例：

```sh
node deploy/automation/site-99-55/service-token-plan.mjs --review
node --test deploy/automation/site-99-55/service-token-plan.test.mjs
```

当前结果应为 `publicPlanValid:true`、`publicPlanComplete:false`、`deploymentReady:false`，列出身份、镜像、归档及后端托管引用的缺项。这是预期状态，不是部署失败。审阅器即使收到全部填写的公开资料，也始终返回 `deploymentReady:false`：它不能代表真实授权、制品安装和现场预检。

后续把计划复制为本地审核文件、填入经核实的公开值后，可运行：

```sh
node deploy/automation/site-99-55/service-token-plan.mjs --review /path/to/public-rollout-plan.json
node deploy/automation/site-99-55/service-token-plan.mjs --host-patch /path/to/public-rollout-plan.json
```

第二条仅向 stdout 输出 `{ "serviceTokens": ... }`；缺项时拒绝输出。它不读取真实 host.json，不安装配置，不代表用户已批准。实际变更只允许在原配置副本中新增该字段；原 clients、workers、maxGrantMs=3600000、listen、stateDirectory、mcp/provider、PKI 不得随模板覆盖。若现场已存在 serviceTokens 或登记内容与预期不同，停止并审阅差异，而非覆盖列表。

## 未来经授权后的发布顺序

1. **先完成制品验证。** 从固定源码树隔离构建，使用现有 Dockerfile、pnpm 10.11.0、冻结 lockfile 与阿里源；不发布上游包或触发 CI。以新镜像做隔离 loopback/native-Nginx 服务令牌验收，保存真实 image ID、归档和 Web 摘要。上轮源码 fixture 通过不等于新生产镜像通过。这一步本轮未执行。
2. **只读现场预检。** 核实 55/57 服务/镜像/静态 target、原 7100 routes、mTLS 与证书维护单元、私网路径和状态挂载。核实 4090 原 worker 的机器、项目 realpath、方法及协议1；不读账号密钥、.env、浏览器态或 TLS 私钥值。若换业务项目，另外审查 worker scope 变更，不顺带重启共享 daemon。
3. **准备有限回退材料。** 在主机私有目录保存旧非秘密 host 配置、deploy.env 的镜像/路径元数据、release target、Web target 和摘要。状态检查点须在停止该控制对之后取得并私密保存；不把私钥或凭据混入源码包。不复制/覆盖 relay 数据卷。状态检查点仅供灾难恢复，不作为常规降级的回滚写入。
4. **切换 55 控制对。** 仅在批准窗口停止 happy-control-pair；保留现有 state 及其中的 grant、撤销、proof tombstone、intent/receipt。部署经审阅的候选 host（仅新增 serviceTokens）、在原 deploy.env 中只更新 CONTROL_IMAGE，再切换已准备 release 并启动原成对管理单元。不得仅替换 control 容器、重建 relay 或新建单独自恢复容器；55 网关随 namespace 成对恢复、复用原网关镜像与 TLS。短暂 REST 不可用期间 worker 失败关闭；在途变更可能 unknown，按原 requestID 回查，不能承诺控制面零停机。
5. **先验证新 REST。** 本机 livez/readyz、HTTPS compatibility 的 serviceTokens.protocol=1、maxGrantMs=2592000000、OpenAPI service paths 正确。确认正常签名 clients 仍工作，普通 Happy/relay 健康且原服务未被重启；确认 worker 出站重连。此时仍不应有服务 token。
6. **切换 57 静态页。** 解包到新的隔离 `.happy-releases/...`，核实 index/资源摘要，保留旧 hashed assets；原子切换 happy symlink，不覆盖目录、不重建/重载现有 Nginx。验证匿名登录边界、服务页资源和 console/network，再由本人登录后审查服务范围。原生手机服务页未发布，不要求旧手机直接扫描专用 scheme。
7. **本人建立有限服务授权。** 先以已核实身份和测试目录完成明确批准；服务模式必须带 credentialMode，旧页应426拒绝。建议首次1小时验收，后续30天由本人另选。本人点击一次性交付，在获准安全渠道交给后端 secret-provider；后台日志、验收 JSON、截图不得含明文令牌。不由助手代批准，不预置长期凭据。
8. **由真实后端验收。** 在专用新会话检查创建/追加、同ID去重/冲突、消息持久回读、cursor/turn结果，以及 cancel_requested 与 stopped/unknown；跨 scope 拒绝。随后用该测试授权验证撤销阻断和重新连接不恢复。未来业务使用需新的明确 scope，不复用已撤销验收 token。所有结果分别报告，不把 fixture、页面加载或后端部署成功等同真实端到端完成。

## 撤回与停止条件

优先撤回方式：保留新二进制，先停止接收新增服务任务，在有效权限下仅取消本次测试/服务 grant 自建会话并确认实际停止，再由 owner 撤销新增服务连接；如需紧急撤权可先撤销，但必须把尚运行任务的停止状态另报 unknown/待人工处理。不要对日常或 bridge 会话发停止命令。随后移除 serviceTokens 配置并按原控制对重启；已撤销 grant 不会在恢复配置后悄悄有效。Web 可以切回经重新核实的旧 target。

**常规撤回不得恢复旧 state 快照。** 那会丢失后来撤销与幂等记录，可能复活凭据或重派任务。保留当前状态和日志；不要删除 service-token 摘要来“重新生成一次”。交付丢失只能撤销并新建授权。

若确须降回旧 REST 镜像，先完成单独的状态兼容性隔离测试；旧镜像严格配置 schema 不接受 serviceTokens，必须在停止控制对后**同时**恢复匹配的旧配置和旧镜像引用，保留当前状态，并确认所有新增服务 grant 已撤销、旧签名功能和幂等查询仍可用。本轮没有验证旧镜像读取新增状态的真实兼容性；未验证前不盲目降级。若预检/启动/证书/状态有错误，停止新功能，保留证据并报告，不靠换空 state、关闭校验或反复强启“修好”。

## 配置准备阶段完成度（历史）

仅完成本地公开配置与审阅器测试、模板路径合同核对及文档；没有新生产镜像构建/导入、原生 Nginx 集成、现场配置/证书验证、真正服务登记、长期授权、安全交付、部署或 MCP 注册。已有应用层48+22测试及浏览器结果见上一份实现记录，未因本次纯配置准备重复运行。
