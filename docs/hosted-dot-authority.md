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

读取同时验证打开前后文件的 inode、大小及纳秒级修改/变更时间，返回前再次核对配置与
journal 路径，遇到原子替换也保守拒绝本次读取（不自动重试）。用户 seq 必须严格递增。
如果已有 reset-epoch.json 比 journal epoch 更新，则读取失败关闭。下一次操作可重新读取；
高并发写入时的暂时拒绝是安全行为，不应通过使用旧快照来绕过。

宿主 fail-stop 只撤销其存活身份，不证明原生子进程已退出，也不保证已发出的请求或副作用被取消。

普通发布与blocked撤销写入前都检查完整紧凑JSON的UTF-8字节数（含authority元数据），
不允许超过32 MiB。若新增元数据使旧journal超过上限，且blocked也无法容纳，则fail-stop，
保留磁盘中最后可读取的journal，不删除历史或写入无法恢复的超限文件。
