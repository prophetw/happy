import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AgySdkBackend } from './AgySdkBackend';
import { AgyTokenSpeedTracker } from './tokenSpeed';
import type { SpawnFn } from './AgyBackend';
import type { AgentMessage } from '@/agent/core/AgentBackend';

function makeFakeSdkChild() {
  const stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  const child = new EventEmitter() as EventEmitter & {
    stdin: typeof stdin;
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: (signal?: string) => boolean;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => true);
  return { child, stdin, stdout, stderr };
}

describe('AgySdkBackend', () => {
  it('uses each completed SDK response count without subtracting previous turns', async () => {
    const { child, stdout } = makeFakeSdkChild();
    const backend = new AgySdkBackend({ cwd: '/work', permissionMode: 'default', spawnFn: vi.fn(() => child) as unknown as SpawnFn });
    let now = 0;
    const tracker = new AgyTokenSpeedTracker(() => now);
    backend.onMessage((message) => {
      if (message.type === 'token-count') tracker.update(message);
    });
    const startup = backend.startSession();
    stdout.emit('data', '{"event":"ready","conversation_id":"sdk-speed"}\n');
    await startup;

    try {
      for (const count of [100, 150, 150, 50, 0, 80]) {
        tracker.startTurn();
        const turn = backend.sendPrompt('/work', 'Next task');
        now += 2000;
        stdout.emit('data', JSON.stringify({ event: 'token_count', input_tokens: 1000, output_tokens: count }) + '\n');
        stdout.emit('data', '{"event":"turn_complete","status":"SUCCESS"}\n');
        await turn;
        tracker.finishTurn();
        expect(tracker.tokensPerSecond).toBe(count > 0 ? count / 2 : undefined);
        now += 10000;
      }
    } finally {
      await backend.dispose();
    }
  });

  it.each(['CANCELED', 'CANCELLED'])('preserves a %s result and accepts the next SDK turn', async (status) => {
    const { child, stdout } = makeFakeSdkChild();
    const backend = new AgySdkBackend({ cwd: '/work', permissionMode: 'default', spawnFn: vi.fn(() => child) as unknown as SpawnFn });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));
    const startup = backend.startSession();
    stdout.emit('data', '{"event":"ready","conversation_id":"sdk-cancelled"}\n');
    await startup;

    const turn = backend.sendPrompt('/work', 'Long task');
    const rejected = expect(turn).rejects.toMatchObject({ name: 'AgyTurnCancelledError' });
    stdout.emit('data', '{"event":"text_delta","delta":"Partial output"}\n');
    stdout.emit('data', JSON.stringify({ event: 'turn_complete', status }) + '\n');
    await rejected;
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'stopped' });
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'status', status: 'idle' }));

    const next = backend.sendPrompt('/work', 'Next task');
    stdout.emit('data', '{"event":"turn_complete","status":"SUCCESS"}\n');
    await next;
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
    await backend.dispose();
  });

  it('initializes persistent bridge and completes multi-turn chat in single process', async () => {
    const { child, stdin, stdout } = makeFakeSdkChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgySdkBackend({
      cwd: '/my/project',
      permissionMode: 'default',
      model: 'Gemini 3.7 Flash (High)',
      spawnFn,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    // 1. Start Session
    const startPromise = backend.startSession();
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Initial init payload written to stdin
    expect(stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"action":"init"')
    );

    // Bridge sends ready event
    stdout.emit('data', '{"event":"ready","conversation_id":"sdk-conv-100"}\n');
    await expect(startPromise).resolves.toEqual({ sessionId: '/my/project' });
    expect(backend.getConversationId()).toBe('sdk-conv-100');

    // 2. Turn 1
    const turn1 = backend.sendPrompt('/my/project', 'hello sdk');
    expect(stdin.write).toHaveBeenCalledWith(
      JSON.stringify({
        action: 'chat',
        prompt: 'hello sdk',
        model: 'Gemini 3.7 Flash (High)',
        permission_mode: 'default',
      }) + '\n'
    );

    stdout.emit('data', '{"event":"text_delta","delta":"Hi "}\n');
    stdout.emit('data', '{"event":"text_delta","delta":"there!"}\n');
    stdout.emit('data', '{"event":"token_count","input_tokens":10,"output_tokens":5}\n');
    stdout.emit('data', '{"event":"turn_complete","status":"SUCCESS","conversation_id":"sdk-conv-100"}\n');

    await expect(turn1).resolves.toBeUndefined();
    expect(messages).toContainEqual({
      type: 'token-count', agy_usage_scope: 'turn',
      input_tokens: 10, output_tokens: 5, thinking_tokens: 0,
    });
    expect(messages.filter((m) => m.type === 'model-output')).toEqual([
      { type: 'model-output', textDelta: 'Hi ' },
      { type: 'model-output', textDelta: 'there!' },
    ]);
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });

    // 3. Turn 2: SAME PROCESS, no new spawn!
    const turn2 = backend.sendPrompt('/my/project', 'second question');
    expect(spawnFn).toHaveBeenCalledTimes(1); // Process stayed alive!

    stdout.emit('data', '{"event":"text_delta","delta":"Turn 2 answer"}\n');
    stdout.emit('data', '{"event":"turn_complete","status":"SUCCESS","conversation_id":"sdk-conv-100"}\n');

    await expect(turn2).resolves.toBeUndefined();

    // 4. Dispose
    await backend.dispose();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('maps tool calls, results, and thinking correctly', async () => {
    const { child, stdout } = makeFakeSdkChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgySdkBackend({
      cwd: '/my/project',
      permissionMode: 'default',
      spawnFn,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const startPromise = backend.startSession();
    stdout.emit('data', '{"event":"ready","conversation_id":"sdk-conv-tool"}\n');
    await startPromise;

    const turn = backend.sendPrompt('/my/project', 'run tool');

    stdout.emit('data', '{"event":"thinking","delta":"Thinking deeply..."}\n');
    stdout.emit(
      'data',
      '{"event":"tool_call","call_id":"call-1","tool_name":"read_file","args":{"path":"test.txt"}}\n'
    );
    stdout.emit(
      'data',
      '{"event":"tool_result","call_id":"call-1","tool_name":"read_file","result":"file contents"}\n'
    );
    stdout.emit('data', '{"event":"turn_complete","status":"SUCCESS","conversation_id":"sdk-conv-tool"}\n');

    await turn;

    expect(messages.find((m) => m.type === 'event' && m.name === 'thinking')).toMatchObject({
      type: 'event',
      name: 'thinking',
      payload: { text: 'Thinking deeply...', streaming: true },
    });

    expect(messages.find((m) => m.type === 'tool-call')).toMatchObject({
      type: 'tool-call',
      callId: 'call-1',
      toolName: 'read_file',
      args: { path: 'test.txt' },
    });

    expect(messages.find((m) => m.type === 'tool-result')).toMatchObject({
      type: 'tool-result',
      callId: 'call-1',
      toolName: 'read_file',
      result: 'file contents',
    });
  });

  it('handles error turn completion', async () => {
    const { child, stdout } = makeFakeSdkChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgySdkBackend({
      cwd: '/my/project',
      permissionMode: 'default',
      spawnFn,
    });

    const startPromise = backend.startSession();
    stdout.emit('data', '{"event":"ready","conversation_id":"sdk-err"}\n');
    await startPromise;

    const turn = backend.sendPrompt('/my/project', 'will fail');
    stdout.emit('data', '{"event":"turn_complete","status":"ERROR","error":"Quota exceeded"}\n');

    await expect(turn).rejects.toThrow('Quota exceeded');
  });

  it('reset clears conversation ID, terminates child bridge, and allows clean respawn', async () => {
    const first = makeFakeSdkChild();
    const second = makeFakeSdkChild();
    const spawnFn = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as SpawnFn;

    const backend = new AgySdkBackend({
      cwd: '/my/project',
      permissionMode: 'default',
      spawnFn,
    });

    const startPromise = backend.startSession();
    first.stdout.emit('data', '{"event":"ready","conversation_id":"sdk-old-conv"}\n');
    await startPromise;
    expect(backend.getConversationId()).toBe('sdk-old-conv');

    // Reset clears state and kills child
    backend.reset();
    expect(backend.getConversationId()).toBeNull();
    expect(first.child.kill).toHaveBeenCalledWith('SIGTERM');

    // Next turn spawns a new bridge
    const turn = backend.sendPrompt('/my/project', 'hello after reset');
    second.stdout.emit('data', '{"event":"ready","conversation_id":"sdk-fresh-conv"}\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(backend.getConversationId()).toBe('sdk-fresh-conv');

    second.stdout.emit('data', '{"event":"turn_complete","status":"SUCCESS","conversation_id":"sdk-fresh-conv"}\n');
    await expect(turn).resolves.toBeUndefined();
  });
});
