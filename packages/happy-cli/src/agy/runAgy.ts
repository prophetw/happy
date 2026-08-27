/**
 * Agy Session Runner
 *
 * Entry point for agy (Antigravity CLI) agent sessions, following the runOpenClaw.ts
 * pattern. The daemon spawns this as:
 *   `node dist/index.mjs agy --happy-starting-mode remote --started-by daemon`
 *
 * agy is executed with `--output-format stream-json`, and this runner drives an AgyBackend
 * that maps its structured events (text deltas, tool calls, tool results, thinking) into
 * Happy's ACP Session envelopes and mobile/web UI.
 *
 * Happy session lifecycle is fully decoupled from the agy subprocess: the Happy session
 * stays alive across turns, and dynamically binds to the agy conversation ID.
 */

import { randomUUID } from 'node:crypto';
import React from 'react';
import { render, type Instance as InkInstance } from 'ink';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { AgyDisplay } from '@/ui/ink/AgyDisplay';
import type { AgentMessage } from '@/agent/core';
import type { Session as ApiSession, PermissionMode } from '@/api/types';
import { normalizeRemotePermissionMode } from '@/claude/utils/permissionMode';
import { createAgyBackend } from './createAgyBackend';
import { DEFAULT_AGY_MODEL } from './constants';
import { discoverAgyModels, resolveAgyModelName } from './discoverModels';
import { extractSessionTitle } from './title';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { fetchAgyUsage, formatAgyUsageMarkdown, formatAgyUsageTerminal } from './usage';
import { AgyPermissionHandler } from './permissionHandler';

export interface RunAgyOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  model?: string;
  permissionMode?: PermissionMode;
  dangerouslySkipPermissions?: boolean;
  resumeConversationId?: string;
}

