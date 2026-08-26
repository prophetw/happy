import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgyPermissionHandler } from './permissionHandler';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';

describe('AgyPermissionHandler', () => {
  let session: ApiSessionClient;
  let rpcHandlers: Map<string, (payload: any) => Promise<any>>;
  let currentState: AgentState;

  beforeEach(() => {
    rpcHandlers = new Map();
    currentState = {
      requests: {},
      completedRequests: {},
    };

    session = {
      rpcHandlerManager: {
        registerHandler: vi.fn((name: string, handler: any) => {
          rpcHandlers.set(name, handler);
        }),
      },
      updateAgentState: vi.fn((updater: (state: AgentState) => AgentState) => {
        currentState = updater(currentState);
      }),
    } as unknown as ApiSessionClient;
  });

  it('registers permission RPC handler on instantiation', () => {
    new AgyPermissionHandler(session);
    expect(session.rpcHandlerManager.registerHandler).toHaveBeenCalledWith(
      'permission',
      expect.any(Function),
    );
  });

  it('auto-approves always-safe tools regardless of permission mode', async () => {
    const handler = new AgyPermissionHandler(session);
    handler.setPermissionMode('default');

    const result = await handler.handleToolCall('cid-1', 'change_title', { title: 'New title' });
    expect(result).toEqual({ decision: 'approved' });

    expect(currentState.completedRequests?.['cid-1']).toEqual(
      expect.objectContaining({
        tool: 'change_title',
        status: 'approved',
      }),
    );
    expect(currentState.requests?.['cid-1']).toBeUndefined();
  });

  it('auto-approves always-safe ID prefixes', async () => {
    const handler = new AgyPermissionHandler(session);
    handler.setPermissionMode('default');

    const result = await handler.handleToolCall('change_title-12345', 'custom_tool', {});
    expect(result).toEqual({ decision: 'approved' });
    expect(currentState.completedRequests?.['change_title-12345']).toBeDefined();
  });

  it('auto-approves all tools in yolo and bypassPermissions mode', async () => {
    const handler = new AgyPermissionHandler(session);
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('call-yolo', 'run_command', { CommandLine: 'rm -rf /' });
    expect(result).toEqual({ decision: 'approved_for_session' });
    expect(currentState.completedRequests?.['call-yolo']?.status).toBe('approved');
  });

  it('auto-approves read-only tools in safe-yolo mode but asks for dangerous tools', async () => {
    const handler = new AgyPermissionHandler(session);
    handler.setPermissionMode('safe-yolo');

    // Safe read tool -> auto-approved
    const readResult = await handler.handleToolCall('call-read', 'view_file', { path: 'foo.ts' });
    expect(readResult).toEqual({ decision: 'approved' });

    // Dangerous tool -> creates pending request
    let resolved = false;
    const dangerousPromise = handler.handleToolCall('call-cmd', 'run_command', { CommandLine: 'npm install' }).then((r) => {
      resolved = true;
      return r;
    });

    expect(currentState.requests?.['call-cmd']).toBeDefined();
    expect(resolved).toBe(false);

    // User approves via RPC
    const rpcHandler = rpcHandlers.get('permission');
    expect(rpcHandler).toBeDefined();
    await rpcHandler!({ id: 'call-cmd', approved: true });

    const dangerousResult = await dangerousPromise;
    expect(dangerousResult).toEqual({ decision: 'approved' });
    expect(currentState.requests?.['call-cmd']).toBeUndefined();
    expect(currentState.completedRequests?.['call-cmd']?.status).toBe('approved');
  });

  it('asks for permission in default mode and handles user denial', async () => {
    const handler = new AgyPermissionHandler(session);
    handler.setPermissionMode('default');

    const promise = handler.handleToolCall('call-deny', 'run_command', { CommandLine: 'ls' });

    expect(currentState.requests?.['call-deny']).toEqual(
      expect.objectContaining({
        tool: 'run_command',
        arguments: { CommandLine: 'ls' },
      }),
    );

    const rpcHandler = rpcHandlers.get('permission');
    await rpcHandler!({ id: 'call-deny', approved: false, decision: 'denied' });

    const result = await promise;
    expect(result).toEqual({ decision: 'denied' });
    expect(currentState.requests?.['call-deny']).toBeUndefined();
    expect(currentState.completedRequests?.['call-deny']?.status).toBe('denied');
  });

  it('aborts pending requests on abortAll()', async () => {
    const handler = new AgyPermissionHandler(session);
    handler.setPermissionMode('default');

    const promise = handler.handleToolCall('call-abort', 'write_to_file', { path: 'test.ts' });
    expect(currentState.requests?.['call-abort']).toBeDefined();

    handler.abortAll();

    const result = await promise;
    expect(result).toEqual({ decision: 'abort' });
    expect(currentState.requests?.['call-abort']).toBeUndefined();
    expect(currentState.completedRequests?.['call-abort']?.status).toBe('canceled');
  });

  it('cleans up pending requests on reset()', async () => {
    const handler = new AgyPermissionHandler(session);
    handler.setPermissionMode('default');

    const promise = handler.handleToolCall('call-reset', 'run_command', { CommandLine: 'echo 1' });
    expect(currentState.requests?.['call-reset']).toBeDefined();

    handler.reset('Session reset');

    await expect(promise).rejects.toThrow('Session reset');
    expect(currentState.requests?.['call-reset']).toBeUndefined();
    expect(currentState.completedRequests?.['call-reset']?.status).toBe('canceled');
  });

  it('completes tool call via completeToolCall()', () => {
    const handler = new AgyPermissionHandler(session);
    currentState.requests = {
      'call-1': { tool: 'run_command', arguments: { CommandLine: 'ls' }, createdAt: 1000 },
    };

    handler.completeToolCall('call-1', 'run_command', 'output text');

    expect(currentState.requests?.['call-1']).toBeUndefined();
    expect(currentState.completedRequests?.['call-1']).toEqual(
      expect.objectContaining({
        tool: 'run_command',
        status: 'approved',
      }),
    );
  });
});
