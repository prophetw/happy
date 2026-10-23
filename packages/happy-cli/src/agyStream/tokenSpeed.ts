import { outputTokensPerSecond } from '@/utils/tokenSpeed';

/** Tracks per-turn token speed for agy stream-json and SDK engines. */
export class AgyTokenSpeedTracker {
  private inTurn = false;
  private startedAt: number | undefined;
  private completedAt: number | undefined;
  private baseline: number | undefined;
  private latestCumulativeTotal: number | undefined;
  private stepOutputTokens = 0;
  private turnOutputTokens: number | undefined;
  private durationMs: number | undefined;
  private rate: number | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {}

  startTurn(): void {
    this.inTurn = true;
    this.startedAt = this.now();
    this.completedAt = undefined;
    this.baseline = this.latestCumulativeTotal;
    this.stepOutputTokens = 0;
    this.turnOutputTokens = undefined;
    this.durationMs = undefined;
    this.rate = undefined;
  }

  update(message: Record<string, unknown>): void {
    if (!this.inTurn || this.startedAt === undefined) return;

    if (message.agy_usage_scope !== 'turn') {
      const stepOut = message.output_tokens ?? message.outputTokens;
      if (typeof stepOut === 'number' && Number.isSafeInteger(stepOut) && stepOut > 0) {
        this.stepOutputTokens += stepOut;
      }
      return;
    }

    const rawTotal = message.output_tokens ?? message.outputTokens;
    if (typeof rawTotal !== 'number' || !Number.isFinite(rawTotal) || rawTotal <= 0) {
      this.turnOutputTokens = undefined;
      this.rate = undefined;
      return;
    }

    if (this.baseline !== undefined && rawTotal >= this.baseline) {
      this.turnOutputTokens = rawTotal - this.baseline;
      this.latestCumulativeTotal = rawTotal;
    } else if (this.baseline === undefined) {
      if (this.stepOutputTokens > 0 && rawTotal >= this.stepOutputTokens) {
        this.turnOutputTokens = this.stepOutputTokens;
        this.baseline = rawTotal - this.stepOutputTokens;
      } else {
        this.turnOutputTokens = rawTotal;
        this.baseline = 0;
      }
      this.latestCumulativeTotal = rawTotal;
    } else {
      // Counter reset or non-cumulative per-turn counts (e.g. SDK engine)
      this.turnOutputTokens = rawTotal;
      this.baseline = 0;
      this.latestCumulativeTotal = rawTotal;
    }

    const seconds = message.duration_seconds;
    this.durationMs = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : undefined;

    this.updateRate();
  }

  finishTurn(): void {
    if (!this.inTurn || this.startedAt === undefined) return;
    this.completedAt = this.now();
    if (this.turnOutputTokens === undefined && this.stepOutputTokens > 0) {
      this.turnOutputTokens = this.stepOutputTokens;
    }
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
    this.stepOutputTokens = 0;
    this.turnOutputTokens = undefined;
    this.durationMs = undefined;
    this.rate = undefined;
  }

  private updateRate(): void {
    if (this.startedAt === undefined) {
      this.rate = undefined;
      return;
    }
    const elapsedMs = Math.max(0, (this.completedAt ?? this.now()) - this.startedAt);
    const providerMs = typeof this.durationMs === 'number' && Number.isFinite(this.durationMs) && this.durationMs > 0
      ? this.durationMs
      : undefined;

    // A valid turn duration reported by the provider cannot be orders of magnitude larger
    // than the actual wall-clock elapsed time of the turn. In agy stream-json, duration_seconds
    // is the cumulative age of the conversation from inception (or process uptime), which can be
    // hundreds or thousands of seconds across multiple turns.
    const isRealisticProviderDuration = providerMs !== undefined
      && (elapsedMs === 0 || providerMs <= elapsedMs * 1.5 + 2000);

    const durationMs = isRealisticProviderDuration
      ? providerMs!
      : Math.max(1, elapsedMs);

    this.rate = outputTokensPerSecond(this.turnOutputTokens, durationMs);
  }
}