export async function runAgy(opts: RunAgyOptions): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend('agy');

  const log = (msg: string) => {
    logger.debug(`[agy] ${msg}`);
    if (verbose) {
      console.log(`[agy] ${msg}`);
    }
  };

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const discoveredModels = await discoverAgyModels({ log });

  const initialModel = resolveAgyModelName(opts.model, discoveredModels) ?? DEFAULT_AGY_MODEL;
  const isSkipPermissions =
    opts.dangerouslySkipPermissions === true ||
    opts.permissionMode === 'bypassPermissions' ||
    opts.permissionMode === 'yolo';
  const initialPermissionMode: PermissionMode =
    opts.permissionMode ?? (isSkipPermissions ? 'bypassPermissions' : 'default');

  const initialConversationId = opts.resumeConversationId;

  const { state, metadata } = createSessionMetadata({
    flavor: 'agy',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    dangerouslySkipPermissions: isSkipPermissions,
  });
  metadata.models = discoveredModels.map((m) => ({
    code: m.code,
    value: m.value,
    description: m.description ?? null,
  }));
  metadata.currentModelCode = initialModel;
  metadata.slashCommands = ['usage', 'clear', 'compact'];
  if (initialConversationId) {
    metadata.agyConversationId = initialConversationId;
  }

  // Check for session reconnection env vars (set by daemon for resume-in-place)
  const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
  const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
  const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
  const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;
  const reconnectMetadataVersion = process.env.HAPPY_RECONNECT_METADATA_VERSION;
  const reconnectAgentStateVersion = process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;

  let response: ApiSession | null;
  if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
    logger.debug(`[START] Reconnecting to existing agy session ${reconnectSessionId}`);
    response = {
      id: reconnectSessionId,
      seq: parseInt(reconnectSeq || '0', 10),
      encryptionKey: decodeBase64(reconnectKeyBase64),
      encryptionVariant: reconnectVariant,
      metadata,
      metadataVersion: parseInt(reconnectMetadataVersion || '0', 10),
      agentState: state,
      agentStateVersion: parseInt(reconnectAgentStateVersion || '0', 10),
    };
  } else {
    response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  }
  if (response) {
    log(`Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  let permissionHandler: AgyPermissionHandler;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
    },
  });
  session = initialSession;

  permissionHandler = new AgyPermissionHandler(session);
  permissionHandler.reset('Previous CLI process exited before responding');
  permissionHandler.setPermissionMode(initialPermissionMode);

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[agy] Failed to report session to daemon:', error);
    }
  }

  type AgyTurnMode = { permissionMode?: PermissionMode; model?: string };
  const sessionManager = new AcpSessionManager();
  const messageQueue = new MessageQueue2<AgyTurnMode>((mode) => JSON.stringify(mode));
  let shouldExit = false;
  let abortController = new AbortController();
  let thinking = false;

  let displayedModel = initialModel;

  const backend = createAgyBackend({
    cwd: process.cwd(),
    permissionMode: initialPermissionMode,
    model: initialModel,
    models: discoveredModels,
    conversationId: initialConversationId,
    log,
    onConversationId: (cid) => {
      if (metadata.agyConversationId !== cid) {
        metadata.agyConversationId = cid;
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          agyConversationId: cid,
        }));
        log(`Persisted agy conversation ID to session metadata: ${cid}`);
      }
    },
  });

  // Terminal UI (only with a real TTY; the daemon runs headless).
  const messageBuffer = new MessageBuffer();
  const hasTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let inkInstance: InkInstance | null = null;

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      session.sendSessionProtocolMessage(envelope);
    }
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      log(`Backend message: ${JSON.stringify(msg).slice(0, 200)}`);
    }

    if (msg.type === 'model-output' && msg.textDelta) {
      messageBuffer.addMessage(msg.textDelta, 'assistant');
    } else if (msg.type === 'tool-call') {
      messageBuffer.addMessage(`🔧 ${msg.toolName}`, 'status');
      permissionHandler.handleToolCall(msg.callId, msg.toolName, msg.args).catch((err) => {
        logger.debug('[agy] Tool permission rejected or aborted:', err);
      });
    } else if (msg.type === 'tool-result') {
      permissionHandler.completeToolCall(msg.callId, msg.toolName, (msg as any).result);
    } else if (msg.type === 'permission-request') {
      const payload = (msg as any).payload || {};
      session.sendAgentMessage('agy', {
        type: 'permission-request',
        permissionId: msg.id,
        toolName: payload.toolName || (msg as any).reason || 'unknown',
        description: (msg as any).reason || payload.toolName || '',
        options: payload,
      });
    } else if (msg.type === 'status') {
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
      if (msg.status === 'error' && msg.detail) {
        messageBuffer.addMessage(`Error: ${msg.detail}`, 'status');
      }
    }

    sendEnvelopes(sessionManager.mapMessage(msg));
  };

  backend.onMessage(onBackendMessage);

  if (hasTTY) {
    const DisplayComponent = () =>
      React.createElement(AgyDisplay, {
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        currentModel: displayedModel,
        onExit: async () => {
          logger.debug('[agy] Exiting agent via Ctrl-C');
          shouldExit = true;
          await handleAbort();
        },
      });

    inkInstance = render(React.createElement(DisplayComponent), {
      exitOnCtrlC: false,
      patchConsole: false,
    });
    messageBuffer.addMessage(`[MODEL:${displayedModel}]`, 'system');

    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  session.onUserMessage((message) => {
    if (!message.content.text) return;

    const mode: AgyTurnMode = {
      permissionMode: normalizeRemotePermissionMode(message.meta?.permissionMode),
      model: message.meta?.model
        ? (resolveAgyModelName(message.meta.model, discoveredModels) ?? message.meta.model)
        : undefined,
    };

    const specialCommand = parseSpecialCommand(message.content.text);
    if (specialCommand.type === 'clear') {
      log('Detected /clear command');
      messageQueue.pushIsolateAndClear(message.content.text, mode);
      return;
    }
    if (specialCommand.type === 'usage') {
      log('Detected /usage command');
      messageQueue.pushIsolateAndClear(message.content.text, mode);
      return;
    }

    messageBuffer.addMessage(message.content.text, 'user');
    messageQueue.push(message.content.text, mode);
  });
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    log('Abort requested');
    permissionHandler.abortAll();
    try {
      await backend.cancel(sessionTag);
    } catch (error) {
      logger.debug('[agy] Abort failed:', error);
    }
    thinking = false;
    session.keepAlive(false, 'remote');
    abortController.abort();
    abortController = new AbortController();
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    await handleAbort();
  });

  try {
    await backend.startSession();
    log('Backend ready');
    session.sendSessionEvent({ type: 'ready' });

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      if (batch.mode.permissionMode) {
        backend.setPermissionMode(batch.mode.permissionMode);
        permissionHandler.setPermissionMode(batch.mode.permissionMode);
      }
      if (batch.mode.model && batch.mode.model !== displayedModel) {
        displayedModel = batch.mode.model;
        backend.setModel(displayedModel);
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          currentModelCode: displayedModel,
        }));
        if (hasTTY) {
          messageBuffer.addMessage(`[MODEL:${displayedModel}]`, 'system');
        }
      }

      const specialCommand = parseSpecialCommand(batch.message);
      if (specialCommand.type === 'clear') {
        log('Handling /clear command - resetting agy session');
        backend.reset();
        permissionHandler.reset();
        delete metadata.agyConversationId;
        delete metadata.summary;
        session.updateMetadata((currentMetadata) => {
          const nextMetadata = { ...currentMetadata };
          delete nextMetadata.agyConversationId;
          delete nextMetadata.summary;
          return nextMetadata;
        });
        messageBuffer.addMessage('Context was reset', 'status');
        session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
        thinking = false;
        session.keepAlive(false, 'remote');
        session.sendSessionEvent({ type: 'ready' });
        continue;
      }

      if (specialCommand.type === 'usage') {
        log('Handling /usage command - fetching agy quota and usage');
        thinking = true;
        session.keepAlive(true, 'remote');
        try {
          const usageStatus = await fetchAgyUsage({ log });
          const markdownReport = formatAgyUsageMarkdown(usageStatus);

          if (hasTTY) {
            const terminalReport = formatAgyUsageTerminal(usageStatus);
            messageBuffer.addMessage(terminalReport, 'system');
          }

          sendEnvelopes(sessionManager.startTurn());
          sendEnvelopes(
            sessionManager.mapMessage({
              type: 'model-output',
              textDelta: markdownReport,
            }),
          );
          sendEnvelopes(sessionManager.endTurn('completed'));
        } catch (error) {
          const errText = `⚠️ Failed to fetch usage: ${error instanceof Error ? error.message : String(error)}`;
          log(errText);
          if (hasTTY) {
            messageBuffer.addMessage(errText, 'status');
          }
          sendEnvelopes(sessionManager.startTurn());
          sendEnvelopes(
            sessionManager.mapMessage({
              type: 'model-output',
              textDelta: errText,
            }),
          );
          sendEnvelopes(sessionManager.endTurn('failed'));
        } finally {
          thinking = false;
          session.keepAlive(false, 'remote');
          session.sendSessionEvent({ type: 'ready' });
        }
        continue;
      }

      log(`Incoming prompt: ${batch.message.slice(0, 200)}`);
      if (!metadata.summary) {
        const title = extractSessionTitle(batch.message);
        metadata.summary = {
          text: title,
          updatedAt: Date.now(),
        };
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          summary: metadata.summary,
        }));
        log(`Generated session title: "${title}"`);
      }

      sendEnvelopes(sessionManager.startTurn());
      try {
        await backend.sendPrompt(process.cwd(), batch.message);
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Turn ended: ${msg}`);
        sendEnvelopes(sessionManager.endTurn('failed'));
      }
      thinking = false;
      session.keepAlive(false, 'remote');
      session.sendSessionEvent({ type: 'ready' });
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    backend.offMessage(onBackendMessage);
    await backend.dispose();
    inkInstance?.unmount();

    try {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug('[agy] Session close failed:', error);
    }
  }
}
