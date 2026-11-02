# Claude immediate messages

Happy supports immediate input during a remote Claude Code turn. Both the app
and the Happy CLI on the computer must be updated.

## Delivery

Ordinary send keeps the existing Happy message queue. While Claude is running,
the composer also offers **Send now** when session metadata advertises
`claudeCapabilities.steering`.

Send now adds `meta.deliveryMode: "steer"` to the encrypted user message. The
CLI pushes its text and supported image attachments into the active Claude
Agent SDK input stream. Claude can fold that input into the running turn
between tool rounds; Happy does not interrupt the turn or start a concurrent
query. Input during uninterrupted model output is not guaranteed to take
effect immediately.

If the turn has already ended, the active input handler rejects the message and
Happy queues it once for the next turn. Slash commands retain their queue
ordering. Model, effort, and permission changes remain subsequent-turn
settings rather than retroactive changes to the running turn.

The capability is advertised only in remote mode. Local terminal mode keeps
the existing handover behavior because its PTY is not the remote SDK input
stream.
