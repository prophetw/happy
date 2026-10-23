import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { UsageSchema } from '../types';
import type { Usage } from '@/api/types';
import { logger } from '@/ui/logger';
import { getProjectPath } from './path';

/** Recover final counts for one exact response when its SDK usage is a placeholder. */
export function readTranscriptUsage(cwd: string, sessionId: string, messageId: string): Usage | undefined {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
        return undefined;
    }

    let fd: number | undefined;
    try {
        fd = openSync(join(getProjectPath(cwd), `${sessionId}.jsonl`), 'r');
        const size = fstatSync(fd).size;
        // Only inspect the bounded tail, never reload the entire conversation.
        const start = Math.max(0, size - 1024 * 1024);
        const buffer = Buffer.alloc(size - start);
        const bytes = readSync(fd, buffer, 0, buffer.length, start);
        const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
        if (start > 0) lines.shift(); // The first line may start mid-record.

        for (let i = lines.length - 1; i >= 0; i--) {
            let entry;
            try { entry = JSON.parse(lines[i]); } catch { continue; }
            if (entry?.type !== 'assistant' || entry.isSidechain || entry.parent_tool_use_id
                || entry.message?.id !== messageId
                || (entry.sessionId && entry.sessionId !== sessionId)) {
                continue;
            }
            const usage = UsageSchema.safeParse(entry.message.usage);
            if (usage.success && usage.data.input_tokens + (usage.data.cache_read_input_tokens ?? 0)
                + (usage.data.cache_creation_input_tokens ?? 0) > 0) {
                return usage.data;
            }
        }
    } catch (error) {
        logger.debug('[readTranscriptUsage] Final usage unavailable', error);
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
    return undefined;
}
