import { describe, expect, it, vi } from 'vitest';
import { readCodexModelCatalog } from './discoverModels';

const terra = {
    model: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', description: 'New model',
    hidden: false, isDefault: true, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }],
};

describe('readCodexModelCatalog', () => {
    it('reads all pages, using model IDs and host effort levels, excluding hidden and duplicate rows', async () => {
        const listModels = vi.fn()
            .mockResolvedValueOnce({ data: [terra, { ...terra, model: 'hidden', hidden: true }], nextCursor: 'page2' })
            .mockResolvedValueOnce({ data: [terra, { ...terra, model: 'custom', isDefault: false }], nextCursor: null });
        const catalog = await readCodexModelCatalog({ listModels });
        expect(listModels.mock.calls).toEqual([[{ limit: 100 }], [{ limit: 100, cursor: 'page2' }]]);
        expect(catalog.currentCode).toBe('gpt-6.1-terra');
        expect(catalog.options.map(row => row.code)).toEqual(['gpt-6.1-terra', 'custom']);
        expect(catalog.options[0]).toEqual({
            code: 'gpt-6.1-terra', value: 'GPT-6.1 Terra', description: 'New model',
            thinkingLevels: ['low', 'ultra'], defaultThinkingLevel: 'low',
        });
    });

    it('rejects empty or malformed catalogs so callers retain the last successful result', async () => {
        for (const result of [{ data: [], nextCursor: null }, { data: [{ model: 'bad' }] }]) {
            await expect(readCodexModelCatalog({ listModels: vi.fn().mockResolvedValue(result) })).rejects.toThrow();
        }
    });

    it('does not publish a partial catalog if a later page fails', async () => {
        const listModels = vi.fn()
            .mockResolvedValueOnce({ data: [terra], nextCursor: 'page2' })
            .mockRejectedValueOnce(new Error('offline'));
        await expect(readCodexModelCatalog({ listModels })).rejects.toThrow('offline');
    });

    it('stops a repeated pagination cursor', async () => {
        const listModels = vi.fn().mockResolvedValue({ data: [terra], nextCursor: 'same' });
        await expect(readCodexModelCatalog({ listModels })).rejects.toThrow('repeated a cursor');
        expect(listModels).toHaveBeenCalledTimes(2);
    });
});
