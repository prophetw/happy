import type { ToolCall } from '@/sync/typesMessage';

export const DOT_MEMORY_TOOL_NAMES = ['dot_memory_recall', 'dot_memory_write', 'dot_memory_propose', 'dot_memory_confirm'] as const;
export type DotMemoryToolName = (typeof DOT_MEMORY_TOOL_NAMES)[number];
export type DotMemoryScope = 'dot' | 'user';

/** A memory the detail panel can open: the host binds it by digest and scope. */
export type DotMemoryTarget = { keyDigest: string; scope: DotMemoryScope };

export type DotMemoryRecallItem = {
    key: string;
    keyDigest: string | null;
    scope: DotMemoryScope | null;
    valueSummary: string | null;
    source: string | null;
    /** Present only when the reply carried both a usable digest and an explicit scope. */
    target: DotMemoryTarget | null;
};

export type DotMemoryHint =
    | { kind: 'recall'; status: 'running' | 'failed' | 'unreadable' | 'ready'; count: number; memories: DotMemoryRecallItem[] }
    | { kind: 'write'; tool: 'dot_memory_write' | 'dot_memory_confirm';
        status: 'running' | 'failed' | 'unreadable' | 'saved' | 'forgotten' | 'pending'; target: DotMemoryTarget | null }
    | { kind: 'propose'; status: 'running' | 'failed' | 'unreadable' | 'proposed' | 'pending' };

type Payload = Record<string, unknown>;

const KEY_DIGEST = /^sha256:[a-f0-9]{64}$/;
const VALUE_SUMMARY_LIMIT = 160;

