# Hosted Dot 本地只读授权快照（v1）

CLI 包提供显式 ESM 子路径 `happy/codex/hostedDotAuthority`，构建产物为
`packages/happy-cli/dist/codex/hostedDotAuthority.mjs`。导入不会启动 CLI、联网或写文件。

```ts
import { HOSTED_INPUT_AUTHORITY_VERSION, readHostedInputAuthority } from 'happy/codex/hostedDotAuthority';
const snapshot = readHostedInputAuthority({ directory, dotId, sessionId });
```

`directory` 必须是可信配置提供的绝对真实目录，不能来自待授权消息或工具参数。
`dotId`、`sessionId` 同样来自已验证的宿主绑定。函数同步读取当前 `config.json`
和 `state.json`，不缓存、不补写、不调用带恢复默认值的 `loadHostedState`。
文件缺失、符号链接、非普通文件、超出 32 MiB、格式错误、版本不支持或绑定不符都会抛错。
配置按照 Happy 配置 schema 规范化后核对 journal hash，并兼容省略 effort 的历史 hash。

返回结构：

```ts
{
  version: 1,
  dotId: string,
  sessionId: string,
  epoch: number,
  revision: number,
  producer: { pid: number, start: string, boot: string },
  status: 'starting' | 'ready' | 'running' | 'blocked' | 'stopped',
  inputs: [{
    origin: 'user', seq: number, id: string, text: string,
    permissionMode?: string, epoch?: number, delivery?: 'queue' | 'steer',
    status: 'queued' | 'dispatching' | 'accepted' | 'completed' |
      'interrupted' | 'failed' | 'unknown' | 'rejected'
  }]
}
```

`inputs` 包含 journal 中完整的真实用户行，保留顺序；缺失 origin 的历史行视为 user，
task-result 行排除。epoch/delivery 缺失时仍然缺失，不能把默认值当作授权证据。
重复用户 seq/id 或无效行会导致整个读取失败。不会返回输出、凭据、配置或任务回报正文。

## 生产者与使用方责任

同一原子 journal 写入增加 `authority: { version: 1, producer, revision }`，没有第二份投影。
producer 使用实际 Linux PID、`/proc/<pid>/stat` 的 starttime（十进制字符串）以及 boot_id。
其他平台目前不提供生产者授权。revision 是每个生产者身份下单调递增的安全正整数。

启动后、首次异步操作前，宿主先盖上当前身份并写入 starting（原来 blocked 则保持 blocked）。
完成原有恢复后才写 ready；旧 accepted 无法确认时继续 unknown/blocked，不重放。
普通写失败会尝试把同一 journal 写为 blocked，并停止后续分发；若 blocked 也写失败，
进程立即以状态码 1 退出，避免磁盘旧授权与仍存活的生产者同时长期存在。

快照不是长期授权令牌。使用方必须验证生产者身份与进程存活、自己的宿主绑定、epoch、
状态与具体输入条件，每次敏感操作前重新同步读取。starting/blocked/stopped 不授权。
读快照与检查存活之间仍存在通常的进程退出竞争；v1 不提供跨进程事务或操作期租约。
不可缓存一次 accepted 后永久使用，也不可在读取失败时回退到 Relay 回执。

旧宿主不会写 authority，v1 读取必须失败关闭。新增元数据不改变既有 state 版本及
旧读取方行为。升级应先构建并部署 Happy，再显式为新运行配置启用相应消费者；
本代码改动本身不部署、不重启 daemon、不改现有 Dot。

读取验证 descriptor 的 inode、大小及纳秒级修改/变更时间，并在返回前核对目录、配置、
journal 和 reset floor。仅 state.json 原子替换竞争允许最多 4 次同步完整重读：
每次重新校验配置绑定、epoch、producer、状态和全部用户输入，跨尝试授权语义必须一致，
revision 不得倒退。只有输出日志和递增 revision 的差异不改变授权语义。
旧 inode 因 rename 覆盖而从单链接变成无链接时，允许该解除链接造成的 ctime 变化；
仍核对 descriptor 的设备、inode、大小和 mtime，最后必须读取稳定的新路径快照。
配置/reset 变化、原地修改、链接、缺失、格式错误或授权变化均拒绝，不复用旧授权。
持续替换耗尽仍抛 hosted_authority_file_changed，不代表连接已撤权或已有执行已停止。

暂不拆分授权与输出文件：本次有界读取足以处理已复现竞争且保持 v1 格式兼容；
若实际负载经常耗尽，可后续设计低频授权投影及其撤权一致性协议。不能简单复制两份状态。

宿主 fail-stop 只撤销其存活身份，不证明原生子进程已退出，也不保证已发出的请求或副作用被取消。

普通发布与blocked撤销写入前都检查完整紧凑JSON的UTF-8字节数（含authority元数据），
不允许超过32 MiB。若新增元数据使旧journal超过上限，且blocked也无法容纳，则fail-stop，
保留磁盘中最后可读取的journal，不删除历史或写入无法恢复的超限文件。

## 定向回归入口

依赖安装后，先构建本 checkout 的 happy-wire / happy-agent 共享包产物，再运行：

```sh
pnpm exec vitest run --config vitest.hosted-authority.config.ts --reporter=dot
pnpm --filter happy typecheck
```

专用配置不调用 CLI 全量构建 global setup。回归用临时文件及真实 fsync/rename writer，
在文件读取钩子注入可重复的写入时序；覆盖瞬时输出竞争、四次耗尽、真实授权变化、
配置/reset/link 拒绝，以及隔离进程存活/停止证据。没有访问真实 Dot 或业务任务。
