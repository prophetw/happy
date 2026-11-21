import type { PromptResponse } from '@agentclientprotocol/sdk';
import { homedir } from 'node:os';
import { runAcp } from '@/agent/acp';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import {
  extractConfigOptionsFromPayload,
  extractModelStateFromPayload,
  extractModeStateFromPayload,
  mergeAcpSessionConfigIntoMetadata,
  type AcpSessionConfigSnapshot,
} from '@/agent/acp/sessionConfigMetadata';
import { DefaultTransport } from '@/agent/transport';
import type { MachineMetadata } from '@/api/types';
import type { Credentials } from '@/persistence';

export function formatCodeBuddyError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/\bENOENT\b/.test(detail)) {
    return 'CodeBuddy CLI was not found. Install CodeBuddy Code and expose `codebuddy` on PATH for the Happy daemon.';
  }
  if (/\b401\b|authentication required|not logged in|unauthorized|\/login/i.test(detail)) {
    return 'CodeBuddy authentication is required. Run `codebuddy` and use `/login` on this machine, then try again.';
  }
  if (/Initialize timeout|ACP session startup timeout|Exit code:|unsupported protocol version/i.test(detail)) {
    return `CodeBuddy CLI could not start ACP (${detail}). Check that codebuddy --acp works on this machine.`;
  }
  return detail;
}

class CodeBuddyTransport extends DefaultTransport {
  getInitTimeout(): number {
    return 15_000;
  }

  turnEndOnPromptResponse(): boolean {
    return true;
  }

  getPromptError(response: PromptResponse): string | undefined {
    const outcome = response._meta?.['codebuddy.ai/outcome'];
    const error = response._meta?.['codebuddy.ai/errorMessage'];
    if (outcome === 'PERMISSION_DENIED') return 'CodeBuddy tool permission was denied.';
    if (response.stopReason === 'cancelled') return undefined;
    if (typeof error === 'string' && error) {
      const formatted = formatCodeBuddyError(error);
      if (formatted !== error) return formatted;
      // CodeBuddy can embed model-request diagnostics as JSON, including
      // authentication or request details that belong on the host.
      try {
        const { message } = JSON.parse(error) as { message?: unknown };
        if (typeof message === 'string' && message.trim()) return message;
      } catch {
        return error;
      }
      return 'CodeBuddy reported an error during the turn.';
    }
    if (typeof outcome === 'string' && (outcome.startsWith('FAILED_') || outcome === 'PARTIAL_SUCCESS' || outcome === 'REFUSED_OR_BLOCKED')) {
      return `CodeBuddy reported ${outcome}.`;
    }
    if (response.stopReason !== 'end_turn') {
      return `CodeBuddy ended the turn with ${response.stopReason ?? 'no ACP stop reason'}.`;
    }
    return undefined;
  }
}

const codeBuddyArgs = ['--acp', '--permission-mode', 'default'];

/** Read the installed CLI's catalog without sending a prompt or saving a session. */
export async function discoverCodeBuddyOptions(): Promise<MachineMetadata['codebuddyOptions']> {
  const backend = new AcpBackend({
    cwd: homedir(),
    agentName: 'codebuddy',
    command: 'codebuddy',
    args: [...codeBuddyArgs, '--no-session-persistence'],
    transportHandler: new CodeBuddyTransport('codebuddy'),
    startupAttempts: 1,
    permissionHandler: { handleToolCall: async () => ({ decision: 'abort' }) },
  });
  const snapshot: AcpSessionConfigSnapshot = {};
  backend.onMessage(message => {
    if (message.type !== 'event') return;
    switch (message.name) {
      case 'config_options_update':
        snapshot.configOptions = extractConfigOptionsFromPayload(message.payload);
        break;
      case 'models_update':
        snapshot.models = extractModelStateFromPayload(message.payload);
        break;
      case 'modes_update':
        snapshot.modes = extractModeStateFromPayload(message.payload);
        break;
    }
  });
  try {
    await backend.startSession();
    const { models = [], currentModelCode, operatingModes = [] } = mergeAcpSessionConfigIntoMetadata({}, snapshot);
    if (models.length === 0 && operatingModes.length === 0) return undefined;
    return { models, currentModelCode: currentModelCode ?? null, permissionModes: operatingModes };
  } finally {
    await backend.dispose();
  }
}

export async function runCodeBuddy(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  resumeSessionId?: string;
  initialModel?: string;
  initialPermissionMode?: string;
}): Promise<void> {
  await runAcp({
    ...opts,
    agentName: 'codebuddy',
    command: 'codebuddy',
    args: codeBuddyArgs,
    transportHandler: new CodeBuddyTransport('codebuddy'),
  });
}
