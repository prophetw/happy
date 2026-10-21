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
