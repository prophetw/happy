/** Output throughput for tokens and duration belonging to the same measured span. */
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

/**
 * Samples only the first uninterrupted Codex response of a turn. The public
 * protocol has no per-request start event: task_started is the sole reliable
 * initial boundary, so this includes local prompt preparation and request wait.
 * Once tools, compaction, retries or unknown activity intervene, skip the sample.
 * Never stretch a completed sample across later tool work or late usage.
 */
export class CodexTokenSpeedTracker {
    private startedAt?: number;
    private inTurn = false;
    private baseline?: number;
    private latestTotal?: number;
    private latestUsage?: Record<string, unknown>;
    private hasResponse = false;
    private responseId?: string;
    private invalid = false;
    private rate?: number;

    observe(message: Record<string, unknown>, now = performance.now()): {
        usage: Record<string, unknown>;
        tokensPerSecond: number | undefined;
    } | undefined {
        if (message.type === 'task_started') {
            this.startedAt = now;
            this.inTurn = true;
            this.baseline = this.latestTotal;
            this.latestUsage = undefined;
            this.hasResponse = false;
            this.responseId = undefined;
            this.invalid = false;
            this.rate = undefined;
            return undefined;
        }

        if (message.type === 'token_count') {
            const info = message.info as Record<string, unknown> | undefined;
            const total = outputCount(message.total ?? info?.total_token_usage);
            const last = outputCount(message.last ?? info?.last_token_usage);
            if (total === undefined) return undefined;

            const previousTotal = this.latestTotal;
            this.latestTotal = total;
            this.latestUsage = message;
            if (this.inTurn && this.rate === undefined && !this.invalid) {
                if (previousTotal !== undefined && total < previousTotal) {
                    this.invalid = true;
                } else if (!this.hasResponse) {
                    // Resume and prefill snapshots can repeat historical "last"
                    // counts. They establish a baseline, never a speed sample.
                    this.baseline = total;
                } else if (this.baseline !== undefined && total === this.baseline) {
                    // Repeated history is not the completed request's usage.
                } else if (last !== undefined && last > 0 && last <= total
                    && (this.baseline === undefined || total - this.baseline === last)) {
                    this.rate = outputTokensPerSecond(last, now - this.startedAt!);
                    this.invalid = this.rate === undefined;
                } else {
                    // Missing or mismatched counts cannot identify one request.
                    this.invalid = true;
                }
            }
        } else if (message.type === 'task_complete' || message.type === 'turn_aborted') {
            this.inTurn = false;
        } else {
            if (message.type === 'agent_message') {
                if (typeof message.message === 'string' && message.message.trim().length > 0) {
                    const responseId = typeof message.item_id === 'string' ? message.item_id : undefined;
                    if (this.hasResponse && (!responseId || responseId !== this.responseId)) this.invalid = true;
                    this.hasResponse = true;
                    this.responseId = responseId;
                }
            } else if (![
                'agent_message_delta', 'agent_reasoning', 'agent_reasoning_delta',
                'agent_reasoning_section_break', 'agent_reasoning_raw_content',
                'agent_reasoning_raw_content_delta', 'user_message',
            ].includes(String(message.type)) && this.inTurn && this.rate === undefined) {
                // An allowlist makes newly introduced tools/waits fail closed.
                this.invalid = true;
            }
            return undefined;
        }

        return this.latestUsage ? { usage: this.latestUsage, tokensPerSecond: this.rate } : undefined;
    }
}
