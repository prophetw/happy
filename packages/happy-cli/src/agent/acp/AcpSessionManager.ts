import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope, type SessionTurnEndStatus } from '@slopus/happy-wire';
import type { AgentMessage } from '@/agent/core';

function turnOptions(turnId: string | null, time: number): CreateEnvelopeOptions {
  return turnId ? { turn: turnId, time } : { time };
}

function buildToolTitle(toolName: string): string {
  return toolName;
}

function buildToolDescription(toolName: string): string {
  return `Running ${toolName}`;
}

function parseThinkingPayload(payload: unknown): { text: string; streaming: boolean } {
  if (typeof payload === 'string') {
    return { text: payload, streaming: false };
  }
  if (!payload || typeof payload !== 'object') {
    return { text: '', streaming: false };
  }
  const text = typeof (payload as { text?: unknown }).text === 'string'
    ? (payload as { text: string }).text
    : '';
  const streaming = (payload as { streaming?: unknown }).streaming === true;
  return { text, streaming };
}

export class AcpSessionManager {
  private currentTurnId: string | null = null;
  private readonly acpCallToSessionCall = new Map<string, string>();
  private readonly nativeToolTurns = new Map<string, string>();

  /** Monotonic clock: max(lastTime + 1, Date.now()) */
  private lastTime = 0;

  /** Pending text waiting to be flushed when the stream type changes */
  private pendingText = '';
  private pendingType: 'thinking' | 'output' | null = null;
  private outputStream: { id: string; offset: number } | null = null;

  constructor(private readonly options: { streamOutput?: boolean; nativeToolIds?: boolean } = {}) {}

  private nextTime(): number {
    this.lastTime = Math.max(this.lastTime + 1, Date.now());
    return this.lastTime;
  }

  private ensureSessionCallId(acpCallId: string): string {
    const existing = this.acpCallToSessionCall.get(acpCallId);
    if (existing) {
      return existing;
    }

    const created = createId();
    this.acpCallToSessionCall.set(acpCallId, created);
    return created;
  }

  private flush(): SessionEnvelope[] {
    if (!this.pendingText || !this.pendingType) {
      return [];
    }
    const text = this.pendingText.replace(/^\n+|\n+$/g, '');
    const type = this.pendingType;
    this.pendingText = '';
    this.pendingType = null;
    if (!text) {
      return [];
    }
    if (type === 'thinking') {
      return [createEnvelope('agent', { t: 'text', text, thinking: true }, turnOptions(this.currentTurnId, this.nextTime()))];
    }
    return [createEnvelope('agent', { t: 'text', text }, turnOptions(this.currentTurnId, this.nextTime()))];
  }

  startTurn(): SessionEnvelope[] {
    if (this.currentTurnId) {
      return [];
    }

    this.currentTurnId = createId();
    this.acpCallToSessionCall.clear();
    // Reset pending text buffer so stale deltas from a previous turn never
    // leak into the new turn's stream.
    this.pendingText = '';
    this.pendingType = null;
    return [
      createEnvelope('agent', { t: 'turn-start' }, { turn: this.currentTurnId, time: this.nextTime() }),
    ];
  }

  endTurn(status: SessionTurnEndStatus, errorCode?: string): SessionEnvelope[] {
    const flushed = this.flush();
    if (!this.currentTurnId) {
      return flushed;
    }

    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    this.outputStream = null;
    this.acpCallToSessionCall.clear();
    this.pendingText = '';
    this.pendingType = null;
    return [
      ...flushed,
      createEnvelope('agent', { t: 'turn-end', status, ...(errorCode ? { errorCode } : {}) }, { turn: turnId, time: this.nextTime() }),
    ];
  }

