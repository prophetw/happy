import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/agent/core';
import type { HandlerContext, SessionUpdate } from './sessionUpdateHandlers';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  completeToolCall,
  handleAgentThoughtChunk,
  handleToolCallUpdate,
  resolveToolCallName,
  shouldSuppressIdleStatus,
  startToolCall,
} from './sessionUpdateHandlers';

interface MockCtx {
  ctx: HandlerContext;
  messages: AgentMessage[];
  idleCount: () => number;
}

function createMockCtx(): MockCtx {
  const messages: AgentMessage[] = [];
  let idleCount = 0;
  let idleTimeout: NodeJS.Timeout | null = null;
  const ctx = {
    transport: {},
    activeToolCalls: new Set<string>(),
    toolCallStartTimes: new Map<string, number>(),
    toolCallTimeouts: new Map<string, NodeJS.Timeout>(),
    toolCallIdToNameMap: new Map<string, string>(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: (msg: AgentMessage) => {
      messages.push(msg);
    },
    emitIdleStatus: () => {
      idleCount++;
    },
    clearIdleTimeout: () => {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
    },
    setIdleTimeout: (callback: () => void, ms: number) => {
      idleTimeout = setTimeout(() => {
        callback();
        idleTimeout = null;
      }, ms);
    },
    hasIdleTimeout: () => idleTimeout !== null,
  } as unknown as HandlerContext;
  return { ctx, messages, idleCount: () => idleCount };
}

function toolCallUpdate(partial: Partial<SessionUpdate> & { toolCallId: string }): SessionUpdate {
  return { sessionUpdate: 'tool_call_update', ...partial };
}

describe('resolveToolCallName', () => {
  it('prefers the transport-extracted name', () => {
    expect(resolveToolCallName('read', 'Read', 'Bash')).toBe('Bash');
  });

  it('falls back to the title when kind is generic', () => {
    expect(resolveToolCallName('other', 'bash', undefined)).toBe('bash');
    expect(resolveToolCallName(undefined, 'glob', null)).toBe('glob');
    expect(resolveToolCallName('unknown', 'grep', undefined)).toBe('grep');
  });

  it('keeps a specific kind over the title', () => {
    expect(resolveToolCallName('read', 'Read file', undefined)).toBe('read');
  });

  it('returns unknown when nothing is available', () => {
    expect(resolveToolCallName(undefined, undefined, undefined)).toBe('unknown');
  });
});

describe('tool call name and args compatibility', () => {
  let mock: MockCtx;

  beforeEach(() => {
    mock = createMockCtx();
  });

  it('resolves the tool name from title and args from rawInput (dsh shape)', () => {
    startToolCall(
      'call_1',
      'other',
      {
        title: 'bash',
        rawInput: { command: 'ls -la', description: 'List top-level directory contents' },
      },
      mock.ctx,
      'tool_call',
    );

    const toolCall = mock.messages.find((m) => m.type === 'tool-call');
    expect(toolCall).toMatchObject({
      type: 'tool-call',
      toolName: 'bash',
      callId: 'call_1',
      args: { command: 'ls -la', description: 'List top-level directory contents' },
    });
  });

  it('reuses the started tool name on completion updates that carry no kind', () => {
    startToolCall('call_2', 'other', { title: 'glob', rawInput: { pattern: '**/*' } }, mock.ctx, 'tool_call');
    mock.messages.length = 0;

    const result = handleToolCallUpdate(
      toolCallUpdate({ toolCallId: 'call_2', status: 'completed', content: { text: 'a.ts' } }),
      mock.ctx,
    );

    expect(result.handled).toBe(true);
    const toolResult = mock.messages.find((m) => m.type === 'tool-result');
    expect(toolResult).toMatchObject({ type: 'tool-result', toolName: 'glob', callId: 'call_2' });
  });

  it('prefers content over rawInput for args', () => {
    startToolCall(
      'call_3',
      'read',
      { content: { file_path: '/tmp/a.ts' }, rawInput: { ignored: true } },
      mock.ctx,
      'tool_call',
    );

    const toolCall = mock.messages.find((m) => m.type === 'tool-call');
    expect(toolCall).toMatchObject({ args: { file_path: '/tmp/a.ts' } });
  });
});

describe('shouldSuppressIdleStatus', () => {
  it('suppresses inactivity idle mid-turn for prompt-response-driven transports', () => {
    const transport = { turnEndOnPromptResponse: () => true };
    expect(shouldSuppressIdleStatus(true, transport)).toBe(true);
    expect(shouldSuppressIdleStatus(false, transport)).toBe(false);
  });

  it('does not suppress for transports without the flag', () => {
    expect(shouldSuppressIdleStatus(true, {})).toBe(false);
    expect(shouldSuppressIdleStatus(true, { turnEndOnPromptResponse: () => false })).toBe(false);
  });
});

describe('idle status scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers idle after the last tool call completes instead of emitting it immediately', () => {
    const mock = createMockCtx();
    startToolCall('call_1', 'bash', { rawInput: { command: 'ls' } }, mock.ctx, 'tool_call');
    mock.messages.length = 0;

    completeToolCall('call_1', 'unknown', { text: 'done' }, mock.ctx);

    expect(mock.idleCount()).toBe(0);
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);
    expect(mock.idleCount()).toBe(1);
    const toolResult = mock.messages.find((m) => m.type === 'tool-result');
    expect(toolResult).toMatchObject({ toolName: 'bash' });
  });

  it('cancels the pending idle when the next tool call starts within the quiet period', () => {
    const mock = createMockCtx();
    startToolCall('call_1', 'bash', { rawInput: { command: 'ls' } }, mock.ctx, 'tool_call');
    completeToolCall('call_1', 'unknown', { text: 'done' }, mock.ctx);
    expect(mock.idleCount()).toBe(0);

    startToolCall('call_2', 'glob', { rawInput: { pattern: '*' } }, mock.ctx, 'tool_call');
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS * 5);
    expect(mock.idleCount()).toBe(0);

    completeToolCall('call_2', 'unknown', { text: 'done' }, mock.ctx);
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);
    expect(mock.idleCount()).toBe(1);
  });

  it('defers an idle countdown when thinking continues, without starting one on its own', () => {
    const mock = createMockCtx();
    // Thinking with no countdown pending must not arm the idle timer
    handleAgentThoughtChunk({ content: { text: 'thinking…' } }, mock.ctx);
    expect(mock.ctx.hasIdleTimeout()).toBe(false);
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS * 5);
    expect(mock.idleCount()).toBe(0);

    // Tool completes → countdown armed; continued thinking defers it
    startToolCall('call_1', 'bash', { rawInput: { command: 'ls' } }, mock.ctx, 'tool_call');
    completeToolCall('call_1', 'unknown', { text: 'done' }, mock.ctx);
    expect(mock.ctx.hasIdleTimeout()).toBe(true);

    handleAgentThoughtChunk({ content: { text: 'still thinking…' } }, mock.ctx);
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS - 1);
    handleAgentThoughtChunk({ content: { text: 'more thinking…' } }, mock.ctx);
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS - 1);
    expect(mock.idleCount()).toBe(0);

    // Quiet period elapses after the last thought → idle exactly once
    vi.advanceTimersByTime(1);
    expect(mock.idleCount()).toBe(1);
  });

  it('failing the last tool call also schedules idle after the quiet period', () => {
    const mock = createMockCtx();
    startToolCall('call_1', 'bash', { rawInput: { command: 'false' } }, mock.ctx, 'tool_call');
    mock.messages.length = 0;

    handleToolCallUpdate(
      toolCallUpdate({ toolCallId: 'call_1', status: 'failed', content: { error: 'exit 1' } }),
      mock.ctx,
    );

    expect(mock.idleCount()).toBe(0);
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);
    expect(mock.idleCount()).toBe(1);
    const toolResult = mock.messages.find((m) => m.type === 'tool-result');
    expect(toolResult).toMatchObject({ toolName: 'bash' });
  });
});
