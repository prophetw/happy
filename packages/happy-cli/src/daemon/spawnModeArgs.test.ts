import { describe, expect, it } from 'vitest';
import {
  appendDaemonSpawnModeArgs,
  shouldForwardDaemonPermissionMode,
  spawnWebhookTimeoutMs,
  DEFAULT_SPAWN_STARTUP_TIMEOUT_MS,
  SLOW_SPAWN_STARTUP_TIMEOUT_MS,
} from './spawnModeArgs';

describe('daemon spawn mode arguments', () => {
  it('forwards Codex default because it is a concrete ask-first policy', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'codex');

    expect(args).toEqual(['--permission-mode', 'default']);
  });

  it('leaves Claude default ambient', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'claude');

    expect(args).toEqual([]);
  });

  it('forwards explicit Codex permission, model, and effort selections', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, {
      directory: '/repo',
      permissionMode: 'yolo',
      modelMode: 'gpt-5.6-sol',
      effortLevel: 'medium',
    }, 'codex');

    expect(args).toEqual([
      '--permission-mode', 'yolo',
      '--model', 'gpt-5.6-sol',
      '--effort', 'medium',
    ]);
  });

  it('uses the same Codex default rule for resume launches', () => {
    expect(shouldForwardDaemonPermissionMode('codex', 'default')).toBe(true);
    expect(shouldForwardDaemonPermissionMode('claude', 'default')).toBe(false);
  });
});

describe('spawn webhook timeout', () => {
  it('gives Antigravity the slow window, resumed or not', () => {
    expect(spawnWebhookTimeoutMs('agy', false)).toBe(SLOW_SPAWN_STARTUP_TIMEOUT_MS);
    expect(spawnWebhookTimeoutMs('agy', true)).toBe(SLOW_SPAWN_STARTUP_TIMEOUT_MS);
  });

  it('gives Codex resume the slow window and a fresh Codex start the default', () => {
    expect(spawnWebhookTimeoutMs('codex', true)).toBe(SLOW_SPAWN_STARTUP_TIMEOUT_MS);
    expect(spawnWebhookTimeoutMs('codex', false)).toBe(DEFAULT_SPAWN_STARTUP_TIMEOUT_MS);
  });

  it('keeps other harnesses on the default window', () => {
    expect(spawnWebhookTimeoutMs('claude', false)).toBe(DEFAULT_SPAWN_STARTUP_TIMEOUT_MS);
    expect(spawnWebhookTimeoutMs('claude', true)).toBe(DEFAULT_SPAWN_STARTUP_TIMEOUT_MS);
    expect(spawnWebhookTimeoutMs('gemini', false)).toBe(DEFAULT_SPAWN_STARTUP_TIMEOUT_MS);
  });
});