  mapMessage(msg: AgentMessage): SessionEnvelope[] {
    if (msg.type === 'event' && msg.name === 'thinking') {
      const { text, streaming } = parseThinkingPayload(msg.payload);
      if (!text) {
        return [];
      }
      this.outputStream = null;

      if (streaming) {
        // Streaming thinking: accumulate, flush if switching from a different type
        const flushed = this.pendingType !== 'thinking' ? this.flush() : [];
        this.pendingType = 'thinking';
        this.pendingText += text;
        return flushed;
      }

      // Non-streaming thinking: flush pending, emit immediately
      const trimmed = text.replace(/^\n+|\n+$/g, '');
      if (!trimmed) {
        return this.flush();
      }
      return [
        ...this.flush(),
        createEnvelope('agent', { t: 'text', text: trimmed, thinking: true }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'status') {
      if ((msg.status === 'error' || msg.status === 'partial') && this.currentTurnId) {
        const detail = msg.detail?.trim() || 'The agent stopped because of an unknown error.';
        return [
          ...this.flush(),
          createEnvelope(
            'agent',
            { t: 'service', text: `Error: ${detail}` },
            { turn: this.currentTurnId, time: this.nextTime() },
          ),
        ];
      }
      return [];
    }

    if (msg.type === 'model-output') {
      const text = msg.textDelta ?? '';
      if (!text) {
        return [];
      }
      // Accumulate output, flush if switching from a different type
      const flushed = this.pendingType !== 'output' ? this.flush() : [];
      if (this.options.streamOutput && this.currentTurnId) {
        const stream = this.outputStream ??= { id: createId(), offset: 0 };
        // The app already uses this wire field to join text deltas within a turn.
        const envelope = createEnvelope('agent', { t: 'text', text, textOffset: stream.offset }, {
          turn: this.currentTurnId, time: this.nextTime(), codexItemId: stream.id,
        });
        stream.offset += text.length;
        return [...flushed, envelope];
      }
      this.pendingType = 'output';
      this.pendingText += text;
      return flushed;
    }

    if (msg.type === 'tool-call') {
      if (this.options.nativeToolIds && this.currentTurnId) {
        this.nativeToolTurns.set(msg.callId, this.currentTurnId);
      }
      this.outputStream = null;
      const flushed = this.flush();
      const call = this.options.nativeToolIds ? msg.callId : this.ensureSessionCallId(msg.callId);
      return [
        ...flushed,
        createEnvelope('agent', {
          t: 'tool-call-start',
          call,
          name: msg.toolName,
          title: buildToolTitle(msg.toolName),
          description: buildToolDescription(msg.toolName),
          args: msg.args,
        }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'tool-call-update') {
      const turn = this.nativeToolTurns.get(msg.callId);
      if (!turn) return [];
      return [createEnvelope('agent', {
        t: 'tool-call-update', call: msg.callId,
        ...(msg.name === undefined ? {} : { name: msg.name }),
        ...(msg.args === undefined ? {} : { args: msg.args }),
        ...(msg.terminal === undefined ? {} : { terminal: msg.terminal }),
      }, turnOptions(turn, this.nextTime()))];
    }

    if (msg.type === 'tool-result') {
      const turn = this.options.nativeToolIds ? this.nativeToolTurns.get(msg.callId) : this.currentTurnId;
      if (this.options.nativeToolIds && !turn) return [];
      const belongsToCurrentTurn = turn === this.currentTurnId;
      if (belongsToCurrentTurn) this.outputStream = null;
      const flushed = belongsToCurrentTurn ? this.flush() : [];
      const call = this.options.nativeToolIds ? msg.callId : this.ensureSessionCallId(msg.callId);
      const result = typeof msg.result === 'string' ? msg.result
        : msg.result == null ? undefined : JSON.stringify(msg.result);
      return [
        ...flushed,
        createEnvelope('agent', {
          t: 'tool-call-end', call,
          ...(result !== undefined ? { result } : {}),
          ...(msg.isError === undefined ? {} : { isError: msg.isError }),
        }, turnOptions(turn ?? null, this.nextTime())),
      ];
    }

    return [];
  }
}
