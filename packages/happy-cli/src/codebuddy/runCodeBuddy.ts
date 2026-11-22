import type { PromptResponse } from '@agentclientprotocol/sdk';
import { taskOptionsSchema, type CodeBuddyOptionsDetails } from 'happy-agent/automation';
import { homedir } from 'node:os';
import { runAcp } from '@/agent/acp';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import {
  extractConfigOptionsFromPayload,
  extractModelStateFromPayload,
  extractModeStateFromPayload,
  flattenConfigSelectOptions,
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

export type CodeBuddyPromptResult = {
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  detail?: string;
};

function codeBuddyMetaError(error: unknown): string | undefined {
  if (typeof error !== 'string' || !error) return undefined;
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

/** Classify the JSON-RPC result without turning partial work into an exception. */
export function getCodeBuddyPromptResult(response: PromptResponse): CodeBuddyPromptResult {
  const outcome = response._meta?.['codebuddy.ai/outcome'];
  const error = codeBuddyMetaError(response._meta?.['codebuddy.ai/errorMessage']);
  if (outcome === 'PERMISSION_DENIED') return { status: 'failed', detail: 'CodeBuddy tool permission was denied.' };
  if (response.stopReason === 'cancelled') return { status: 'cancelled' };
  if (outcome === 'PARTIAL_SUCCESS' && response.stopReason === 'end_turn') {
    return {
      status: 'partial',
      detail: `CodeBuddy partially completed the turn (PARTIAL_SUCCESS): ${error ?? 'some work may be incomplete.'}`,
    };
  }
  if (error) return { status: 'failed', detail: error };
  if (typeof outcome === 'string' && (outcome.startsWith('FAILED_') || outcome === 'REFUSED_OR_BLOCKED')) {
    return { status: 'failed', detail: `CodeBuddy reported ${outcome}.` };
  }
  if (response.stopReason !== 'end_turn') {
    return { status: 'failed', detail: `CodeBuddy ended the turn with ${response.stopReason ?? 'no ACP stop reason'}.` };
  }
  return { status: 'completed' };
}

class CodeBuddyTransport extends DefaultTransport {
  getInitTimeout(): number {
    return 15_000;
  }

  turnEndOnPromptResponse(): boolean {
    return true;
  }

  getPromptError(response: PromptResponse): string | undefined {
    const result = getCodeBuddyPromptResult(response);
    return result.status === 'failed' ? result.detail : undefined;
  }

  getPromptPartialError(response: PromptResponse): string | undefined {
    const result = getCodeBuddyPromptResult(response);
    return result.status === 'partial' ? result.detail : undefined;
  }
}

const codeBuddyArgs = ['--acp', '--permission-mode', 'default'];

function optionID(value: unknown): string | undefined {
  const parsed = taskOptionsSchema.shape.effort.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function optionIDs(values: unknown[]): string[] {
  return [...new Set(values.map(optionID).filter((value): value is string => value !== undefined))].slice(0, 32);
}

export function codeBuddyOptionsFromSnapshot(snapshot: AcpSessionConfigSnapshot): MachineMetadata['codebuddyOptions'] {
  const { models = [], currentModelCode, operatingModes = [], currentOperatingModeCode, thoughtLevels, currentThoughtLevelCode }
    = mergeAcpSessionConfigIntoMetadata({}, snapshot);
  if (models.length === 0 && operatingModes.length === 0) return undefined;
  const model = currentModelCode && currentModelCode !== 'default' && models.some(item => item.code === currentModelCode)
    && taskOptionsSchema.shape.model.safeParse(currentModelCode).success ? currentModelCode : undefined;
  const mode = optionID(currentOperatingModeCode);
  const permissionModes = optionIDs(operatingModes.map(item => item.code));
  const contextSelector = snapshot.configOptions?.find(option => option.type === 'select' && option.id === 'context_window');
  const nativeModels = new Map(snapshot.models?.availableModels.map(entry => [entry.modelId, entry._meta]));
  const details: CodeBuddyOptionsDetails = {
    ...(model ? { currentModel: model } : {}),
    ...(mode ? { currentPermissionMode: mode } : {}),
    ...(operatingModes.length ? { permissionModes } : {}),
    models: models.filter(item => item.code !== 'default' && taskOptionsSchema.shape.model.safeParse(item.code).success)
      .slice(0, 255).map(({ code }) => {
        const native = nativeModels.get(code);
        const maxInputTokens = native?.maxInputTokens;
        const currentEffort = code === model ? optionID(currentThoughtLevelCode) : undefined;
        const context = code === model && contextSelector?.type === 'select' ? contextSelector : undefined;
        const currentContext = optionID(context?.currentValue);
        return {
          model: code,
          ...(typeof maxInputTokens === 'number' && Number.isSafeInteger(maxInputTokens) && maxInputTokens > 0 ? { maxInputTokens } : {}),
          ...(Array.isArray(native?.effortOptions) ? { effortOptions: optionIDs(flattenConfigSelectOptions(native.effortOptions).map(item => item.code)) } : {}),
          ...(code === model && thoughtLevels ? { sessionEffort: {
            values: optionIDs(thoughtLevels.map(item => item.code)), ...(currentEffort ? { current: currentEffort } : {}),
          } } : {}),
          ...(context ? { contextWindow: {
            values: optionIDs(flattenConfigSelectOptions(context.options).map(item => item.code)),
            ...(currentContext ? { current: currentContext } : {}),
          } } : {}),
        };
      }),
  };
  return { models, currentModelCode: currentModelCode ?? null, permissionModes: operatingModes, details };
}

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
    return codeBuddyOptionsFromSnapshot(snapshot);
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
