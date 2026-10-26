/**
 * Converter from SDK message types to log format (RawJSONLines)
 * Transforms Claude SDK messages into the format expected by session logs
 */

import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import type {
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage
} from '@/claude/sdk'
import { UsageSchema, type RawJSONLines } from '@/claude/types'
import type { PermissionResponseLookup } from './permissionHandler'
import { readTranscriptUsage } from './readTranscriptUsage'
import { outputTokensPerSecond, speedSampleUsage } from '@/utils/tokenSpeed'
import { ClaudeModelRequestTokenSpeed, type ClaudeTokenSpeedBoundary } from './modelRequestTokenSpeed'

/**
 * Context for converting SDK messages to log format
 */
export interface ConversionContext {
    sessionId: string
    cwd: string
    version?: string
    gitBranch?: string
    parentUuid?: string | null
}

/**
 * Get current git branch for the working directory
 */
function getGitBranch(cwd: string): string | undefined {
    try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        }).trim()
        return branch || undefined
    } catch {
        return undefined
    }
}

function responseModelName(model: string): string {
    // cc-switch uses a routing ID in modelUsage but the upstream model name
    // in assistant messages. The window still comes from the SDK, never the ID.
    return model.replace(/^ccs-claude-.+?--/, '').replace(/\[1m\]$/i, '')
}

/**
 * SDK to Log converter class
 * Maintains state for parent-child relationships between messages
 */
export class SDKToLogConverter {
    private lastUuid: string | null = null
    private context: ConversionContext
    private responses?: PermissionResponseLookup
    private sidechainLastUUID = new Map<string, string>();
    private contextWindowByModel = new Map<string, number>();
    private latestMainMessage: SDKAssistantMessage['message'] | null = null;
    private mainResponseIds = new Set<string>();
    private sawSidechainResponse = false;
    private tokenSpeed = new ClaudeModelRequestTokenSpeed();

    constructor(
        context: Omit<ConversionContext, 'parentUuid'>,
        responses?: PermissionResponseLookup
    ) {
        this.context = {
            ...context,
            gitBranch: context.gitBranch ?? getGitBranch(context.cwd),
            version: context.version ?? process.env.npm_package_version ?? '0.0.0',
            parentUuid: null
        }
        this.responses = responses
    }

    /**
     * Update session ID (for when session changes during resume)
     */
    updateSessionId(sessionId: string): void {
        if (sessionId !== this.context.sessionId) {
            this.contextWindowByModel.clear()
            this.resetRequestMeasurements()
        }
        this.context.sessionId = sessionId
    }

    /**
     * Reset parent chain (useful when starting new conversation)
     */
    resetParentChain(): void {
        this.lastUuid = null
        this.context.parentUuid = null
        this.contextWindowByModel.clear()
        this.resetRequestMeasurements()
    }

    private resetRequestMeasurements(): void {
        this.latestMainMessage = null
        this.mainResponseIds.clear()
        this.sawSidechainResponse = false
        this.tokenSpeed = new ClaudeModelRequestTokenSpeed()
    }

    observeTokenSpeedBoundary(event: ClaudeTokenSpeedBoundary): void {
        this.tokenSpeed.boundary(event)
    }

    private contextWindowForModel(model: string): number | undefined {
        const exact = this.contextWindowByModel.get(model)
        if (exact) return exact

        const name = responseModelName(model)
        const windows = new Set<number>()
        for (const [reportedModel, window] of this.contextWindowByModel) {
            if (responseModelName(reportedModel) === name) windows.add(window)
        }
        // Different routes can expose the same model with different limits.
        return windows.size === 1 ? windows.values().next().value : undefined
    }

    /**
     * Stamp the model's real context window onto the message usage.
     *
     * The SDK only reports `contextWindow` on result messages, which arrive
     * after the assistant messages of the same turn, so we remember it per
     * model and attach it to assistant usage. Clients can then measure
     * context against the account's actual limit — which varies by model and
     * plan — instead of assuming a fixed one. Left untouched when the window
     * is not known yet; the result handler publishes that turn's snapshot.
     */
    private withContextWindow(message: any): any {
        if (!message?.usage) {
            return message
        }
        const explicitWindow = message.usage.context_window
        if (typeof explicitWindow === 'number' && Number.isFinite(explicitWindow) && explicitWindow > 0) {
            return message
        }
        const model = typeof message.model === 'string' ? message.model : undefined
        const contextWindow = model ? this.contextWindowForModel(model) : undefined
        if (!contextWindow) {
            return message
        }
        return {
            ...message,
            usage: { ...message.usage, context_window: contextWindow }
        }
    }

