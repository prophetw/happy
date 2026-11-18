# Claude 会话恢复与输入游标

Happy 的远程 Claude 会话需要在进程停止后恢复尚未执行的输入，同时不能重复执行已经交给 Claude 的历史指令。

## 模式切换

模型、权限模式等设置变化时，远程启动器把下一条消息暂存为 `pending`，结束当前 Query，再以新模式启动并投递该消息。结束输入流时必须同时调用 SDK `Query.close()`；仅关闭输入 EOF 可能让空闲 Query 和子进程一直存活，导致 `pending` 永远不被消费。

## 已投递游标

CLI 为每个新 Happy 会话保存：

```text
$HAPPY_HOME_DIR/session-delivery-cursors/<sessionId>.json
```

游标是 Relay 消息日志中非负、单调递增的 `seq`，表示该用户输入已经实际进入 Claude SDK 输入流：

- 仅从 Relay 收到、仍在 Happy 队列或模式切换 `pending` 中的消息不推进游标。
- 同模式批量输入以本批最大 seq 推进；附件仍归属对应文本消息。
- `Send now` / steering 只有被活动 Query 接收后才推进；被拒绝并排入普通队列时不推进。
- 游标文件通过临时文件重命名原子替换，不包含消息正文或密钥。

恢复时，普通 Claude 会话从该游标之后执行 catch-up。这样尚未投递的输入会重新进入消息处理器，而更早的历史用户指令不会重放。

没有游标或游标损坏的是升级前/未知会话，继续使用 `skipExistingMessages()` 的旧策略，避免升级后重复执行历史。新会话先初始化游标 0，再接收首条输入。

游标不表示模型已经执行完成，也不提供崩溃场景下的 exactly-once；它只划分“已交给 SDK”和“尚未交给 SDK”。
