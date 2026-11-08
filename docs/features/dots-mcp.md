# Dot MCP 工具连接

在「连接与授权 → MCP 连接」添加HTTP或stdio服务，检查并保存后为每个Dot明确勾选。新Dot默认不启用。
Happy MCP 可用于后台项目执行：连接需提供完整工具和当前授权信息，启用连接后还需为 Dot 明确选择项目；项目默认不启用。
派工、模型目录查询、结果跟进和取消均通过 MCP，继续使用原任务账本、稳定请求 ID 和恢复流程。

「旧连接迁移」显示原 REST 连接及 Dot 项目选择，可显式迁移到 MCP；不再提供 REST 凭据表单。
迁移只核对当前授权并加密转存凭据，原子保留各 Dot 选择、原模板预算和执行默认值，不创建新授权或任务。
失败保留原配置，丢失响应后刷新核对。原任务按原目标继续恢复；迁移后新任务使用 MCP，取消相应 MCP 项目授权也会阻断旧任务后续访问。
未迁移的连接仍使用原兼容链路，历史数据与旧凭据保留。

HTTP服务可直接在Token输入框填写服务Token，不含Bearer前缀；宿主加密保存，列表只返回是否已配置。编辑时留空保留原值，填写新值替换，勾选清除后保存可删除认证。页面切入后台、取消或提交完成会清除输入框内容，不向聊天或模型提交凭据。服务地址变化时需重新填写Token或明确清除，不能自动沿用旧凭据。

原JSON入口也兼容输入专用字段`bearer_token`，字符串保存、null清除、省略保留。服务端会将它从返回配置移除；服务Token不需要用户创建本机环境变量文件。HTTP Bearer环境变量和自定义认证头引用仍可在高级配置使用。stdio启动命令和路径位于宿主，不能通过HTTP Token输入框给stdio传密钥。

可编辑、重新检查、停用、删除服务，并限制enabled_tools白名单。启用服务表示允许Dot在用户请求范围内调用所选工具。
Happy 写工具通过后台任务调用；原生工具列表仅开放 Happy 只读发现工具，避免绕过任务跟进与项目选择。
检查获取工具目录，Happy 服务另读取当前授权，不调用写操作。Token需要支持capabilities.storedToken=1的TestLoop宿主；
后台执行和迁移分别要求 capabilities.happyDelegation=1 与 migrateRest=1。Happy 服务还需提供 happy_connection 授权查询工具；旧服务需升级后重新检查。

配置变更供后续对话使用，不自动撤回已运行的远端调用。保存响应丢失时刷新核对，不自动重发。组件检查使用固定RPC回执，真实协议、加密存储、独立原生调用与恢复由TestLoop定向测试覆盖；不以这些结果代替真机或线上浏览器交互验收。

## 原生记忆范围移动

手机 App 的记忆列表和当前版本详情提供“移至用户级”与“移至当前Dot”。这里只有 Dot 和用户两层；用户级移入当前打开的 Dot。正常操作点击一次，App 自动读取目标 revision 后提交移动，不经过模型、聊天指令或多次预览确认。目标存在同名有效记录时拒绝覆盖，并提示先另存不同名称。

App 使用加密 workspace RPC `testloop-dot-memory-move` 的 `prepare / move / status / cancel`。请求只含当前 Dot、来源范围、key 摘要、源 revision、目标预期 revision 和稳定 requestID；账号及存储归属由可信宿主核验。`targetExpectedRevision` 是原 CAS 条件，回执中的 `targetRevision` 可以是目标保存后的新版本，两者不可混用。宿主先保存目标再删除源，保留原 key、kind、value、expiresAt 及来源，不自动延长有效期。

回执区分“本地完成”“索引中”和“远端清理中”。目标保存、源尚未删除时明确显示未完成；版本变化导致需人工核对时保留记录。索引完成或旧目标版本后来被替代、失效且清理完成，才结束本机待核对状态。“停止本次移动并保留记录”仅停止后续迁移并释放原请求，不回滚已保存副本；已删除源时仍显示实际完成回执。

设备只持久化 requestID、Dot/key 摘要、范围和 revision，按 Relay、认证账号、工作台与 Dot 分区，不保存记忆正文或凭据。超时、组件关闭或 App 重启后，用户可显式恢复原请求；另一设备发现宿主旧请求时也须点击恢复，不自动续写。非有效记录的列表及详情提供“核对未完成移动”，仅查询旧请求，不发起新移动；源已编辑、过期或删除时仍可找回原请求并停止，已删除正文不展示。账号、密钥、服务器、Dot 绑定、授权或前台状态变化，会阻止旧异步读取继续提交移动。完成后读取两层目录；目录刷新失败仍保留已核对的移动回执。