    private withFinalUsage(message: any): any {
        if (!message) return message
        const streamedUsage = typeof message.id === 'string' ? this.tokenSpeed.usageForResponse(message.id) : undefined
        if (streamedUsage) return { ...message, usage: streamedUsage }
        const usage = UsageSchema.safeParse(message.usage)
        if (usage.success && usage.data.input_tokens + (usage.data.cache_read_input_tokens ?? 0)
            + (usage.data.cache_creation_input_tokens ?? 0) > 0) {
            return message
        }
        if (typeof message.id !== 'string' || !message.id) return message
        const finalUsage = readTranscriptUsage(this.context.cwd, this.context.sessionId, message.id)
        return finalUsage ? { ...message, usage: finalUsage } : message
    }

    async waitForFinalUsage(): Promise<void> {
        const message = this.latestMainMessage
        if (!message?.id) return
        // Native transcript writes can finish just after the SDK result event.
        // Keep the wait bounded and scoped to this exact response/session.
        for (let attempt = 0; attempt < 6; attempt++) {
            if (this.latestMainMessage !== message) return
            const finalMessage = this.withFinalUsage(message)
            if (finalMessage !== message) {
                this.latestMainMessage = finalMessage
                return
            }
            const usage = UsageSchema.safeParse(message.usage)
            if (usage.success && usage.data.input_tokens + (usage.data.cache_read_input_tokens ?? 0)
                + (usage.data.cache_creation_input_tokens ?? 0) > 0) return
            if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 50))
        }
    }

    /**
     * Publish the turn's running model speed as soon as one request completes.
     * Carries that request's final usage so clients can also refresh context
     * occupancy mid-turn; the result message still emits the final snapshot.
     */
    private speedSnapshot(): RawJSONLines | null {
        const completed = this.tokenSpeed.latestSample
        const totals = this.tokenSpeed.sampledTotals
        const tokensPerSecond = this.tokenSpeed.tokensPerSecond
        if (!completed || !totals || tokensPerSecond === undefined) return null
        const usage = UsageSchema.safeParse(this.withContextWindow({
            model: completed.model,
            usage: completed.usage,
        })?.usage)
        if (!usage.success) return null
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        const snapshot: RawJSONLines = {
            parentUuid: this.lastUuid,
            isSidechain: false,
            userType: 'external',
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            uuid,
            timestamp,
            type: 'system',
            subtype: 'happy_context_usage',
            usage: {
                ...usage.data,
                output_tokens_per_second: tokensPerSecond,
                output_tokens_per_second_scope: 'model_request',
                ...speedSampleUsage(totals),
            },
        } as RawJSONLines
        this.lastUuid = uuid
        return snapshot
    }

    /**
     * Convert SDK message to log format
     */
    convert(sdkMessage: SDKMessage): RawJSONLines | null {
        const samplesBefore = this.tokenSpeed.completedSampleCount
        this.tokenSpeed.observe(sdkMessage)
        // Streaming deltas are timing input, not additional chat messages.
        // A request that just added a timed sample publishes the running model
        // speed immediately, so long turns are visible before the result.
        if (sdkMessage.type === 'stream_event') {
            return this.tokenSpeed.completedSampleCount === samplesBefore ? null : this.speedSnapshot()
        }
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        let parentUuid = this.lastUuid;
        let isSidechain = false;
        const parentToolUseId = (sdkMessage as any).parent_tool_use_id as string | null | undefined;
        if (parentToolUseId) {
            isSidechain = true;
            parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? null;
            this.sidechainLastUUID.set(parentToolUseId, uuid);
        }
        const baseFields = {
            parentUuid: parentUuid,
            isSidechain: isSidechain,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            uuid,
            timestamp
        }

        let logMessage: RawJSONLines | null = null

        switch (sdkMessage.type) {
            case 'user': {
                const userMsg = sdkMessage as SDKUserMessage
                // The SDK marks context-only injections (e.g. Skill tool
                // feeding the skill body back into the conversation) as
                // `isSynthetic: true` in memory; on disk claude writes the
                // equivalent flag as `isMeta`. The downstream mapper and
                // happy-app both already short-circuit on `isMeta`, so
                // forward the same signal whichever shape we received.
                const meta = (userMsg as any).isSynthetic === true || (userMsg as any).isMeta === true
                logMessage = {
                    ...baseFields,
                    type: 'user',
                    message: userMsg.message as any,
                    ...(userMsg.parent_tool_use_id ? { parent_tool_use_id: userMsg.parent_tool_use_id } : {}),
                    ...(meta ? { isMeta: true } : {}),
                }

                // Check if this is a tool result and add mode if available
                if (Array.isArray(userMsg.message.content)) {
                    for (const content of userMsg.message.content) {
                        if (content.type === 'tool_result' && content.tool_use_id && this.responses?.has(content.tool_use_id)) {
                            const response = this.responses.get(content.tool_use_id)
                            if (response?.mode) {
                                (logMessage as any).mode = response.mode
                            }
                        }
                    }
                } else if (typeof userMsg.message.content === 'string') {
                    // Simple string content, no tool result
                }
                break
            }

            case 'assistant': {
                const assistantMsg = sdkMessage as SDKAssistantMessage
                if (!parentToolUseId && !(assistantMsg as any).isSidechain) {
                    this.latestMainMessage = assistantMsg.message
                    if (assistantMsg.message.id) this.mainResponseIds.add(assistantMsg.message.id)
                } else {
                    this.sawSidechainResponse = true
                }
                logMessage = {
                    ...baseFields,
                    type: 'assistant',
                    message: this.withContextWindow(assistantMsg.message) as any,
                    // Assistant messages often have additional fields
                    requestId: (assistantMsg as any).requestId,
                    ...((assistantMsg as any).isCompactSummary ? { isCompactSummary: true } : {}),
                    ...(assistantMsg.parent_tool_use_id ? { parent_tool_use_id: assistantMsg.parent_tool_use_id } : {}),
                }
                // if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                //     for (const content of assistantMsg.message.content) {
                //         if (content.type === 'tool_use' && content.id) {
                //             this.sidechainLastUUID.set(content.id, uuid);
                //         }
                //     }
                // }
                break
            }

            case 'system': {
                const systemMsg = sdkMessage as SDKSystemMessage

                // System messages with subtype 'init' might update session ID
                if (!isSidechain && !(systemMsg as any).isSidechain && systemMsg.subtype === 'init' && systemMsg.session_id) {
                    this.updateSessionId(systemMsg.session_id)
                    // A fresh query may resume the same native session after
                    // an abort, without a result to clear the previous sample.
                    this.resetRequestMeasurements()
                }

                // System messages are typically not sent to logs
                // but we can convert them if needed
                logMessage = {
                    ...baseFields,
                    type: 'system',
                    subtype: systemMsg.subtype,
                    model: systemMsg.model,
                    tools: systemMsg.tools,
                    // Include all other fields
                    ...(systemMsg as any)
                }
                break
            }

            case 'result': {
                // Result usage is cumulative; retain only its per-model window
                // and combine it with the last main assistant's token counts.
                const resultMsg = sdkMessage as SDKResultMessage
                for (const [model, usage] of Object.entries(resultMsg.modelUsage ?? {})) {
                    const contextWindow = usage?.contextWindow
                    if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
                        this.contextWindowByModel.set(model, contextWindow)
                    }
                }
                const latestMainMessage = this.latestMainMessage
                this.latestMainMessage = null
                const usage = UsageSchema.safeParse(this.withContextWindow(this.withFinalUsage(latestMainMessage))?.usage)
                // The API-duration fallback needs a matching single-request
                // scope. Stream samples have independent request boundaries
                // and never divide by the aggregate result duration.
                const singleRequest = resultMsg.subtype === 'success' && !resultMsg.is_error
                    && this.tokenSpeed.canUseApiDuration
                    && resultMsg.num_turns === 1 && this.mainResponseIds.size === 1
                    && !this.sawSidechainResponse && Object.keys(resultMsg.modelUsage ?? {}).length <= 1
                    && usage.success && usage.data.output_tokens === resultMsg.usage?.output_tokens
                const sampledSpeed = this.tokenSpeed.tokensPerSecond
                const fallbackSpeed = sampledSpeed === undefined && singleRequest
                    ? outputTokensPerSecond(resultMsg.usage?.output_tokens, resultMsg.duration_api_ms) : undefined
                const tokensPerSecond = resultMsg.subtype === 'success' && !resultMsg.is_error
                    ? sampledSpeed ?? fallbackSpeed : undefined
                // Streamed samples are weighted across the turn's requests; the
                // API-duration fallback always describes exactly one request.
                const speedSample = sampledSpeed !== undefined
                    ? this.tokenSpeed.sampledTotals
                    : fallbackSpeed !== undefined
                        ? {
                            tokens: resultMsg.usage!.output_tokens,
                            durationMs: resultMsg.duration_api_ms!,
                            requests: 1,
                        }
                        : undefined
                this.resetRequestMeasurements()
                if (usage.success && (tokensPerSecond !== undefined || (typeof usage.data.context_window === 'number'
                    && Number.isFinite(usage.data.context_window) && usage.data.context_window > 0))) {
                    // A system snapshot avoids replaying chat text and avoids
                    // charging the same assistant usage a second time.
                    logMessage = {
                        ...baseFields,
                        type: 'system',
                        subtype: 'happy_context_usage',
                        usage: { ...usage.data, ...(tokensPerSecond !== undefined
                            ? {
                                output_tokens_per_second: tokensPerSecond,
                                output_tokens_per_second_scope: 'model_request',
                                ...speedSampleUsage(speedSample),
                            } : {}) },
                    }
                }
                break
            }

            default:
                // Unknown message type - pass through with all fields
                logMessage = {
                    ...baseFields,
                    ...sdkMessage,
                    type: (sdkMessage as any).type // Override type last to ensure it's set
                } as any
        }

        // Update last UUID for parent tracking
        if (logMessage && logMessage.type !== 'summary') {
            this.lastUuid = uuid
        }

        return logMessage
    }

    /**
     * Convert multiple SDK messages to log format
     */
    convertMany(sdkMessages: SDKMessage[]): RawJSONLines[] {
        return sdkMessages
            .map(msg => this.convert(msg))
            .filter((msg): msg is RawJSONLines => msg !== null)
    }

    /**
     * Convert a simple string content to a sidechain user message
     * Used for Task tool sub-agent prompts
     */
    convertSidechainUserMessage(toolUseId: string, content: string): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        this.sidechainLastUUID.set(toolUseId, uuid);
        return {
            parentUuid: null,
            isSidechain: true,
            parent_tool_use_id: toolUseId,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            type: 'user',
            message: {
                role: 'user',
                content: content
            },
            uuid,
            timestamp
        }
    }

    /**
     * Generate an interrupted tool result message
     * Used when a tool call is interrupted by the user
     * @param toolUseId - The ID of the tool that was interrupted
     * @param parentToolUseId - Optional parent tool ID if this is a sidechain tool
     */
    generateInterruptedToolResult(toolUseId: string, parentToolUseId?: string | null): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        const errorMessage = "[Request interrupted by user for tool use]"
        
        // Determine if this is a sidechain and get parent UUID
        let isSidechain = false
        let parentUuid: string | null = this.lastUuid
        
        if (parentToolUseId) {
            isSidechain = true
            // Look up the parent tool's UUID
            parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? null
            // Track this tool in the sidechain map
            this.sidechainLastUUID.set(parentToolUseId, uuid)
        }
        
        const logMessage: RawJSONLines = {
            type: 'user',
            isSidechain: isSidechain,
            ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            uuid,
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        content: errorMessage,
                        is_error: true,
                        tool_use_id: toolUseId
                    }
                ]
            },
            parentUuid: parentUuid,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            timestamp,
            toolUseResult: `Error: ${errorMessage}`
        } as any
        
        // Update last UUID for tracking
        this.lastUuid = uuid
        
        return logMessage
    }
}

/**
 * Convenience function for one-off conversions
 */
export function convertSDKToLog(
    sdkMessage: SDKMessage,
    context: Omit<ConversionContext, 'parentUuid'>,
    responses?: PermissionResponseLookup
): RawJSONLines | null {
    const converter = new SDKToLogConverter(context, responses)
    return converter.convert(sdkMessage)
}
