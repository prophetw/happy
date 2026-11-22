import type { TerminalToolOutput } from '@slopus/happy-wire';
import { redact, redactValue } from 'happy-agent/automation';
import {
  completeToolCall,
  resolveToolCallName,
  startToolCall,
  type HandlerContext,
  type SessionUpdate,
} from '@/agent/acp/sessionUpdateHandlers';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function codeBuddyReportedToolName(update?: { _meta?: unknown; name?: unknown }): string | undefined {
  return text(record(update?._meta)?.['codebuddy.ai/toolName'])?.trim() || text(update?.name)?.trim() || undefined;
}

function contentOutput(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const blocks = content.map(item => item?.type === 'content' ? item.content : item).filter(Boolean);
  const textBlocks = blocks.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []);
  if (textBlocks.length > 0) return textBlocks.join('\n');
  // Preserve structured ACP content such as diffs instead of discarding it.
  return blocks.length === 1 ? blocks[0] : blocks.length > 1 ? blocks : undefined;
}

function terminalOutput(value: unknown, response: Record<string, unknown> | undefined): TerminalToolOutput {
  const raw = record(value);
  const stdout = text(raw?.stdout) ?? text(response?.stdout);
  const stderr = text(raw?.stderr) ?? text(response?.stderr);
  const exitCode = raw?.exitCode ?? response?.exitCode;
  const error = text(raw?.error) ?? text(response?.error);
  const combined = stdout === undefined && stderr === undefined
    ? text(value) ?? text(raw?.output) ?? (raw?.type === 'text' ? text(raw.text) : undefined) ?? text(contentOutput(value))
    : undefined;
  const output = combined ?? (value != null && stdout === undefined && stderr === undefined && error === undefined && exitCode == null
    ? JSON.stringify(redactValue(value), null, 2) : undefined);
  return {
    ...(output === undefined ? {} : { output: redact(output) }),
    ...(stdout === undefined ? {} : { stdout: redact(stdout) }),
    ...(stderr === undefined ? {} : { stderr: redact(stderr) }),
    ...(typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(error && error !== combined && error !== stdout && error !== stderr ? { error: redact(error) } : {}),
  };
}

type ToolState = {
  name: string;
  args?: Record<string, unknown>;
  publishedArgs?: string;
  finished?: boolean;
};

/** Tracks native ACP tool IDs for the lifetime of a live CodeBuddy session. */
export class CodeBuddyToolCalls {
  private readonly calls = new Map<string, ToolState>();

  has(id: string): boolean {
    return this.calls.has(id);
  }

  handle(update: SessionUpdate, ctx: HandlerContext): void {
    const id = update.toolCallId;
    if (!id) return;
    const previous = this.calls.get(id);
    const name = codeBuddyReportedToolName(update)
      ?? (previous?.name && !['other', 'unknown'].includes(previous.name) ? previous.name : undefined)
      ?? resolveToolCallName(update.kind, update.title, undefined);
    const call = previous ?? { name };
    this.calls.set(id, call);

    const status = update.status;
    const isEnd = status === 'completed' || status === 'failed' || status === 'cancelled';
    const source = update.sessionUpdate === 'tool_call' ? 'tool_call' : 'tool_call_update';
    const meta = record(update._meta);
    const argsComplete = meta?.['codebuddy.ai/toolArgumentsComplete'] === true;
    const rawInput = record(update.rawInput ?? update.input);
    if (rawInput && Object.keys(rawInput).length > 0) call.args = rawInput;

    // CodeBuddy's statusless argument chunks include partial JSON in content and
    // a parsed rawInput snapshot. Publish the arguments once they are complete.
    let args: Record<string, unknown> | undefined;
    if (call.args && (argsComplete || source === 'tool_call' || status !== undefined || call.finished)) {
      const redacted = redactValue(call.args) as Record<string, unknown>;
      const signature = JSON.stringify(redacted);
      if (call.publishedArgs !== signature) {
        args = redacted;
        call.publishedArgs = signature;
      }
    }
    if (!previous) {
      startToolCall(id, name, { rawInput: args }, ctx, source);
      args = undefined;
    }

    const rawResponse = record(meta?.['codebuddy.ai/rawResponse']);
    const allowContentOutput = isEnd || (source === 'tool_call_update' && !rawInput && !argsComplete && status !== 'pending');
    const output = contentOutput(update.rawOutput ?? (allowContentOutput ? update.content : undefined));
    const terminal = ['bash', 'shell', 'execute'].includes(name.toLowerCase())
      ? terminalOutput(output, rawResponse) : undefined;

    const updatedName = name !== call.name ? name : undefined;
    if (updatedName) {
      call.name = updatedName;
      ctx.toolCallIdToNameMap.set(id, updatedName);
    }
    const hasOutput = terminal && Object.keys(terminal).length > 0;
    if (updatedName || args || hasOutput) {
      ctx.emit({ type: 'tool-call-update', callId: id, name: updatedName, args, terminal: hasOutput ? terminal : undefined });
    }

    if (isEnd && !call.finished) {
      call.finished = true;
      call.args = undefined;
      call.publishedArgs = undefined;
      const outputRecord = record(output);
      const isError = status !== 'completed' || rawResponse?.is_error === true || outputRecord?.is_error === true
        || outputRecord?.isError === true || meta?.['codebuddy.ai/businessFailed'] === true;
      const result = terminal ? undefined : redactValue(output ?? rawResponse);
      completeToolCall(id, name, result, ctx, isError);
    }
  }
}