事件回归使用 React Native 组件和隔离宿主数据，覆盖双向入口、冲突、持久恢复、账号变化、部分完成、停止和失败提示。发布前须协调升级 TestLoop 记忆移动宿主和既有 memory gateway，再交付 App，不能仅发布 OTA。该实现未发布 OTA / 原生安装包，真机接收、实际点击和线上索引状态尚未验证。跨仓验证与集成边界见 [2026-11-09 验证记录](../research/memory-move-validation-20261109.md)。


### 原生 Dot 模型设置与清空

创建默认 `codex / gpt-6.1-sol / xhigh`，工作台创建/管理表单使用宿主实际模型目录，强度按模型校验。设置贯通 testLoop Dot 持久化、宿主设置文件和实际 `turn/start` 的 model/effort；忙碌时下一轮生效，输入栏显示宿主回传的生效值。旧配置缺失 effort 迁移至 xhigh，显式值保留；不更改底层 provider、read-only sandbox 或项目授权。

清空由 testLoop 协调停止旧聊天轮次、轮换加密 Relay session、删除旧 session/messages、切换同一 Dot 绑定及提高 epoch。清除宿主输入输出 journal、原生 transcript 和待发事件，旧任务结果不注入新 epoch。用户级和 Dot 级长期记忆、独立后台任务、身份、模型配置与授权保留。App 清除旧会话缓存和待发消息，离线恢复只接受更高 epoch 的轮换证据。操作有破坏性确认及 requestId 幂等恢复，不使用旧的仅换 thread 清空接口。

assistant 历史审计、既存备份和独立项目任务不是聊天入口；不宣称备份或远端介质物理擦除。非原生旧 Dot 目前明确拒绝真正清空，需先迁移原生宿主。部署/维护时必须同时集成 testLoop 与 Happy，已有宿主在后续受控启动新代码时才应用缺失 effort 的迁移。本次没有部署，也没有重启或清空用户当前真实 Dot。

验证：Happy CLI 宿主/状态 21 项、App Dot/离线缓存与同步 59 项通过；testLoop Dot 相关 41 项通过，最终局部补充 8 项通过，两边类型检查通过。本地 Playwright 使用隔离 PGlite Relay、隔离账号与脚本 Codex App Server，验证默认创建、调整后的真实请求、运行中清空、新 thread、Relay 删除、刷新和重启；最终无页面/Console/非预期 HTTP 错误，真实付费模型调用 0。测试曾发现固定会话 tag 和替代会话缺失 host 元数据问题，均修复后复测通过。

| 验收证据 | 截图 |
| --- | --- |
| 清空后替代会话，不显示旧聊天 | [截图](https://szsp.suitbim.com.cn:7100/img-bed/images/a9232f3d-df30-4ab6-96f9-e9afd7b8a6d0.png) |

交付分支为两个仓库的 `feat/dot-settings-clear`，worktree 分别为 `/home/dev/code/happy-dot-settings` 与 `/home/dev/code/testLoop-dot-settings`。未提交、推送、部署；不包含共享工作树已有的会话链接与记忆实现。真实模型服务调用、真机及并行记忆实现合并后的验证尚未执行。

## 离线 Dot 恢复（2026-11-08，已发布）

Dot 对话离线时显示“一键恢复”，调用当前 Relay 的 `POST /v1/dots/recover`，携带当前登录 Bearer token 和原 workspaceId/dotId/sessionId。宿主上的独立恢复服务负责验证账号与原绑定、启动既有宿主服务。HTTP 202 后界面继续等原 Dot presence 上线；未上线或请求失败可重试，保留原聊天与记忆。Dot 不再显示普通 CLI 的终端恢复提示，也不能通过通用 Resume 操作启动第二个原生拥有者。

托管 CLI 在最近150条会话列表中找不到 Dot 时使用既有 v2 分页查找，保持同一tag/密钥/会话，不创建替代身份。Control 使用 Linux flock，锁持有者崩溃后可重启；旧 `.gateway-owner` 协议需在停止唯一实例后留档迁移，不能直接删除运行中的锁。

恢复服务部署配置、独立用户服务和反代路由见 TestLoop `docs/features/personal-assistant-operations.md` 的“Dot 页面一键恢复”。宿主离线、WSL未启动或物理电脑关机时，界面显示实际连接失败；不提供远程开机能力。手机接收新版需单独发布个人 preview OTA；浏览器验证不等于真机验收。

2026-11-08私网Web/宿主恢复服务及[个人preview iOS OTA](https://expo.dev/accounts/prophetwayen/projects/happy/updates/3ba69aa4-47b2-40d7-9346-21a85595fd06)已发布，runtime21，来源82509012；启动包哈希与实际manifest已回读。真机是否加载仍未验证。
