import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}));

import { discoverDshModels } from './discoverModels';

type FakeAgentHandlers = Record<string, (params: any, id: number) => unknown>;

type FakeDsh = {
  child: {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
    on: (event: string, handler: (arg?: unknown) => void) => void;
  };
  killed: ReturnType<typeof vi.fn>;
};

/**
 * A minimal in-process dsh stand-in: reads JSON-RPC requests off stdin and
 * answers from the handlers table, so the probe's real ClientSideConnection
 * drives a real (fake) wire protocol.
 */
function startFakeDsh(handlers: FakeAgentHandlers): FakeDsh {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killed = vi.fn();
  const errorHandlers = new Map<string, Array<(arg?: unknown) => void>>();
  const child = {
    stdin,
    stdout,
    stderr,
    kill: () => {
      killed();
    },
    on: (event: string, handler: (arg?: unknown) => void) => {
      errorHandlers.set(event, [...(errorHandlers.get(event) ?? []), handler]);
    },
  };

  let buffer = '';
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line);
      const handler = handlers[message.method];
      if (!handler) {
        continue;
      }
      const result = handler(message.params, message.id);
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    }
  });

  return { child, killed };
}

const MODEL_CONFIG_OPTION = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: '["deepseek-official","deepseek-v4-flash"]',
  options: [
    {
      group: 'deepseek-official',
      name: 'DeepSeek',
      options: [
        { value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' },
        {
          value: '["deepseek-official","deepseek-v4-pro"]',
          name: 'DeepSeek-V4-Pro',
          description: 'Stronger agentic coding',
        },
      ],
    },
  ],
};

const HANDSHAKE: FakeAgentHandlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentInfo: { name: 'fake-dsh', version: '0.0.1' },
  }),
  'session/new': () => ({
    sessionId: 'session-1',
    configOptions: [MODEL_CONFIG_OPTION],
  }),
};

beforeEach(() => {
  spawnMock.mockReset();
});

describe('discoverDshModels', () => {
  it('returns the flattened model catalog and the ambient current model', async () => {
    const fake = startFakeDsh(HANDSHAKE);
    spawnMock.mockReturnValue(fake.child);

    const catalog = await discoverDshModels({ command: 'dsh', args: ['--profile', 'acp'] });

    expect(catalog).not.toBeNull();
    expect(catalog?.currentCode).toBe('["deepseek-official","deepseek-v4-flash"]');
    expect(catalog?.options).toEqual([
      { code: '["deepseek-official","deepseek-v4-flash"]', value: 'deepseek-v4-flash' },
      {
        code: '["deepseek-official","deepseek-v4-pro"]',
        value: 'DeepSeek-V4-Pro',
        description: 'Stronger agentic coding',
      },
    ]);
    expect(fake.killed).toHaveBeenCalled();
  });

  it('drops non-JSON noise lines from stdout', async () => {
    const fake = startFakeDsh(HANDSHAKE);
    fake.child.stdout.write('booting profile acp…\n');
    spawnMock.mockReturnValue(fake.child);

    const catalog = await discoverDshModels({ command: 'dsh', args: ['--profile', 'acp'] });

    expect(catalog).not.toBeNull();
    expect(catalog?.options).toHaveLength(2);
  });

  it('resolves null when dsh reports no model selector', async () => {
    const fake = startFakeDsh({
      ...HANDSHAKE,
      'session/new': () => ({
        sessionId: 'session-1',
        configOptions: [
          { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: '', options: [] },
        ],
      }),
    });
    spawnMock.mockReturnValue(fake.child);

    const catalog = await discoverDshModels({ command: 'dsh', args: ['--profile', 'acp'] });

    expect(catalog).toBeNull();
    expect(fake.killed).toHaveBeenCalled();
  });

  it('resolves null when the handshake hangs, instead of waiting forever', async () => {
    const fake = startFakeDsh({});
    spawnMock.mockReturnValue(fake.child);

    const catalog = await discoverDshModels({
      command: 'dsh',
      args: ['--profile', 'acp'],
      timeoutMs: 150,
    });

    expect(catalog).toBeNull();
    expect(fake.killed).toHaveBeenCalled();
  }, 10_000);

  it('resolves null when the child exits before answering', async () => {
    const fake = startFakeDsh({});
    spawnMock.mockReturnValue(fake.child);
    // Simulate a crash at startup: stdout closes without any response.
    fake.child.stdout.end();

    const catalog = await discoverDshModels({
      command: 'dsh',
      args: ['--profile', 'acp'],
      timeoutMs: 150,
    });

    expect(catalog).toBeNull();
  });
});
