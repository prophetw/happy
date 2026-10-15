# Codex questions and immediate messages

Happy uses Codex's existing app-server protocol for both questions and messages
sent during a running task. These features require an updated Happy CLI on the
computer as well as the updated app.

## Questions

The adapter handles two protocol forms:

- `item/tool/requestUserInput` is a server request. Happy publishes a question
  card through `agentState.communications` and returns the selected or typed
  answers through that request's JSON-RPC response. `isBlocking` determines
  whether the session is waiting for input; an absent value preserves the
  blocking behavior of older Codex versions. `serverRequest/resolved` removes
  expired requests without sending a late response.
- An `agentMessage` with `delivery: "async"` carries `questions` independently
  of a server request. Happy displays these as non-blocking cards. Their answers
  enter the current turn through `turn/steer`, or enter the message queue if the
  turn has already finished. Cards remain answerable after turn completion.
  These cards currently belong to the primary conversation; child-thread async
  messages remain transcript text rather than offering a reply that would be
  sent to the wrong thread. Native child questions use their JSON-RPC responses.

The existing choice form supports both suggested options and a written answer.
Text-only questions use the answer sheet above the composer. Sending an ordinary
chat message dismisses blocking forms, while asynchronous forms remain pending.
Stop, `/clear`, and session shutdown cancel remaining questions. Answering or
cancelling a card on one device updates its state on other connected devices.

## Immediate messages

During a running Codex task, the composer offers **Send now** alongside ordinary
send. Ordinary send keeps queueing the message for the next turn. Send now adds
`meta.deliveryMode: "steer"` to the encrypted user message. The CLI calls
`turn/steer` with the active `threadId`, `expectedTurnId`, and text/image input.
It neither interrupts the task nor starts a second turn.

If the task finishes before the input is accepted, or Codex explicitly rejects
steering, Happy queues the message once for the next turn. Transport failures
that leave acceptance uncertain are reported instead of automatically replaying
the message. Slash commands retain their queue ordering. Model, effort, and
permission changes apply to subsequent turns, as `turn/steer` does not accept
turn-level overrides.

The CLI advertises `metadata.codexCapabilities` so older CLI sessions do not
offer an immediate-send button they cannot honor.

Protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