function isRecord(value: unknown): value is Payload {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scopeOf(value: unknown): DotMemoryScope | null {
    return value === 'dot' || value === 'user' ? value : null;
}

function keyDigestOf(value: unknown): string | null {
    return typeof value === 'string' && KEY_DIGEST.test(value) ? value : null;
}

function parseJson(text: string): unknown {
    try { return JSON.parse(text); } catch { return undefined; }
}

/** Recognizes only the hosted Dot memory MCP tools; every other tool stays on the default view. */
export function dotMemoryToolName(tool: Pick<ToolCall, 'name' | 'input'>): DotMemoryToolName | null {
    if (tool.name !== 'McpTool' || !isRecord(tool.input) || tool.input.server !== 'dot_memory') return null;
    const name = tool.input.tool;
    return typeof name === 'string' && (DOT_MEMORY_TOOL_NAMES as readonly string[]).includes(name)
        ? name as DotMemoryToolName : null;
}

export function isDotMemoryToolCall(tool: Pick<ToolCall, 'name' | 'input'>): boolean {
    return dotMemoryToolName(tool) !== null;
}

/** Tool arguments are optional in history; a missing or opaque payload never blocks recognition. */
function argumentsOf(tool: Pick<ToolCall, 'input'>): Payload {
    if (!isRecord(tool.input)) return {};
    let args: unknown = tool.input.arguments;
    if (typeof args === 'string') args = parseJson(args);
    return isRecord(args) ? args : {};
}

/** Unwraps the Rust `Result` single-key form used by older Codex transports. */
function unwrapResult(value: unknown): { value?: unknown; failed: boolean } {
    if (isRecord(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === 'Ok') return { value: value.Ok, failed: false };
        if (keys.length === 1 && keys[0] === 'Err') return { failed: true };
    }
    return { value, failed: false };
}

function contentText(content: unknown[]): string | null {
    const text = content.map(block => (
        typeof block === 'string' ? block
            : isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text
                : undefined
    )).filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
    return text.trim() ? text : null;
}

/**
 * Recovers the structured payload from every shape the session protocol and MCP
 * transports have produced: a JSON string, a whole CallToolResult (structured
 * content wins over text blocks), an Ok/Err wrapper, or the bare payload.
 * Anything that cannot be read as a JSON object returns null, so callers never
 * report an unreadable reply as success.
 */
function payloadOf(value: unknown): Payload | null {
    const unwrapped = unwrapResult(value);
    if (unwrapped.failed) return null;
    let current = unwrapped.value;
    if (typeof current === 'string') {
        current = parseJson(current);
        if (current === undefined) return null;
        const nested = unwrapResult(current);
        if (nested.failed) return null;
        current = nested.value;
    }
    if (!isRecord(current)) return null;
    if (current.isError === true) return null;
    const structured = current.structuredContent !== undefined ? current.structuredContent : current.structured_content;
    if (structured !== undefined && structured !== null) return payloadOf(structured);
    if (Array.isArray(current.content)) {
        const text = contentText(current.content);
        if (text === null) return null;
        const parsed = parseJson(text);
        return parsed === undefined ? null : payloadOf(parsed);
    }
    return current;
}

/**
 * Distinguishes an explicit refusal/Err, which is a real failure, from a reply
 * that merely cannot be read. The two get different user-facing text.
 */
function explicitFailure(value: unknown): boolean {
    let current = value;
    if (typeof current === 'string') {
        current = parseJson(current);
        if (current === undefined) return false;
    }
    const unwrapped = unwrapResult(current);
    if (unwrapped.failed) return true;
    current = unwrapped.value;
    if (typeof current === 'string') return explicitFailure(current);
    if (!isRecord(current)) return false;
    if (current.ok === false || current.isError === true) return true;
    const structured = current.structuredContent !== undefined ? current.structuredContent : current.structured_content;
    if (structured !== undefined && structured !== null) return explicitFailure(structured);
    if (Array.isArray(current.content)) {
        const text = contentText(current.content);
        return text !== null && explicitFailure(text);
    }
    return false;
}

function summarizeValue(value: unknown): string | null {
    if (value === undefined) return null;
    let text: string;
    if (typeof value === 'string') text = value;
    else {
        try { text = JSON.stringify(value); } catch { return null; }
    }
    if (typeof text !== 'string') return null;
    return text.length > VALUE_SUMMARY_LIMIT ? `${text.slice(0, VALUE_SUMMARY_LIMIT)}…` : text;
}

function recallHint(payload: Payload, args: Payload): DotMemoryHint {
    if (payload.ok === false) return { kind: 'recall', status: 'failed', count: 0, memories: [] };
    if (!Array.isArray(payload.memories)) return { kind: 'recall', status: 'unreadable', count: 0, memories: [] };
    // scope=all replies tag every memory with its own layer; the request scope is not a substitute.
    const fallbackScope = scopeOf(payload.scope) ?? scopeOf(args.scope);
    const memories: DotMemoryRecallItem[] = [];
    for (const entry of payload.memories) {
        if (!isRecord(entry) || typeof entry.key !== 'string' || entry.key.length === 0) continue;
        const keyDigest = keyDigestOf(entry.keyDigest);
        // An explicit but non-layer scope (e.g. the request's `all`) never falls
        // back to the payload scope; only a missing field does.
        const scope = entry.scope === undefined ? fallbackScope : scopeOf(entry.scope);
        memories.push({
            key: entry.key,
            keyDigest,
            scope,
            valueSummary: summarizeValue(entry.value),
            source: typeof entry.source === 'string' ? entry.source : null,
            target: keyDigest && scope ? { keyDigest, scope } : null,
        });
    }
    // The headline reports the host's real list length, not just the rows we could render.
    return { kind: 'recall', status: 'ready', count: payload.memories.length, memories };
}

function writeHint(payload: Payload, tool: Pick<ToolCall, 'input'>, name: 'dot_memory_write' | 'dot_memory_confirm'): DotMemoryHint {
    if (payload.ok === false) return { kind: 'write', tool: name, status: 'failed', target: null };
    if (payload.ok !== true) return { kind: 'write', tool: name, status: 'unreadable', target: null };
    const status = payload.status;
    if (status !== 'saved' && status !== 'forgotten_locally') {
        // Duplicate replays, superseded proposals and unknown receipts stay visibly unconfirmed.
        return { kind: 'write', tool: name, status: 'pending', target: null };
    }
    const receipt = isRecord(payload.receipt) ? payload.receipt : {};
    const keyDigest = keyDigestOf(receipt.keyDigest);
    const scope = scopeOf(payload.scope) ?? scopeOf(receipt.scope) ?? scopeOf(argumentsOf(tool).scope);
    return {
        kind: 'write', tool: name, status: status === 'saved' ? 'saved' : 'forgotten',
        target: keyDigest && scope ? { keyDigest, scope } : null,
    };
}

export function dotMemoryHint(tool: ToolCall): DotMemoryHint | null {
    const name = dotMemoryToolName(tool);
    if (!name) return null;
    if (name === 'dot_memory_recall') {
        if (tool.state === 'running') return { kind: 'recall', status: 'running', count: 0, memories: [] };
        if (tool.state === 'error') return { kind: 'recall', status: 'failed', count: 0, memories: [] };
        const payload = payloadOf(tool.result);
        return payload ? recallHint(payload, argumentsOf(tool)) : { kind: 'recall',
            status: explicitFailure(tool.result) ? 'failed' : 'unreadable', count: 0, memories: [] };
    }
    if (name === 'dot_memory_propose') {
        if (tool.state === 'running') return { kind: 'propose', status: 'running' };
        if (tool.state === 'error') return { kind: 'propose', status: 'failed' };
        const payload = payloadOf(tool.result);
        if (!payload) return { kind: 'propose', status: explicitFailure(tool.result) ? 'failed' : 'unreadable' };
        if (payload.ok === false) return { kind: 'propose', status: 'failed' };
        if (payload.ok !== true) return { kind: 'propose', status: 'unreadable' };
        return { kind: 'propose', status: payload.status === 'proposed' ? 'proposed' : 'pending' };
    }
    if (tool.state === 'running') return { kind: 'write', tool: name, status: 'running', target: null };
    if (tool.state === 'error') return { kind: 'write', tool: name, status: 'failed', target: null };
    const payload = payloadOf(tool.result);
    return payload ? writeHint(payload, tool, name) : { kind: 'write', tool: name,
        status: explicitFailure(tool.result) ? 'failed' : 'unreadable', target: null };
}