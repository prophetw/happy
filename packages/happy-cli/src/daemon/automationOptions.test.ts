import { describe, expect, it } from 'vitest';
import type { AcpSessionConfigSnapshot } from '@/agent/acp/sessionConfigMetadata';
import { MachineMetadataSchema } from '@/api/types';
import { codeBuddyOptionsFromSnapshot } from '@/codebuddy/runCodeBuddy';
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

    it('shares CodeBuddy discovery with automation without changing its defaults', () => {
        const codebuddy = buildAutomationCatalog({ ...metadata,
            cliAvailability: { ...metadata.cliAvailability, codebuddy: true },
            codebuddyOptions: {
                models: [{ code: 'host-model', value: 'Host model' }, { code: 'unusable/model', value: 'Other model' }],
                currentModelCode: 'host-model',
                permissionModes: [{ code: 'default', value: 'Always Ask' }, { code: 'bypassPermissions', value: 'Bypass Permissions' }],
            },
        }).find(agent => agent.agent === 'codebuddy');

        expect(codebuddy?.models.map(model => model.key)).toEqual(['default', 'host-model']);
        expect(codebuddy?.permissionModes.map(mode => mode.key)).toEqual(['default', 'bypassPermissions']);
        expect(codebuddy).toMatchObject({ defaultModel: 'default', defaultPermissionMode: 'default', defaultEffort: '' });
    });

    it('keeps CodeBuddy ACP metadata model-specific and publishes only selectors seen for the current model', () => {
        const choices = (...values: string[]) => values.map(value => ({ value, name: value }));
        const snapshot: AcpSessionConfigSnapshot = {
            models: { currentModelId: 'first', availableModels: [
                { modelId: 'first', name: 'First', _meta: { maxInputTokens: 960000, effortOptions: choices('low', 'max') } },
                { modelId: 'second', name: 'Second', _meta: { effortOptions: choices('high') } },
            ] },
            modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] },
            configOptions: [
                { id: 'thought_level', category: 'thought_level', name: 'Reasoning', type: 'select', currentValue: 'max',
                    options: choices('low', 'max', 'enabled') },
                { id: 'context_window', name: 'Context window', type: 'select', currentValue: '900000',
                    options: choices('300000', '900000') },
            ],
        };
        const first = codeBuddyOptionsFromSnapshot(snapshot);
        expect(MachineMetadataSchema.shape.codebuddyOptions.parse(first)?.details).toEqual({
            currentModel: 'first', currentPermissionMode: 'default', permissionModes: ['default', 'plan'],
            models: [{ model: 'first', maxInputTokens: 960000, effortOptions: ['low', 'max'],
                sessionEffort: { values: ['low', 'max', 'enabled'], current: 'max' },
                contextWindow: { values: ['300000', '900000'], current: '900000' } },
            { model: 'second', effortOptions: ['high'] }],
        });
        const next = codeBuddyOptionsFromSnapshot({ ...snapshot, models: { ...snapshot.models!, currentModelId: 'second' },
            configOptions: [{ ...snapshot.configOptions![0], currentValue: 'high', options: choices('high') }] });
        expect(next?.details?.currentModel).toBe('second');
        expect(next?.details?.models).toEqual([
            { model: 'first', maxInputTokens: 960000, effortOptions: ['low', 'max'] },
            { model: 'second', effortOptions: ['high'], sessionEffort: { values: ['high'], current: 'high' } },
        ]);
        const installed = { ...metadata, cliAvailability: { ...metadata.cliAvailability, codebuddy: true } };
        const entry = buildAutomationCatalog({ ...installed, codebuddyOptions: next }).find(agent => agent.agent === 'codebuddy');
        expect(entry?.codebuddy).toEqual(next?.details);
        expect(entry?.efforts).toEqual([]);
        expect(codeBuddyOptionsFromSnapshot({})).toBeUndefined();
        expect(buildAutomationCatalog(installed).find(agent => agent.agent === 'codebuddy')).toMatchObject({
            models: [{ key: 'default' }], permissionModes: [{ key: 'default' }], efforts: [],
        });
    });
});
