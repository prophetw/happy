# 部署说明：个人 Fork 操作手册（合并 → 构建 → OTA → daemon 替换 → 真机冒烟）

本文档是 fork（prophetw/happy）日常部署的唯一入口，面向“功能分支开发完，合入个人聚合线并发布到真机”的完整闭环。

自建 Relay 的独立服务器测试：使用仓库根目录 `docker-compose.yml`，具体配置、
启动和持久化步骤见 [Docker Compose 测试部署](docs/deployment.md#自建-relaydocker-compose-测试部署)。
此入口只部署 relay API 与路径网关；客户端需使用包含自定义地址支持的版本。
仅运行 relay API 的场景使用 `docker-compose.relay-only.yml`，直接发布 HTTP
`8193`，操作见同一部署文档的“仅部署 relay 服务”小节。

分工：服务端/后端 k8s 部署见仓库内 `docs/deployment.md`（上游，英文）。**本文只讲 fork 特有的操作**：worktree 布局、合并到 fork/main、个人 EAS OTA、daemon 替换、冒烟验证、已知坑。

> 最近实操验证：2026-09-19（合并 847bc6c0 → OTA 30ae3c5d → daemon 1.2.4 → 4/4 冒烟通过）。
> 当前基线：fork/main = `1a5bec38`，happy-agy main = `1878c84c`（含后续 dsh 工作）。

---

## 1. 环境与 worktree 布局

| 路径 | 分支 | 角色 |
|---|---|---|
| `/home/dev/code/happy` | `feat/resume-native-sessions` | 主仓库，/resume 功能开发（有未提交 WIP，勿动） |
| `/home/dev/code/happy-dsh` | `feat/dsh-harness` | dsh(DeepSeek Harness) 集成开发 |
| `/home/dev/code/happy-agy` | `main` | **聚合/部署 worktree**，所有合并、构建、OTA、cli:install 都在这里做 |

Git 拓扑：origin = 上游 `slopus/happy`（HTTPS，无凭据，**不可推**）；fork = `prophetw/happy`（SSH，可推）。worktree 间共享 refs。

分支策略：**fork/main 就是个人聚合点**，不建二级集成分支。功能分支就绪后直接合入 main 再推 fork/main。

外部依赖（均已装好，重装时才需要）：

- `~/.local/bin/dsh` shim → `~/code/deepseek-harness/apps/cli/lib/bin.js`（需先在 deepseek-harness 仓库构建）
- 凭据：`~/.happy/access.key`（happy）、`~/.dsh/.credentials.yaml`（dsh）——凭据文件，任何日志/文档中不得暴露内容

## 2. 合并流程（合入 fork/main）

前提：功能分支已推到自己 fork 远端。在 happy-agy worktree 上操作：

```bash
cd /home/dev/code/happy-agy
git fetch origin fork
git merge origin/main          # 第一步：先吸收上游
git merge <feature-branch>     # 第二步：逐个合功能分支
# 解决冲突 → 验证（见第 3 节）→ 推送
git push fork main
```

已完成的合并（2026-09-19，提交序）：

1. `a17ad796` merge origin/main（dd4cb252）
2. `409e8cdd` merge feat/dsh-harness
3. `847bc6c0` merge feat/resume-native-sessions（后 fork/main 推进至 `1a5bec38`）

### 冲突取舍原则

- **main（更新架构）为基准**，把功能分支的增量端口过来，不反向“恢复”旧实现。
- 典型案例：`EditView` 系列视图里 main 已**有意移除** `trimIdent`（并加了“保留纯空白编辑”的回归测试），即使旧分支有它也不要恢复。
- docs 冲突：取 HEAD（main）侧路径，如 agy 新引擎在 `src/agyStream/`。
- Picker 类冲突：用 main 的 list 式实现（`listMachineChoiceAvailableAgents`），功能分支的可见性需求通过 `harnessCatalog.ts` 的 `EXPLICIT_REPORT_HARNESSES` 满足。

### 自动合并的语义陷阱（必须人工 diff 复核）

`git merge` 的 rename-following + 文本自动合并可能**悄悄丢行为**：

- 某文件被 main 重命名/重构后，旧分支对它的修改可能落到错误位置或直接消失。
- zod schema 改成 `.passthrough()` 后字段变 `unknown`；类型改可选（`input?:`）后原 `parsed.success` 直接引用会编译错。

复核方法：对每个自动合并的文件 `git diff <merge-base>..HEAD -- <path>`，确认功能分支的行为增量仍在。

## 3. 构建与验证（合并后、发布前）

**pnpm 版本铁律：必须 `npx pnpm@10.11.0`**。系统 pnpm 7.9.0 会污染 v9 lockfile。

```bash
cd /home/dev/code/happy-agy
npx pnpm@10.11.0 install            # 如依赖有变

# CLI：全量测试（合并验收时当时 1126 个全绿）
npx pnpm@10.11.0 --filter happy-cli test

# App：类型检查 + 测试
cd packages/happy-app
APP_ENV=preview NODE_ENV=preview npx pnpm@10.11.0 typecheck
APP_ENV=preview NODE_ENV=preview npx pnpm@10.11.0 test
npx pnpm@10.11.0 --filter happy-cli build   # CLI 产物
```

已知基线：**上游 dd4cb252 自带 8 个 `sync.send.test.ts` 失败**（已用 detached 检出 + 软链 node_modules 复现确认，与合并无关）。看到刚好是这 8 个就不要当回归排查。

## 4. CLI 安装与 PATH 遮蔽坑

```bash
cd /home/dev/code/happy-agy/packages/happy-cli
npx pnpm@10.11.0 run cli:install    # 构建 → npm link → 重启 daemon（复用 ~/.happy）
happy --version                     # ← 必须核对！目标版本（如 1.2.4）
```

**`~/.local/bin/happy` 符号链接会遮蔽 pnpm 全局 link**（已踩过：它指向主仓库旧 bin/happy.mjs，daemon 跑的是旧 dist，`--version` 显示 1.2.2）。修复：

```bash
ln -sfn /home/dev/code/happy-agy/packages/happy-cli/bin/happy.mjs ~/.local/bin/happy
ln -sfn /home/dev/code/happy-agy/packages/happy-cli/bin/happy-mcp.mjs ~/.local/bin/happy-mcp
```

`bin/happy.mjs` 是 flags shim（re-exec node --no-warnings --no-deprecation 加载同目录 dist/index.mjs），链到它即可。

daemon 重启序列：

```bash
happy daemon stop
rm -f ~/.happy/daemon.state.json.lock    # stop 偶发留锁
happy daemon start
```

验证（不要只看命令返回）：

```bash
cat ~/.happy/daemon.state.json           # pid + startedWithCliVersion
tr '\0' ' ' < /proc/<pid>/cmdline        # 必须指向 happy-agy 的 dist/index.mjs
```

## 5. OTA 发布

前置：个人 EAS 配置已在 `packages/happy-app/app.config.js`（prophetwayen 项目，**保持未提交**，可用 EXPO_OWNER/EAS_PROJECT_ID 等 env 覆盖）。

```bash
cd /home/dev/code/happy-agy/packages/happy-app
APP_ENV=preview NODE_ENV=preview npx pnpm@10.11.0 tsx sources/scripts/parseChangelog.ts
npx pnpm@10.11.0 typecheck
npx pnpm@10.11.0 exec eas update --branch preview --environment preview --auto
```

要点：

- **runtimeVersion 硬编码 "21"，永远不要 bump**（bump 会让所有已装二进制收不到 OTA）。
- OTA 只能送达「构建时 updates URL 指向个人项目」的二进制；指向上游项目的旧构建永远收不到。
- 上游 bulkacorp 项目对当前账号无权限：`eas build:list` 等操作必须在个人 app.config.js 就绪后再跑，否则报权限错。

## 6. 真机冒烟清单

daemon 换好后在手机上逐项过（2026-09-19 全过）：

| 项 | 操作 | 预期 |
|---|---|---|
| claude 基础 | 新建 claude 会话发一条 | 正常流式回复 |
| dsh 中止续聊 | dsh 会话发送 → 点中止 ×2 → 再发 | 同一会话存活继续（日志：tool aborted → TurnCancelledError 域 turn end） |
| /resume | claude 会话发 `/resume <sessionId>` | 日志出现 FORK BACKFILL replay 计数（实测 89 条），历史回填进当前会话 |
| agy | agy 会话正常跑 | agyStream 引擎工作；`/resume` 在 agy flavor 被**拒绝是预期**（拦截只在 claude flavor 实现） |

手机端目视确认（历史回填后的 UI 显示）需人工看一眼，日志只能证明数据层。

## 7. 日志监听冒烟法

不用盯着手机，监听 daemon 会话日志即可。日志路径：`~/.happy/logs/<YYYY-MM-DD>-pid-<pid>[-daemon].log`。

要点：按文件名做 cutoff（字典序大于 `切换时刻的最新日志名` 才看）、记录 offset 增量 tail、用 /proc 判断 pid 存活、grep 过滤关键行。参考脚本 `/tmp/watch-merged-sessions.sh`（会话级，非 daemon 日志）：

```bash
CUTOFF="2026-09-19-11-18-58-pid-0"
# 跳过 *-daemon.log；base > $CUTOFF 才算新会话；增量 tail + grep:
# "tool-call|Tool:|idle|stopped|abort|turn-end|rror|FAILED|Cancelled|exited|BACKFILL|/resume|esume"
```

排查某会话时先 `pgrep -af index.mjs` 找到 pid，再 tail 对应文件。

## 8. 已知坑速查

| 坑 | 对策 |
|---|---|
| 系统 pnpm 7.9.0 污染 lockfile | 一律 `npx pnpm@10.11.0` |
| `~/.local/bin/happy` 遮蔽全局 link，daemon 跑旧 dist | cli:install 后核对 `happy --version`；`ln -sfn` 到目标 worktree bin |
| runtimeVersion 被 bump | 不许动，保持 "21" |
| daemon stop 留 lock | `rm -f ~/.happy/daemon.state.json.lock` 后再 start |
| WSL 磁盘常年紧张 | 构建/上传前 `df -h`；清过 npm/pip/uv 缓存腾 13G |
| 8 个 sync.send 测试失败 | 上游 dd4cb252 既有，勿当合并回归 |
| agy flavor 的 /resume | 未实现，拒绝是预期行为 |
| 多 worktree 的 dsh 会话进程 | `pgrep -af index.mjs` 时注意 pid 来自哪个 dist，别杀错 |

## 9. 回滚

- **CLI/daemon**：`npm unlink -g happy happy-mcp`（并删除 `~/.local/bin` 下的遮蔽链接）→ `npm i -g happy@latest` → 按第 4 节重启并验证 daemon。
- **App（OTA）**：OTA 按 update 递增生效，不能单独回退某台设备；回滚 = 在目标代码上重新发一个 update（或重装旧二进制）。
