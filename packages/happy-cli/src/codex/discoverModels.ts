import { z } from 'zod';
import { CodexAppServerClient } from './codexAppServerClient';

const ModelListSchema = z.object({
    data: z.array(z.object({
        model: z.string().min(1),
        displayName: z.string(),
        description: z.string(),
        hidden: z.boolean().optional(),
        supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
        defaultReasoningEffort: z.string(),
        isDefault: z.boolean(),
    })),
    nextCursor: z.string().nullish(),
});

/** Read the installed Codex's catalog without creating a thread or a turn. */
export async function readCodexModelCatalog(client: Pick<CodexAppServerClient, 'listModels'>) {
    const options: Array<{
        code: string;
        value: string;
        description: string;
        thinkingLevels: string[];
        defaultThinkingLevel: string;
    }> = [];
    let currentCode: string | null = null;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const models = new Set<string>();
    for (let page = 0; page < 100; page++) {
        const result = ModelListSchema.parse(await client.listModels({ limit: 100, ...(cursor ? { cursor } : {}) }));
        for (const model of result.data) {
            if (model.hidden || models.has(model.model)) continue;
            models.add(model.model);
            options.push({
                code: model.model,
                value: model.displayName || model.model,
                description: model.description,
                thinkingLevels: model.supportedReasoningEfforts.map(level => level.reasoningEffort),
                defaultThinkingLevel: model.defaultReasoningEffort,
            });
            if (model.isDefault) currentCode = model.model;
        }
        if (!result.nextCursor) {
            if (!options.length) throw new Error('Codex returned an empty model catalog');
            return { options, currentCode };
        }
        if (cursors.has(result.nextCursor)) throw new Error('Codex model pagination repeated a cursor');
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
    }
    throw new Error('Codex model pagination exceeded 100 pages');
}

export async function discoverCodexModels() {
    const client = new CodexAppServerClient();
    try {
        await client.connect();
        return await readCodexModelCatalog(client);
    } finally {
        await client.disconnect();
    }
}
