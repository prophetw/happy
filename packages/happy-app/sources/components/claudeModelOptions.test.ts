import { describe, expect, it } from 'vitest';
import { getAvailableModels, getClaudeModelModes, getMachineModelModes } from './modelModeOptions';
import { getCodeAgentDefaults } from '@/sync/agentDefaults';
import type { MachineMetadata, Metadata } from '@/sync/storageTypes';

const translate = (key: string) => key;
const catalog = {
    currentCode: 'deepseek-v4.1-flash',
    options: [{ code: 'deepseek-v4.1-flash', value: 'deepseek-v4.1-flash' }],
};

describe('host Claude model selection', () => {
    it('preserves the complete aggregate picker order, labels and routing IDs for machines and sessions', () => {
        const options = [
            { code: 'ccs-claude-kimi--k3[1M]', value: 'k3（KimiK3-1M）', description: 'k3 · 1M' },
            { code: 'ccs-claude-deepseek--deepseek-flash[1M]', value: 'deepseek-flash（DeepSeek）', description: 'deepseek-flash · 1M' },
            { code: 'ccs-claude-kimi-2--deepseek-v4.1-flash[1M]', value: 'deepseek-v4.1-flash（ali-deepseek-flash-v41）', description: 'deepseek-v4.1-flash · 1M' },
            { code: 'ccs-claude-kimi-3--glm-5.3[1M]', value: 'glm-5.3（ali-glm53）', description: 'glm-5.3 · 1M' },
            { code: 'ccs-claude-kimi-4--deepseek-v4.1-flash-1017[1M]', value: 'deepseek-v4.1-flash-1017（ali-deepseek-flash-v41-1017）', description: 'deepseek-v4.1-flash-1017 · 1M' },
        ];
        const expected = options.map(row => ({ key: row.code, name: row.value, description: row.description }));
        const machineModels = getMachineModelModes('claude', {
            claudeModels: { currentCode: options[0].code, options },
        } as MachineMetadata, translate);
        const sessionModels = getAvailableModels('claude', {
            models: [{ code: 'default', value: options[0].code }, ...options],
            currentModelCode: options[0].code,
        } as Metadata, translate);
        expect(machineModels[0].key).toBe('default');
        expect(sessionModels[0].key).toBe('default');
        expect(machineModels.slice(1)).toEqual(expected);
        expect(sessionModels.slice(1)).toEqual(expected);
    });

    it('inherits Claude Code settings instead of selecting a fixed API model', () => {
        expect(getCodeAgentDefaults('claude').modelMode).toBe('default');
        expect(getClaudeModelModes().map(model => model.key)).toEqual(['default']);
    });

    it('offers the selected host catalog and labels its ambient model', () => {
        const models = getMachineModelModes('claude', { claudeModels: catalog } as MachineMetadata, translate);
        expect(models.map(model => model.key)).toEqual(['default', 'deepseek-v4.1-flash']);
        expect(models[0].name).toContain('deepseek-v4.1-flash');
    });

    it('does not offer a saved fixed model absent from the selected host', () => {
        const models = getMachineModelModes('claude', { claudeModels: catalog } as MachineMetadata, translate, 'claude-fable-5-1');
        expect(models.map(model => model.key)).toEqual(['default', 'deepseek-v4.1-flash']);
    });

    it('switches the model list with the host machine', () => {
        const models = getMachineModelModes('claude', {
            claudeModels: { options: [{ code: 'gateway-model', value: 'gateway-model' }], currentCode: 'gateway-model' },
        } as MachineMetadata, translate);
        expect(models.map(model => model.key)).toEqual(['default', 'gateway-model']);
    });

    it('keeps the ambient reset in a running session with model metadata', () => {
        const models = getAvailableModels('claude', {
            models: catalog.options,
            currentModelCode: catalog.currentCode,
        } as Metadata, translate);
        expect(models.map(model => model.key)).toEqual(['default', 'deepseek-v4.1-flash']);
    });

    it('shows an obsolete active override while allowing an explicit reset', () => {
        const models = getAvailableModels('claude', {
            models: [{ code: 'default', value: 'deepseek-v4.1-flash' }, ...catalog.options],
            currentModelCode: 'claude-fable-5-1',
        } as Metadata, translate, 'claude-fable-5-1');
        expect(models[0].key).toBe('default');
        expect(models.find(model => model.key === 'claude-fable-5-1')).toMatchObject({ disabled: true, unavailable: true });
    });
});
