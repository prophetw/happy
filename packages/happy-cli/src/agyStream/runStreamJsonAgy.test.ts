import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/agent/core';
import type { AgyStatusLineQuota } from './statusLine';

const mocks = vi.hoisted(() => {
  const metadata = { path: '/work/project', flavor: 'agy', summary: { text: 'AGY task', updatedAt: 1 } };
  const rpcHandlers = new Map<string, (value?: any) => Promise<any>>();
  const listeners = new Set<(message: AgentMessage) => void>();
  const makeSession = (sessionId: string) => {
    let currentMetadata = { ...metadata };
    let agentState: any = { requests: {}, completedRequests: {} };
    return {
      sessionId,
      getMetadata: vi.fn(() => currentMetadata),
      getAgentState: () => agentState,
      updateMetadata: vi.fn((update: any) => { currentMetadata = update(currentMetadata); }),
      updateAgentState: vi.fn((update: any) => { agentState = update(agentState); }),
      onUserMessage: vi.fn((_handler: (message: any) => Promise<void>) => {}),
      onFileEvent: vi.fn(),
      drainAttachmentsForUserMessage: vi.fn(async (): Promise<any[]> => []),
      keepAlive: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendSessionProtocolMessage: vi.fn((_envelope: any) => {}),
      sendSessionEvent: vi.fn(),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      rpcHandlerManager: {
        registerHandler: vi.fn((name: string, handler: any) => { rpcHandlers.set(name, handler); }),
      },
    };
  };
  const backend = {
    startSession: vi.fn(async () => ({})),
    sendPrompt: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(async () => {}),
    reset: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    onMessage: vi.fn((listener: (message: AgentMessage) => void) => { listeners.add(listener); }),
    offMessage: vi.fn((listener: (message: AgentMessage) => void) => { listeners.delete(listener); }),
  };
  return {
    metadata, makeSession, rpcHandlers, listeners, backend,
    apiCreate: vi.fn<(...args: any[]) => Promise<any>>(),
    push: vi.fn<(...args: any[]) => any>(), post: vi.fn<(...args: any[]) => Promise<any>>(),
    reconnect: vi.fn<(...args: any[]) => any>(),
    registerKill: vi.fn((_rpc: unknown, _handler: () => Promise<void>) => {}),
    createBackend: vi.fn<(...args: any[]) => any>(),
    prepareImages: vi.fn<(...args: any[]) => Promise<any>>(),
    quota: {
      loadFromFile: vi.fn(), getQuota: vi.fn<() => AgyStatusLineQuota | null>(() => null),
      subscribe: vi.fn((_callback: (quota: AgyStatusLineQuota) => void) => vi.fn()),
    },
  };
});

