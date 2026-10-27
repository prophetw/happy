/** Output throughput for tokens and duration belonging to the same measured span. */
export function outputTokensPerSecond(outputTokens: unknown, durationMs: unknown): number | undefined {
    if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0
        || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
        return undefined;
    }
    const rate = outputTokens / durationMs * 1000;
    return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/** Totals behind a sampled rate, valid only when they can reproduce it. */
export type TokenSpeedSample = { tokens: number; durationMs: number; requests: number };

/**
 * Wire fields for a sample. Usage snapshots use snake_case like every other
 * provider-reported count, while trackers keep camelCase internally.
 */
export function speedSampleUsage(sample: TokenSpeedSample | undefined): {
    output_tokens_per_second_sample?: { tokens: number; duration_ms: number; requests: number };
} {
    return sample ? {
        output_tokens_per_second_sample: {
            tokens: sample.tokens,
            duration_ms: sample.durationMs,
            requests: sample.requests,
        },
    } : {};
}

function outputCount(value: unknown): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const counts = value as Record<string, unknown>;
    const count = counts.outputTokens ?? counts.output_tokens;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export type GenerationUsage = {
    generation_tokens_per_second?: number;
    generation_tokens_per_second_sample?: { tokens: number; duration_ms: number; requests: number };
    time_to_first_token_ms?: number;
};

/** Aggregates completed content streams; request waiting never enters the rate. */
export class GenerationStats {
    private tokens = 0;
    private durationMs = 0;
    private requests = 0;
    private waitMs = 0;
    private waitRequests = 0;
    completedSamples = 0;

    record(tokens: number, first: number | undefined, last: number | undefined, started?: number): void {
        if (!Number.isSafeInteger(tokens) || tokens <= 0 || first === undefined || !Number.isFinite(first)
            || (last !== undefined && (!Number.isFinite(last) || last < first))) return;
        const duration = last === undefined ? undefined : last - first;
        const measuredGeneration = outputTokensPerSecond(tokens, duration) !== undefined;
        const measuredWait = started !== undefined && Number.isFinite(started) && started <= first;
        if (measuredGeneration) {
            this.tokens += tokens;
            this.durationMs += duration!;
            this.requests++;
        }
        if (measuredWait) {
            this.waitMs += first - started!;
            this.waitRequests++;
        }
        if (measuredGeneration || measuredWait) this.completedSamples++;
    }

    get usage(): GenerationUsage {
        const rate = outputTokensPerSecond(this.tokens, this.durationMs);
        return {
            ...(rate !== undefined ? {
                generation_tokens_per_second: rate,
                generation_tokens_per_second_sample: { tokens: this.tokens, duration_ms: this.durationMs, requests: this.requests },
            } : {}),
            ...(this.waitRequests > 0 ? { time_to_first_token_ms: this.waitMs / this.waitRequests } : {}),
        };
    }
}

/**
 * Keeps the legacy request rate and independently aggregates content streams.
 * A completed request's usage provides another boundary after tool execution.
 * If those tools are still running, timing resumes only after all of them end.
 * Ambiguous activity and user waits fail closed; completed samples survive.
 */
