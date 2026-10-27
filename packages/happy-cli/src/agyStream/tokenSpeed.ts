import { GenerationStats, outputTokensPerSecond, type GenerationUsage } from '@/utils/tokenSpeed';
import type { AgyStepUpdate } from './streamJson';

type ContentSpan = {
  startedAt?: number;
  first?: number;
  last?: number;
  tokens?: number;
  done: boolean;
  valid: boolean;
};

/** Preserves request-duration rates and independently measures native body streams. */
export class AgyTokenSpeedTracker {
  private inTurn = false;
  private readonly samples = new Map<number, { output: number; durationMs: number }>();
  private readonly content = new Map<number, ContentSpan>();
  private readonly activeTools = new Set<number>();
  private readonly completedTools = new Set<number>();
  private pendingStart?: number;

  startTurn(now = performance.now()): void {
    this.reset();
    this.inTurn = true;
    this.pendingStart = now;
  }

  /** Native step callback runs before that frame's usage and final text are emitted. */
  observeStep(step: AgyStepUpdate, now = performance.now()): void {
    if (!step || !this.inTurn || !Number.isSafeInteger(step.step_index) || step.step_index < 0) return;
    if (!['ACTIVE', 'DONE', 'ERROR'].includes(step.state)) {
      this.interrupt();
      return;
    }
    const index = step.step_index;
    if (step.step_type === 'tool' || step.step_type === 'subagent') {
      if (this.completedTools.has(index) && step.state !== 'ACTIVE') return;
      if (step.state === 'ACTIVE') {
        this.completedTools.delete(index);
        this.activeTools.add(index);
        this.interrupt();
      } else if (step.state === 'DONE' || step.state === 'ERROR') {
        this.completedTools.add(index);
        const paired = this.activeTools.delete(index);
        if (paired && this.activeTools.size === 0) this.pendingStart = now;
        else if (!paired) this.interrupt();
      }
      return;
    }
    if (step.step_type !== 'agent_response') {
      if (!['user_input', 'system_message', 'reasoning', 'process'].includes(step.step_type)) this.interrupt();
      return;
    }

    let span = this.content.get(index);
    if (!span) {
      const overlapping = [...this.content.values()].some(previous => !previous.done && previous.valid);
      if (overlapping) this.interrupt();
      span = { startedAt: this.pendingStart, done: false, valid: this.activeTools.size === 0 };
      this.pendingStart = undefined;
      this.content.set(index, span);
    }
    if (!span.done && typeof step.text_delta === 'string' && step.text_delta.length > 0) {
      span.first ??= now;
      span.last = now;
    }
    if (step.state === 'ERROR') {
      span.valid = false;
      span.done = true;
      this.samples.delete(index);
      this.pendingStart = undefined;
    } else if (step.state === 'DONE') {
      const firstCompletion = !span.done;
      span.done = true;
      if (step.usage !== undefined) {
        const output = step.usage?.output_tokens;
        const thinking = step.usage?.thinking_tokens;
        // Native agy reports thinking as a subset of output; text_delta is body only.
        span.tokens = typeof output === 'number' && Number.isSafeInteger(output) && output >= 0
          && typeof thinking === 'number' && Number.isSafeInteger(thinking) && thinking >= 0 && thinking <= output
          ? output - thinking : undefined;
      }
      if (firstCompletion && this.activeTools.size === 0) this.pendingStart = now;
    }
  }

  /** Approval, cancellation or unknown activity invalidates only unfinished spans. */
  interrupt(): void {
    this.pendingStart = undefined;
    for (const span of this.content.values()) if (!span.done) span.valid = false;
  }

  update(message: Record<string, unknown>): void {
    if (!this.inTurn || message.agy_usage_scope !== 'step'
      || message.agy_step_type !== 'agent_response' || message.agy_step_state !== 'DONE') return;

    const index = message.agy_step_index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return;
    const output = message.output_tokens ?? message.outputTokens;
    const duration = message.duration_seconds;
    if (typeof output === 'number' && Number.isSafeInteger(output) && output > 0
      && typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      // A repeated step is a replacement snapshot, never an additional request.
      this.samples.set(index, { output, durationMs: duration * 1000 });
    } else {
      this.samples.delete(index);
    }
  }

  finishTurn(): void {
    this.inTurn = false;
  }

  private totals(): { tokens: number; durationMs: number; requests: number } | undefined {
    let output = 0;
    let durationMs = 0;
    for (const sample of this.samples.values()) {
      output += sample.output;
      durationMs += sample.durationMs;
    }
    return this.samples.size > 0 && Number.isSafeInteger(output)
      ? { tokens: output, durationMs, requests: this.samples.size } : undefined;
  }

  get tokensPerSecond(): number | undefined {
    const totals = this.totals();
    return totals ? outputTokensPerSecond(totals.tokens, totals.durationMs) : undefined;
  }

  get sample(): { tokens: number; durationMs: number; requests: number } | undefined {
    return this.totals();
  }

  get generationUsage(): GenerationUsage {
    const stats = new GenerationStats();
    for (const span of this.content.values()) {
      if (span.done && span.valid) stats.record(span.tokens, span.first, span.last, span.startedAt);
    }
    return stats.usage;
  }

  reset(): void {
    this.inTurn = false;
    this.samples.clear();
    this.content.clear();
    this.activeTools.clear();
    this.completedTools.clear();
    this.pendingStart = undefined;
  }
}

