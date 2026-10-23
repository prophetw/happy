import { outputTokensPerSecond } from '@/utils/tokenSpeed';

/** Only turn summaries have a matching output count and elapsed interval. */
export class AgyTokenSpeedTracker {
  private startedAt: number | undefined;
  private outputTokens: unknown;
  private durationMs: number | undefined;
  private rate: number | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {}

  startTurn(): void {
    this.reset();
    this.startedAt = this.now();
  }

  update(message: Record<string, unknown>): void {
    // Step usage can repeat and must never be added to the final turn total.
    // Ignore replayed summaries outside an active turn (including resumed history).
    if (this.startedAt === undefined || message.agy_usage_scope !== 'turn') return;
    this.outputTokens = message.output_tokens;
    const seconds = message.duration_seconds;
    this.durationMs = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : undefined;
    this.updateRate();
  }

  finishTurn(): void {
    if (this.startedAt === undefined) return;
    this.updateRate();
    this.startedAt = undefined;
  }

  get tokensPerSecond(): number | undefined {
    return this.rate;
  }

  reset(): void {
    this.startedAt = undefined;
    this.outputTokens = undefined;
    this.durationMs = undefined;
    this.rate = undefined;
  }

  private updateRate(): void {
    this.rate = outputTokensPerSecond(
      this.outputTokens,
      this.durationMs ?? (this.now() - this.startedAt!),
    );
  }
}
