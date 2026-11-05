import { describe, expect, it } from 'vitest';
import { buildAutomationCatalog } from './automationOptions';

describe('automation catalog parity with published Happy machine models', () => {
    const metadata = {
        cliAvailability: { claude: true, codex: true, agy: true },
        codexModels: { options: [{ code: 'host-codex', value: 'Host Codex', thinkingLevels: ['high'] }] },
        claudeModels: { options: [{ code: 'host-claude', value: 'Host Claude' }] },
        agyModels: { options: [{ code: 'Gemini Future (High)', value: 'Gemini Future (High)' }], currentCode: null },
    } as any;
    it('uses current Agy discovery metadata and updates when that metadata changes', () => {
        expect(buildAutomationCatalog(metadata).find(a => a.agent === 'agy')?.models.map(m => m.key))
            .toEqual(['default', 'Gemini Future (High)']);
        const next = { ...metadata, agyModels: { options: [{ code: 'new-agy-model', value: 'New model' }] } };
        expect(buildAutomationCatalog(next).find(a => a.agent === 'agy')?.models.map(m => m.key))
            .toEqual(['default', 'new-agy-model']);
    });
    it('does not list an unavailable executable or invent Agy models before discovery', () => {
        expect(buildAutomationCatalog({ ...metadata, cliAvailability: { ...metadata.cliAvailability, agy: false } })
            .some(a => a.agent === 'agy')).toBe(false);
        expect(buildAutomationCatalog({ ...metadata, agyModels: undefined }).find(a => a.agent === 'agy')?.models ?? [])
            .not.toContainEqual(expect.objectContaining({ key: 'Gemini 3.8 Flash (High)' }));
    });
});
