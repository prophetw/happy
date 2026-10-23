/** Average output throughput over a measured span, including waits and tool work. */
export function outputTokensPerSecond(outputTokens: unknown, durationMs: unknown): number | undefined {
    if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0
        || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
        return undefined;
    }
    const rate = outputTokens / durationMs * 1000;
    return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

function outputCount(value: unknown): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const counts = value as Record<string, unknown>;
    const count = counts.outputTokens ?? counts.output_tokens;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/** Uses cumulative counts so repeated token notifications never inflate the rate. */
export class CodexTokenSpeedTracker {
    private startedAt?: number;
    private completedAt?: number;
    private baseline?: number;
    private latestTotal?: number;
    private latestUsage?: Record<string, unknown>;
    private invalid = false;

    observe(message: Record<string, unknown>, now = performance.now()): {
        usage: Record<string, unknown>;
        tokensPerSecond: number | undefined;
    } | undefined {
        if (message.type === 'task_started') {
            this.startedAt = now;
            this.completedAt = undefined;
            this.baseline = this.latestTotal;
            this.latestUsage = undefined;
            this.invalid = false;
            return undefined;
        }

        if (message.type === 'token_count') {
            const info = message.info as Record<string, unknown> | undefined;
            const total = outputCount(message.total ?? info?.total_token_usage);
            const last = outputCount(message.last ?? info?.last_token_usage);
            if (total === undefined) return undefined;

            if (this.startedAt !== undefined && this.latestTotal !== undefined && total < this.latestTotal) {
                // Compaction or a counter reset invalidates this span's baseline.
                this.invalid = true;
            }
            if (this.startedAt !== undefined && this.baseline === undefined) {
                // Only the first sample can establish the start baseline. A
                // later per-response count cannot recover earlier output.
                if (last !== undefined && last <= total && !this.invalid) {
                    this.baseline = total - last;
                } else {
                    this.invalid = true;
                }
            }
            this.latestTotal = total;
            this.latestUsage = message;
        } else if (message.type === 'task_complete' || message.type === 'turn_aborted') {
            this.completedAt ??= now;
        } else {
            return undefined;
        }

        if (!this.latestUsage) return undefined;
        return {
            usage: this.latestUsage,
            tokensPerSecond: this.startedAt !== undefined && this.baseline !== undefined && this.latestTotal !== undefined && !this.invalid
                ? outputTokensPerSecond(this.latestTotal - this.baseline, (this.completedAt ?? now) - this.startedAt)
                : undefined,
        };
    }
}
