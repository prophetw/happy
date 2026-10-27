import type { SDKMessage } from '@/claude/sdk';
import type { Usage } from '@/api/types';
import { GenerationStats, outputTokensPerSecond, type GenerationUsage } from '@/utils/tokenSpeed';
import { UsageSchema } from '../types';

export type ClaudeTokenSpeedBoundary = 'tool-batch-complete' | 'prompt-submit' | 'interrupt';

/** Measures complete main-thread requests and their actual content streams. */
export class ClaudeModelRequestTokenSpeed {
    private pendingStart?: number;
    private active?: {
        id: string;
        model: string;
        startedAt?: number;
        usage: Record<string, unknown>;
        finalUsage: boolean;
        measurable: boolean;
        firstTokenAt?: number;
        lastTokenAt?: number;
    };
    private seen = new Set<string>();
    private models = new Set<string>();
    private sampledTokens = 0;
    private sampledDuration = 0;
    private sampledRequests = 0;
    private completedSamples = 0;
    private interrupted = false;
    private completed?: { id: string; model: string; usage: Usage };
    private generation = new GenerationStats();

    boundary(event: ClaudeTokenSpeedBoundary, now = performance.now()): void {
        if (this.active || (event === 'interrupt' && this.pendingStart !== undefined)) this.interrupted = true;
        // A batch can finish while its originating stream is still closing.
        // That overlap cannot establish a start for the following request.
        this.pendingStart = event !== 'interrupt' && !this.active ? this.pendingStart ?? now : undefined;
        if (this.active) {
            this.active.startedAt = undefined;
            this.active.measurable = false;
        }
    }

    observe(message: SDKMessage, now = performance.now()): void {
        if (('parent_tool_use_id' in message && message.parent_tool_use_id)
            || ('isSidechain' in message && message.isSidechain)) return;

        if (message.type === 'system' && (
            ['api_retry', 'compact_boundary', 'model_refusal_fallback'].includes(message.subtype)
            || (message.subtype === 'status' && message.status === 'compacting')
        )) {
            this.interrupted = true;
            this.boundary('interrupt');
        }
        if (message.type === 'assistant' && (message.error || message.aborted)) {
            this.interrupted = true;
            this.boundary('interrupt');
        }
        if (message.type !== 'stream_event') return;

        const event = message.event;
        if (event.type === 'message_start') {
            const { id, model, usage } = event.message;
            if (typeof id !== 'string' || !id || typeof model !== 'string' || !model || model === '<synthetic>') {
                this.pendingStart = undefined;
                this.active = undefined;
                return;
            }
            const measurable = !this.active && !this.seen.has(id);
            const startedAt = measurable ? this.pendingStart : undefined;
            this.pendingStart = undefined;
            this.seen.add(id);
            this.models.add(model);
            this.active = { id, model, startedAt, usage: { ...usage }, finalUsage: false, measurable };
        } else if (this.active && (event.type === 'content_block_delta' || event.type === 'content_block_start')) {
            const content = event.type === 'content_block_delta' ? event.delta : event.content_block;
            const chunk = 'text' in content ? content.text : 'thinking' in content ? content.thinking
                : 'partial_json' in content ? content.partial_json : undefined;
            if (typeof chunk === 'string' && chunk.length > 0) {
                this.active.firstTokenAt ??= now;
                this.active.lastTokenAt = now;
            }
        } else if (event.type === 'message_delta' && this.active) {
            const output = event.usage.output_tokens;
            if (!Number.isSafeInteger(output) || output < 0
                || (typeof this.active.usage.output_tokens === 'number' && output < this.active.usage.output_tokens)) {
                this.active.startedAt = undefined;
                this.active.measurable = false;
            }
            this.active.usage = { ...this.active.usage, ...event.usage };
            this.active.finalUsage = typeof event.delta.stop_reason === 'string';
        } else if (event.type === 'message_stop' && this.active) {
            const response = this.active;
            this.active = undefined;
            const usage = UsageSchema.safeParse(response.usage);
            if (!response.finalUsage || !usage.success) return;
            this.completed = { id: response.id, model: response.model, usage: usage.data };
            const generationSamplesBefore = this.generation.completedSamples;
            if (response.measurable) {
                this.generation.record(usage.data.output_tokens, response.firstTokenAt, response.lastTokenAt, response.startedAt);
            }
            const duration = response.startedAt === undefined ? undefined : now - response.startedAt;
            const measuredRequest = outputTokensPerSecond(usage.data.output_tokens, duration) !== undefined;
            if (measuredRequest) {
                this.sampledTokens += usage.data.output_tokens;
                this.sampledDuration += duration!;
                this.sampledRequests += 1;
            }
            if (measuredRequest || this.generation.completedSamples > generationSamplesBefore) this.completedSamples++;
        }
    }

    usageForResponse(id: string): Usage | undefined {
        return this.completed?.id === id ? this.completed.usage : undefined;
    }

    /** Monotonic count of requests that added a timed sample to this turn. */
    get completedSampleCount(): number {
        return this.completedSamples;
    }

    /** Usage of the request that finished last, refreshed even without usable timing. */
    get latestSample(): { model: string; usage: Usage } | undefined {
        return this.completed;
    }

    /** Totals behind the running rate, absent until one request was timed. */
    get sampledTotals(): { tokens: number; durationMs: number; requests: number } | undefined {
        return this.sampledRequests > 0
            ? { tokens: this.sampledTokens, durationMs: this.sampledDuration, requests: this.sampledRequests }
            : undefined;
    }

    get tokensPerSecond(): number | undefined {
        return this.models.size === 1 ? outputTokensPerSecond(this.sampledTokens, this.sampledDuration) : undefined;
    }

    get generationUsage(): GenerationUsage {
        return this.models.size === 1 ? this.generation.usage : {};
    }

    get canUseApiDuration(): boolean {
        return !this.interrupted && this.models.size <= 1 && this.seen.size <= 1;
    }
}
