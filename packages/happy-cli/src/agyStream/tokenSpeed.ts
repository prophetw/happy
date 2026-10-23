import { outputTokensPerSecond } from '@/utils/tokenSpeed';

function outputCount(message: Record<string, unknown>): number | undefined {
  const value = message.output_tokens ?? message.outputTokens;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Tracks per-turn token speed for agy stream-json and SDK engines. */
export class AgyTokenSpeedTracker {
  private inTurn = false;
  private startedAt: number | undefined;
  private completedAt: number | undefined;
  private baseline: number | undefined;
  private latestCumulativeTotal: number | undefined;
  private readonly stepOutputs = new Map<number, number>();
  private turnOutputTokens: number | undefined;
  private invalid = false;
  private rate: number | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {}

  startTurn(): void {
    this.inTurn = true;
    this.startedAt = this.now();
    this.completedAt = undefined;
    this.baseline = this.latestCumulativeTotal;
    // Only a final session summary can establish the next turn's baseline.
    // A missing result must not leave the previous turn's total in place.
    this.latestCumulativeTotal = undefined;
    this.stepOutputs.clear();
    this.turnOutputTokens = undefined;
    this.invalid = false;
    this.rate = undefined;
  }

  update(message: Record<string, unknown>): void {
    if (!this.inTurn || this.startedAt === undefined) return;

    const count = outputCount(message);
    if (message.agy_usage_scope === 'step') {
      const index = message.agy_step_index;
      if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && count !== undefined) {
        // step_update carries a snapshot, not an additional token delta.
        this.stepOutputs.set(index, count);
      }
      return;
    }

    if (message.agy_usage_scope === 'session') {
      if (count === undefined) {
        this.latestCumulativeTotal = undefined;
        this.invalid = true;
      } else {
        const previous = this.latestCumulativeTotal ?? this.baseline;
        if (previous !== undefined && count < previous) this.invalid = true;
        // Keep a reset counter for the next turn, but hide this ambiguous span.
        this.latestCumulativeTotal = count;
      }
    } else if (message.agy_usage_scope === 'turn') {
      // The SDK bridge reports this chat call's usage, without session history.
      this.turnOutputTokens = count;
      if (count === undefined) this.invalid = true;
    } else {
      return;
    }

    this.updateRate();
  }

  finishTurn(): void {
    if (!this.inTurn || this.startedAt === undefined) return;
    this.completedAt = this.now();
    this.updateRate();
    this.inTurn = false;
  }

  get tokensPerSecond(): number | undefined {
    return this.rate;
  }

  reset(): void {
    this.inTurn = false;
    this.startedAt = undefined;
    this.completedAt = undefined;
    this.baseline = undefined;
    this.latestCumulativeTotal = undefined;
    this.stepOutputs.clear();
    this.turnOutputTokens = undefined;
    this.invalid = false;
    this.rate = undefined;
  }

  private outputTokens(): number | undefined {
    if (this.invalid) return undefined;
    if (this.turnOutputTokens !== undefined) return this.turnOutputTokens;
    if (this.latestCumulativeTotal !== undefined && this.baseline !== undefined) {
      return this.latestCumulativeTotal - this.baseline;
    }

    const steps = Array.from(this.stepOutputs.values()).reduce((sum, count) => sum + count, 0);
    if (this.stepOutputs.size === 0 || !Number.isSafeInteger(steps)) return undefined;
    if (this.latestCumulativeTotal !== undefined) {
      // A resumed turn has no starting total. Use only its unique step counts.
      return steps <= this.latestCumulativeTotal ? steps : undefined;
    }
    return this.completedAt !== undefined ? steps : undefined;
  }

  private updateRate(): void {
    // stream-json duration_seconds is conversation age, even when it happens
    // to be close to this turn's duration. Both engines use the local span.
    this.rate = this.startedAt === undefined ? undefined : outputTokensPerSecond(
      this.outputTokens(),
      (this.completedAt ?? this.now()) - this.startedAt,
    );
  }
}

