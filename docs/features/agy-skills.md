# Antigravity (agy) Skills Discovery & `/skills` Slash Command

Feature document for Antigravity (`agy`) skills discovery, `/skills` slash command interception, standalone CLI execution, and metadata synchronization across Happy CLI and clients.

## 功能目标

1. **解决 `/skills` 在 `stream-json` 模式下的不可用问题**：
   `agy` 在 `--input-format stream-json` 会话通道中不接受 `/skills`（抛出 `⚠️ /skills is answered by the CLI itself and is unavailable with --input-format stream-json; run it as its own --print /skills invocation`）。Happy 在会话层拦截 `/skills` 指令，使用独立的 `agy --print /skills` 执行并直接向用户下发技能列表，不中断常驻 Agent 进程，零模型 Token 消耗。
2. **毫秒级会话启动技能发现**：
   在会话初始化阶段，通过本地文件系统快速扫描（耗时 < 1ms），将工作区技能（`.agents/skills`）、系统内置技能（`builtin/skills`）与插件技能（`config/plugins`）预填入 `metadata.skills` 和 `metadata.slashCommands`，使客户端（Web、Mobile、Desktop）能够立即获得全量技能的斜杠命令自动补全。
3. **多格式渲染与终端友好展示**：
   提供结构化 Markdown 列表（供 ACP SessionEnvelope / Web / Mobile 客户端展示）以及高亮 ANSI 文本（供 Ink / TTY 终端展示），并提供 `happy skills [--markdown | --json]` 独立 CLI 子命令。
4. **多级回退机制保障高可用**：
   查询技能时优先调用 `agy --output-format json --print /skills`；若 JSON 解析失败，回退解析纯文本输出；若 CLI 无法执行或超时，回退至文件系统快速扫描，确保任何环境下均能返回技能列表。

## 核心入口

| 组件 | 文件 | 角色 |
|---|---|---|
| 技能引擎与格式化 | `packages/happy-cli/src/agy/skills.ts` | 封装 JSON/文本解析、文件系统扫描、独立 CLI 进程调用及 Markdown/Terminal 格式化 |
| 会话层指令拦截 | `packages/happy-cli/src/agy/runAgy.ts` | 会话初始化时预载技能元数据，拦截 `/skills` 并在队列循环中调用技能引擎下发 Turn 信封 |
| 特殊指令解析器 | `packages/happy-cli/src/parsers/specialCommands.ts` | 识别 `/skills` 及附带参数（如 `/skills list`）并标记为 `skills` 特殊指令 |
| 常驻进程安全防御 | `packages/happy-cli/src/agy/AgyBackend.ts` | 在 `sendPrompt` 入口防御性校验，阻止意外向 `stream-json` 输入流写入 `/skills` |
| 独立终端命令 | `packages/happy-cli/src/index.ts` | 支持终端直接执行 `happy skills [--markdown \| --json]` |

## 架构关系与数据流

```
Happy Client (Web / iOS / Desktop / Terminal)
    │
    ├─[1] 输入 /skills (或点击建议列表)
    ▼
runAgy.ts (session.onUserMessage)
    │
    ├─[2] parseSpecialCommand() 匹配为 { type: 'skills' }
    │     使用 messageQueue.pushIsolateAndClear() 隔离并排入队列
    ▼
runAgy.ts (Message Queue 消费循环)
    │
    ├─[3] 拦截执行 fetchAgySkills({ cwd }) (完全绕过 AgyBackend stream-json 进程)
    │     │
    │     ├── 尝试 1: agy --add-dir <cwd> --output-format json --print /skills
    │     ├── 尝试 2 (回退): agy --add-dir <cwd> --print /skills (纯文本解析)
    │     └── 尝试 3 (兜底): discoverAgySkillsFilesystem() 本地文件系统扫描
    │
    ├─[4] 同步更新 Session Metadata (metadata.skills / metadata.slashCommands)
    │
    ├─[5] 发送 ACP Turn 信封 (startTurn -> model-output(Markdown) -> endTurn)
    │     同时向 TTY MessageBuffer 输出 chalk 格式化文本
    ▼
Agy 常驻子进程 (保持运行，上下文不受影响)
```

## 关键数据结构

```typescript
export interface AgySkill {
  name: string;             // 技能名称（如 "agent-browser" 或 "Google.securecoder.securecoder:audit"）
  description: string;      // 技能描述说明
  path?: string;            // SKILL.md 文件绝对路径
  plugin?: string;          // 所属插件名称（可选）
  builtin?: boolean;        // 是否为 Antigravity 内置技能
  model_invocable?: boolean;// 是否允许模型直接调用
}

export interface AgySkillsResult {
  skills: AgySkill[];
  source: 'cli-json' | 'cli-text' | 'filesystem';
}
```

## 外部依赖或 API

- **`agy` CLI 二进制文件**：通过 `resolveAgyBin()` 解析路径，以 `--output-format json --print /skills` 单次调用。
- **Node.js 文件系统**：`node:fs/promises`（`readdir`、`readFile`、`stat`）用于扫描与解析 `SKILL.md` frontmatter。

## 异常路径与容错

1. **`agy` 不支持 `--output-format json` 或 JSON 格式损坏**：
   自动回退使用纯文本模式 `agy --print /skills` 并通过列对齐/制表符正则表达式提取名称与说明。
2. **`agy` 二进制不存在或进程执行超时（默认 15s）**：
   自动调用 `discoverAgySkillsFilesystem` 从 `.agents/skills`、`~/.gemini/antigravity-cli/builtin/skills` 及 `~/.gemini/config/plugins` 目录恢复技能列表。
3. **`AgyBackend.sendPrompt` 防御机制**：
   如果外部误将 `/skills` 传入 `sendPrompt`，`AgyBackend` 会直接抛出结构化错误，防止写入子进程 stdin 导致常驻进程退出或状态错乱。
4. **无可用技能**：
   友好返回提示文案 `No skills available. Session may still be initializing — try again after sending a message.`。

## 测试验证方式

1. **单元测试**：
   - `packages/happy-cli/src/agy/skills.test.ts`：覆盖 YAML Frontmatter 解析（单行、折叠多行）、JSON 结构解析、文本对齐与 ANSI 剥离解析、文件系统多目录扫描、多级回退机制及格式化器。
   - `packages/happy-cli/src/agy/AgyBackend.test.ts`：验证 `AgyBackend.sendPrompt` 拦截 `/skills` 提示词。
   - `packages/happy-cli/src/parsers/specialCommands.test.ts`：验证 `/skills` 与带参数情况的指令解析。
2. **端到端执行测试**：
   - `node packages/happy-cli/dist/index.mjs skills`
   - `node packages/happy-cli/dist/index.mjs skills --markdown`
   - `node packages/happy-cli/dist/index.mjs skills --json`

## 变更记录

- **2026-09-06**：
  - 新增 `packages/happy-cli/src/agy/skills.ts` 与 `skills.test.ts`。
  - 在 `runAgy.ts` 启动时预载技能元数据至 `metadata.slashCommands` 与 `metadata.skills`。
  - 在 `runAgy.ts` 中拦截 `/skills` 特殊指令并转为独立 Print 进程执行与信封下发。
  - 在 `AgyBackend.ts` 的 `sendPrompt` 中新增防御性守卫，防止写入 `stream-json` 通道。
  - 在 `index.ts` 中暴露 `happy skills` CLI 子命令。