export class CodexTokenSpeedTracker {
    private startedAt?: number;
    private inTurn = false;
    private baseline?: number;
    private latestTotal?: number;
    private latestUsage?: Record<string, unknown>;
    private hasResponse = false;
    private responseId?: string;
    private hasActivity = false;
    private activeTools = new Set<string>();
    private resumeAfterTools = false;
    private invalid = false;
    private rate?: number;
    private rateTokens?: number;
    private rateDurationMs?: number;
    private firstTokenAt?: number;
    private lastTokenAt?: number;
    private sawReasoningDelta = false;
    private generation = new GenerationStats();

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
            this.hasActivity = false;
            this.activeTools.clear();
            this.resumeAfterTools = false;
            this.invalid = false;
            this.rate = undefined;
            this.rateTokens = undefined;
            this.rateDurationMs = undefined;
            this.firstTokenAt = undefined;
            this.lastTokenAt = undefined;
            this.sawReasoningDelta = false;
            this.generation = new GenerationStats();
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
            if (this.inTurn && !this.invalid) {
                if (previousTotal !== undefined && total < previousTotal) {
                    this.invalid = true;
                } else if (!this.hasActivity) {
                    // Resume and prefill snapshots can repeat historical "last"
                    // counts. They establish a baseline, never a speed sample.
                    this.baseline = total;
                } else if (this.baseline !== undefined && total === this.baseline) {
                    // Repeated history is not the completed request's usage.
                } else if (last !== undefined && last > 0 && last <= total
                    && (this.baseline === undefined || total - this.baseline === last)) {
                    if (this.startedAt !== undefined && this.hasResponse && this.activeTools.size === 0) {
                        const durationMs = now - this.startedAt;
                        if (this.rate === undefined) {
                            this.rate = outputTokensPerSecond(last, durationMs);
                            this.invalid = this.rate === undefined;
                            if (this.rate !== undefined) {
                                this.rateTokens = last;
                                this.rateDurationMs = durationMs;
                            }
                        }
                        const counts = (message.last ?? info?.last_token_usage) as Record<string, unknown> | undefined;
                        const reasoning = counts?.reasoningOutputTokens ?? counts?.reasoning_output_tokens;
                        let generationTokens = last;
                        let generationEnd = this.lastTokenAt;
                        if (!this.sawReasoningDelta && reasoning !== undefined) {
                            // Codex output includes hidden reasoning. Pair the
                            // visible stream with its reported non-reasoning
                            // subset, while keeping full usage for context.
                            if (typeof reasoning === 'number' && Number.isSafeInteger(reasoning)
                                && reasoning >= 0 && reasoning < last) {
                                generationTokens -= reasoning;
                            } else {
                                // Unusable subset counts can still retain TTFT.
                                generationEnd = undefined;
                            }
                        }
                        this.generation.record(generationTokens, this.firstTokenAt, generationEnd, this.startedAt);
                    }
                    // The usage closes one request even if its own start was
                    // unusable. The next request can be timed from here, or
                    // from the end of tools that already began before here.
                    this.baseline = total;
                    this.startedAt = this.activeTools.size === 0 ? now : undefined;
                    this.resumeAfterTools = this.activeTools.size > 0;
                    this.hasActivity = false;
                    this.hasResponse = false;
                    this.responseId = undefined;
                    this.firstTokenAt = undefined;
                    this.lastTokenAt = undefined;
                    this.sawReasoningDelta = false;
                } else {
                    // Missing or mismatched counts cannot identify one request.
                    this.invalid = true;
                }
            }
        } else if (message.type === 'task_complete' || message.type === 'turn_aborted') {
            this.inTurn = false;
        } else {
            if (!this.inTurn || this.invalid) return undefined;
            const type = String(message.type);
            const toolEvent = /^(exec_command|mcp_tool_call|patch_apply|collab_agent|token_speed_tool)_(begin|end)$/.exec(type);
            if (toolEvent) {
                const callId = message.call_id ?? message.callId;
                const key = typeof callId === 'string' && callId ? `${toolEvent[1]}:${callId}` : undefined;
                if (!key) {
                    this.invalid = true;
                } else if (toolEvent[2] === 'begin') {
                    if (this.activeTools.has(key)) this.invalid = true;
                    this.activeTools.add(key);
                    this.startedAt = undefined;
                    this.firstTokenAt = undefined;
                    this.lastTokenAt = undefined;
                    this.sawReasoningDelta = false;
                    this.resumeAfterTools = false;
                    this.hasActivity = true;
                } else if (!this.activeTools.delete(key)) {
                    this.invalid = true;
                } else if (this.activeTools.size === 0 && this.resumeAfterTools && !this.hasResponse) {
                    this.startedAt = now;
                    this.resumeAfterTools = false;
                }
            } else if (message.type === 'token_speed_output_delta'
                || (['agent_message_delta', 'agent_reasoning_delta', 'agent_reasoning_raw_content_delta'].includes(type)
                    && typeof message.delta === 'string' && message.delta.length > 0)) {
                if (this.startedAt !== undefined && this.activeTools.size === 0) {
                    this.firstTokenAt ??= now;
                    this.lastTokenAt = now;
                    if (message.kind === 'reasoning' || type.startsWith('agent_reasoning')) this.sawReasoningDelta = true;
                }
            } else if (message.type === 'agent_message') {
                if (typeof message.message === 'string' && message.message.trim().length > 0) {
                    const responseId = typeof message.item_id === 'string' ? message.item_id : undefined;
                    if (this.hasResponse && (!responseId || responseId !== this.responseId)) this.invalid = true;
                    this.hasResponse = true;
                    this.hasActivity = true;
                    this.responseId = responseId;
                }
            } else if (![
                'agent_message_delta', 'agent_reasoning', 'agent_reasoning_delta',
                'agent_reasoning_section_break', 'agent_reasoning_raw_content',
                'agent_reasoning_raw_content_delta', 'user_message',
            ].includes(type)) {
                // An allowlist makes newly introduced tools/waits fail closed.
                this.invalid = true;
            }
            return undefined;
        }

        return this.latestUsage ? { usage: this.latestUsage, tokensPerSecond: this.rate } : undefined;
    }

    /** Totals behind the frozen first-response rate, for client-side detail. */
    get sample(): { tokens: number; durationMs: number; requests: number } | undefined {
        return this.rateTokens !== undefined && this.rateDurationMs !== undefined
            ? { tokens: this.rateTokens, durationMs: this.rateDurationMs, requests: 1 }
            : undefined;
    }

    get generationUsage(): GenerationUsage {
        return this.generation.usage;
    }
}