vi.mock('axios', () => ({ default: { post: mocks.post } }));
vi.mock('@/api/api', () => ({ ApiClient: { create: mocks.apiCreate } }));
vi.mock('@/persistence', () => ({ readSettings: vi.fn(async () => ({ machineId: 'machine-1' })) }));
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: {} }));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: vi.fn(async () => ({})) }));
vi.mock('@/utils/createSessionMetadata', () => ({
  createSessionMetadata: vi.fn(() => ({ state: {}, metadata: { ...mocks.metadata } })),
}));
vi.mock('@/utils/setupOfflineReconnection', () => ({ setupOfflineReconnection: mocks.reconnect }));
vi.mock('@/claude/registerKillSessionHandler', () => ({ registerKillSessionHandler: mocks.registerKill }));
vi.mock('@/utils/serverConnectionErrors', () => ({ connectionState: { setBackend: vi.fn() } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('ink', () => ({ render: vi.fn() }));
vi.mock('@/ui/ink/AgyDisplay', () => ({ AgyDisplay: vi.fn() }));
vi.mock('./createAgyBackend', () => ({ createAgyBackend: mocks.createBackend }));
vi.mock('./discoverModels', () => ({
  discoverAgyModels: vi.fn(async () => []),
  resolveAgyModelSelection: vi.fn(() => 'Gemini 3.8 Flash (High)'),
}));
vi.mock('./skills', () => ({
  discoverAgySkillsFilesystem: vi.fn(async () => []), getAgySkillCommandNames: vi.fn(() => []),
  fetchAgySkills: vi.fn(async () => ({ skills: [] })),
  formatAgySkillsMarkdown: vi.fn(() => 'Skills'), formatAgySkillsTerminal: vi.fn(),
}));
vi.mock('./usage', () => ({
  fetchAgyUsage: vi.fn(async () => ({})),
  formatAgyUsageMarkdown: vi.fn(() => 'Usage'), formatAgyUsageTerminal: vi.fn(),
}));
vi.mock('./statusLine', () => ({ AgyQuotaStore: { getInstance: () => mocks.quota } }));
vi.mock('./imageInput', () => ({
  prepareAgyImageAttachments: mocks.prepareImages,
  formatAgyPromptWithAttachments: vi.fn((text: string) => text),
}));

import { PushNotificationClient } from '@/api/pushNotifications';
import { runStreamJsonAgy } from './runStreamJsonAgy';
import { AgyTurnCancelledError } from './types';

describe('AGY session push notifications', () => {
  let session: ReturnType<typeof mocks.makeSession>;
  let running: Promise<void> | undefined;
  let finishPrompt: (() => void) | undefined;

  const emit = (message: AgentMessage) => { for (const listener of mocks.listeners) listener(message); };
  const turnStatuses = () => session.sendSessionProtocolMessage.mock.calls
    .map(([envelope]) => envelope.ev)
    .filter((event) => event.t === 'turn-end')
    .map((event) => event.status);
  const holdPrompt = () => {
    mocks.backend.sendPrompt.mockImplementationOnce(async () => {
      emit({ type: 'status', status: 'running' });
      await new Promise<void>((resolve) => { finishPrompt = resolve; });
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    mocks.listeners.clear();
    mocks.rpcHandlers.clear();
    session = mocks.makeSession('session-1');
    running = undefined;
    finishPrompt = undefined;
    mocks.reconnect.mockReturnValue({ session, reconnectionHandle: null });
    mocks.createBackend.mockReturnValue(mocks.backend);
    mocks.prepareImages.mockReset().mockResolvedValue({ savedFiles: [] });
    mocks.post.mockReset().mockResolvedValue({ data: { result: 'sent', tokens: 1 } });
    mocks.push.mockReset().mockReturnValue(new PushNotificationClient('test-auth', 'http://happy.test'));
    mocks.apiCreate.mockResolvedValue({
      getOrCreateMachine: vi.fn(async () => ({})),
      getOrCreateSession: vi.fn(async () => ({
        id: 'session-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey',
        seq: 0, metadataVersion: 0, agentStateVersion: 0,
      })),
      push: mocks.push,
    });
    mocks.backend.sendPrompt.mockReset().mockImplementation(async () => {
      emit({ type: 'status', status: 'running' });
      emit({ type: 'model-output', textDelta: 'Done' });
      emit({ type: 'status', status: 'idle' });
    });
    mocks.backend.cancel.mockReset().mockImplementation(async () => { finishPrompt?.(); });
  });

  afterEach(async () => {
    try {
      if (running) {
        const kill = mocks.registerKill.mock.calls[0]?.[1];
        await kill?.();
        await running;
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  async function start(forceEngine?: 'cli' | 'sdk') {
    running = runStreamJsonAgy({ credentials: {} as any, forceEngine });
    await vi.waitFor(() => expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));
  }

  async function send(text: string) {
    const onMessage = session.onUserMessage.mock.calls[0][0];
    await onMessage({ content: { text }, meta: {} });
  }

  it('reports turn speed, preserves it through statusline snapshots, and resets it for the next turn', async () => {
    mocks.backend.sendPrompt.mockImplementationOnce(async () => {
      emit({ type: 'token-count', output_tokens: 100 });
      emit({ type: 'token-count', agy_usage_scope: 'turn', output_tokens: 100, duration_seconds: 2 });
    });
    await start();
    mocks.createBackend.mock.calls[0][0].onConversationId('speed-conversation');
    await send('First task');
    await vi.waitFor(() => expect(turnStatuses()).toEqual(['completed']));
    const usageEnvelopes = () => session.sendSessionProtocolMessage.mock.calls
      .map(([envelope]) => envelope).filter((envelope) => envelope.usage);
    expect(usageEnvelopes().at(-1)).toMatchObject({
      ev: { t: 'service', text: '' }, usage: { output_tokens: 100, output_tokens_per_second: 50 },
    });
    expect(usageEnvelopes().at(-1)?.turn).toBeUndefined();

    const syncQuota = mocks.quota.subscribe.mock.calls[0][0];
    const quota = {
      updatedAt: Date.now(),
      contextWindow: { conversationId: 'speed-conversation', totalInputTokens: 500, totalOutputTokens: 100 },
    };
    syncQuota(quota);
    expect(usageEnvelopes().at(-1)?.usage.output_tokens_per_second).toBe(50);
    mocks.backend.sendPrompt.mockImplementationOnce(async () => {
      syncQuota(quota);
      emit({ type: 'token-count', input_tokens: 500 });
    });
    await send('Second task without output counts');
    await vi.waitFor(() => expect(turnStatuses()).toHaveLength(2));
    expect(usageEnvelopes().at(-1)?.usage.output_tokens_per_second).toBeUndefined();
  });

  it.each([undefined, 'cli', 'sdk'] as const)('sends one server-routed push per successful turn (engine %s)', async (engine) => {
    await start(engine);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.createBackend).toHaveBeenCalledWith(expect.objectContaining({ forceEngine: engine }));

    await send('First task');
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post).toHaveBeenCalledWith(
      'http://happy.test/v1/sessions/session-1/push-event',
      expect.objectContaining({
        kind: 'done', title: "It's ready!", body: 'AGY task',
        data: expect.objectContaining({ sessionId: 'session-1', provider: 'agy', type: 'ready', url: '/session/session-1' }),
      }),
      expect.any(Object),
    );
    emit({ type: 'status', status: 'idle' });
    emit({ type: 'status', status: 'idle' });
    expect(mocks.post).toHaveBeenCalledTimes(1);

    await send('Second task');
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(turnStatuses()).toEqual(['completed', 'completed']);
  });

  it('does not push for local /clear, /usage or /skills commands', async () => {
    await start();
    for (const command of ['/clear', '/usage', '/skills']) {
      const count = session.sendSessionEvent.mock.calls.length;
      await send(command);
      await vi.waitFor(() => expect(session.sendSessionEvent.mock.calls.length).toBeGreaterThan(count));
    }
    expect(mocks.backend.sendPrompt).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('does not announce failed or provider-cancelled turns, and can notify a later successful turn', async () => {
    mocks.backend.sendPrompt.mockRejectedValueOnce(new Error('Quota exceeded'));
    mocks.backend.sendPrompt.mockRejectedValueOnce(new AgyTurnCancelledError());
    await start();
    await send('Fail');
    await vi.waitFor(() => expect(turnStatuses()).toEqual(['failed']));
    await send('Cancel');
    await vi.waitFor(() => expect(turnStatuses()).toEqual(['failed', 'cancelled']));
    expect(mocks.post).not.toHaveBeenCalled();

    await send('Recover');
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(turnStatuses()).toEqual(['failed', 'cancelled', 'completed']);
  });

  it('does not announce completion if abort resolves the backend prompt successfully', async () => {
    holdPrompt();
    await start('sdk');
    await send('Long task');
    await vi.waitFor(() => expect(finishPrompt).toBeDefined());
    await mocks.rpcHandlers.get('abort')!();
    await vi.waitFor(() => expect(turnStatuses()).toEqual(['cancelled']));
    expect(mocks.post).not.toHaveBeenCalled();

    await send('Next task');
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  });

  it('pushes once for a real pending permission, preserving the approval RPC flow', async () => {
    holdPrompt();
    await start();
    await send('Run command');
    await vi.waitFor(() => expect(finishPrompt).toBeDefined());
    const tool = { type: 'tool-call', callId: 'tool-1', toolName: 'run_command', args: { CommandLine: 'ls' } } as const;
    emit(tool);
    emit(tool);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0][1]).toMatchObject({
      kind: 'permission',
      data: { sessionId: 'session-1', provider: 'agy', requestId: 'tool-1', tool: 'run_command', type: 'permission_request' },
    });
    expect(session.getAgentState().requests['tool-1']).toBeDefined();
    await mocks.rpcHandlers.get('permission')!({ id: 'tool-1', approved: true });
    expect(session.getAgentState().requests['tool-1']).toBeUndefined();
    expect(session.getAgentState().completedRequests['tool-1'].status).toBe('approved');
    finishPrompt!();
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][1].kind).toBe('done');
  });

  it('does not start or announce a task aborted while its images are being prepared', async () => {
    let finishImages: ((result: { savedFiles: string[] }) => void) | undefined;
    mocks.prepareImages.mockImplementationOnce(() => new Promise((resolve) => { finishImages = resolve; }));
    session.drainAttachmentsForUserMessage.mockResolvedValueOnce([{ name: 'image.png' }]);
    await start();
    await send('Check image');
    await vi.waitFor(() => expect(finishImages).toBeDefined());
    await mocks.rpcHandlers.get('abort')!();
    finishImages!({ savedFiles: ['/tmp/image.png'] });

    await send('Next task');
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.backend.sendPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.backend.sendPrompt.mock.calls[0][1]).toBe('Next task');
    expect(turnStatuses()).toEqual(['completed']);
  });

  it('uses the current session and title after an offline session swap', async () => {
    await start();
    const replacement = mocks.makeSession('session/new');
    replacement.updateMetadata((value: any) => ({ ...value, summary: { text: 'New title', updatedAt: 2 } }));
    mocks.reconnect.mock.calls[0][0].onSessionSwap(replacement);
    await send('A task after reconnect');
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][0]).toBe('http://happy.test/v1/sessions/session%2Fnew/push-event');
    expect(mocks.post.mock.calls[0][1]).toMatchObject({
      body: 'New title', data: { sessionId: 'session/new', url: '/session/session%2Fnew' },
    });
    emit({ type: 'tool-call', callId: 'new-tool', toolName: 'run_command', args: {} });
    expect(mocks.post.mock.calls[1][1]).toMatchObject({
      kind: 'permission', body: 'New title', data: { sessionId: 'session/new', requestId: 'new-tool' },
    });
    await mocks.rpcHandlers.get('permission')!({ id: 'new-tool', approved: false, decision: 'denied' });
  });

  it('keeps the turn completed when push delivery or push client setup fails', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Push network unavailable'));
    await start();
    await send('First task');
    await vi.waitFor(() => expect(turnStatuses()).toEqual(['completed']));
    mocks.push.mockImplementationOnce(() => { throw new Error('Push client unavailable'); });
    await send('Second task');
    await vi.waitFor(() => expect(turnStatuses()).toEqual(['completed', 'completed']));
  });
});
