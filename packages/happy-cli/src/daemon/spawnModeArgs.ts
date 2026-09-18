import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

export function shouldForwardDaemonPermissionMode(
  agent: string,
  permissionMode: string | undefined,
): permissionMode is string {
  if (!permissionMode) return false;

  // Claude's "default" means no harness override. Codex's "default" is a
  // concrete ask-first execution policy and differs from its ambient "auto".
  return permissionMode !== 'default' || agent === 'codex';
}

export function appendDaemonSpawnModeArgs(
  args: string[],
  options: SpawnSessionOptions,
  agent: string,
): void {
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'agy') return;

  // For claude/agy, 'default' is the app's ambient "no override" value — forwarding
  // it would pin the session to prompting mode and lose the CLI's own default
  // (e.g. a --yolo setup where sessions must bypass permissions). For codex,
  // 'default' IS a concrete ask-first mode (untrusted + workspace-write)
  // distinct from the codex launch default, so it must be forwarded
  // or the user's explicit ask-first pick silently yields a yolo session.
  if (shouldForwardDaemonPermissionMode(agent, options.permissionMode)) {
    args.push('--permission-mode', options.permissionMode);
  }
  if (options.modelMode && options.modelMode !== 'default') {
    args.push('--model', options.modelMode);
  }
  if (options.effortLevel) {
    args.push('--effort', options.effortLevel);
  }
}