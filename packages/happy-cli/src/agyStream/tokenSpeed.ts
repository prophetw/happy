import { outputTokensPerSecond } from '@/utils/tokenSpeed';

/** Uses only completed model response steps with their own token count and duration. */
export class AgyTokenSpeedTracker {
  private inTurn = false;
  private readonly samples = new Map<number, { output: number; durationMs: number }>();

  startTurn(): void {
    this.inTurn = true;
    this.samples.clear();
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

  reset(): void {
    this.inTurn = false;
    this.samples.clear();
  }
}

