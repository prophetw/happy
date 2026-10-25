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
 * Keeps the first measurable Codex response of a turn. A completed request's
 * usage provides another boundary when tools have interrupted the initial one.
 * If those tools are still running, timing resumes only after all of them end.
 * Ambiguous activity and user waits fail closed; a completed sample is frozen.
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
                } else if (!this.hasActivity) {
                    // Resume and prefill snapshots can repeat historical "last"
                    // counts. They establish a baseline, never a speed sample.
                    this.baseline = total;
                } else if (this.baseline !== undefined && total === this.baseline) {
                    // Repeated history is not the completed request's usage.
                } else if (last !== undefined && last > 0 && last <= total
                    && (this.baseline === undefined || total - this.baseline === last)) {
                    if (this.startedAt !== undefined && this.hasResponse && this.activeTools.size === 0) {
                        this.rate = outputTokensPerSecond(last, now - this.startedAt);
                        this.invalid = this.rate === undefined;
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
                } else {
                    // Missing or mismatched counts cannot identify one request.
                    this.invalid = true;
                }
            }
        } else if (message.type === 'task_complete' || message.type === 'turn_aborted') {
            this.inTurn = false;
        } else {
            if (!this.inTurn || this.rate !== undefined || this.invalid) return undefined;
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
                    this.resumeAfterTools = false;
                    this.hasActivity = true;
                } else if (!this.activeTools.delete(key)) {
                    this.invalid = true;
                } else if (this.activeTools.size === 0 && this.resumeAfterTools && !this.hasResponse) {
                    this.startedAt = now;
                    this.resumeAfterTools = false;
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
}
