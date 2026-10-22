import { afterEach, describe, expect, it, vi } from 'vitest';

const { resolveSettings } = vi.hoisted(() => ({ resolveSettings: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ resolveSettings }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

import { claudeModelsFromSettings, discoverClaudeModels } from './discoverModels';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';

const aggregatePicker: NonNullable<Settings['modelPicker']> = {
    replaceBuiltInOptions: true,
    options: [
        { model: 'ccs-claude-kimi--k3[1M]', label: 'k3（KimiK3-1M）', description: 'k3 · 1M' },
        { model: 'ccs-claude-deepseek--deepseek-flash[1M]', label: 'deepseek-flash（DeepSeek）', description: 'deepseek-flash · 1M' },
        { model: 'ccs-claude-kimi-2--deepseek-v4.1-flash[1M]', label: 'deepseek-v4.1-flash（ali-deepseek-flash-v41）', description: 'deepseek-v4.1-flash · 1M' },
        { model: 'ccs-claude-kimi-3--glm-5.3[1M]', label: 'glm-5.3（ali-glm53）', description: 'glm-5.3 · 1M' },
        { model: 'ccs-claude-kimi-4--deepseek-v4.1-flash-1017[1M]', label: 'deepseek-v4.1-flash-1017（ali-deepseek-flash-v41-1017）', description: 'deepseek-v4.1-flash-1017 · 1M' },
    ],
};

afterEach(() => vi.clearAllMocks());

describe('Claude host model discovery', () => {
    it('publishes every cc-switch aggregate picker row with its original model ID and label', async () => {
        resolveSettings.mockResolvedValue({ effective: {
            env: {
                ANTHROPIC_DEFAULT_OPUS_MODEL: aggregatePicker.options[0].model,
                ANTHROPIC_DEFAULT_SONNET_MODEL: aggregatePicker.options[0].model,
                ANTHROPIC_DEFAULT_HAIKU_MODEL: aggregatePicker.options[0].model,
                ANTHROPIC_AUTH_TOKEN: 'secret-token',
                ANTHROPIC_BASE_URL: 'https://private.example',
            },
            modelPicker: aggregatePicker,
        } });
        const catalog = await discoverClaudeModels();
        expect(catalog?.options).toEqual(aggregatePicker.options.map(row => ({
            code: row.model, value: row.label, description: row.description,
        })));
        expect(JSON.stringify(catalog)).not.toContain('secret-token');
        expect(JSON.stringify(catalog)).not.toContain('private.example');
    });

    it('replaces ambient rows while keeping picker aliases verbatim and the first duplicate', () => {
        expect(claudeModelsFromSettings({
            model: 'sonnet',
            env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-sonnet' },
            modelPicker: {
                replaceBuiltInOptions: true,
                options: [
                    { model: 'opus', label: 'Preferred', description: 'Custom Opus' },
                    { model: 'opus', label: 'Duplicate' },
                    { model: '  ', label: 'Blank' },
                ],
            },
        }, {})).toEqual({
            currentCode: 'gateway-sonnet',
            options: [{ code: 'opus', value: 'Preferred', description: 'Custom Opus' }],
        });
    });

    it('appends curated rows when replacement is not requested', () => {
        expect(claudeModelsFromSettings({
            model: 'host-model',
            modelPicker: { options: [
                { model: 'host-model', label: 'Duplicate' },
                { model: 'custom-model' },
            ] },
        }, {}).options).toEqual([
            { code: 'host-model', value: 'host-model' },
            { code: 'custom-model', value: 'custom-model', description: 'Custom model (custom-model)' },
        ]);
    });

    it('filters curated rows through availableModels without adding allowlist-only rows to a replacement', () => {
        const settings = {
            availableModels: [aggregatePicker.options[1].model, 'allowlist-only'],
            modelPicker: aggregatePicker,
        };
        expect(claudeModelsFromSettings(settings, {}).options).toEqual([{
            code: aggregatePicker.options[1].model,
            value: aggregatePicker.options[1].label,
            description: aggregatePicker.options[1].description,
        }]);
        expect(claudeModelsFromSettings({ ...settings, availableModels: [] }, {}).options).toEqual([]);
    });

    it('allows configured aliases and Claude family prefixes in a curated picker', () => {
        expect(claudeModelsFromSettings({
            env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-sonnet' },
            availableModels: ['sonnet', 'claude-opus-4-6'],
            modelPicker: { replaceBuiltInOptions: true, options: [
                { model: 'gateway-sonnet' },
                { model: 'claude-sonnet-4-6[1m]' },
                { model: 'claude-opus-4-6-20260101' },
                { model: 'claude-haiku-4-5' },
            ] },
        }, {}).options.map(row => row.code)).toEqual([
            'gateway-sonnet', 'claude-sonnet-4-6[1m]', 'claude-opus-4-6-20260101',
        ]);
    });

    it('falls back to ambient rows when a curated picker has no usable entries', () => {
        expect(claudeModelsFromSettings({
            model: 'host-model', modelPicker: { replaceBuiltInOptions: true, options: [] },
        }, {}).options).toEqual([{ code: 'host-model', value: 'host-model' }]);
    });

    it('uses the highest-precedence trusted picker without merging project or local rows', async () => {
        const projectPicker = { options: [{ model: 'project-model' }] };
        resolveSettings.mockResolvedValue({
            effective: { modelPicker: projectPicker },
            sources: [
                { source: 'user', settings: { modelPicker: aggregatePicker } },
                { source: 'project', settings: { modelPicker: projectPicker } },
                { source: 'local', settings: { modelPicker: projectPicker } },
            ],
        });
        expect((await discoverClaudeModels('/workspace'))?.options.map(row => row.code))
            .toEqual(aggregatePicker.options.map(row => row.model));

        const managedPicker = { replaceBuiltInOptions: true, options: [{ model: 'managed-model' }] };
        resolveSettings.mockResolvedValue({
            effective: { modelPicker: projectPicker },
            sources: [
                { source: 'user', settings: { modelPicker: aggregatePicker } },
                { source: 'managed', settings: { modelPicker: managedPicker } },
                { source: 'flag', settings: { modelPicker: projectPicker } },
            ],
        });
        expect((await discoverClaudeModels('/workspace'))?.options.map(row => row.code)).toEqual(['managed-model']);

        resolveSettings.mockResolvedValue({
            effective: { modelPicker: projectPicker },
            sources: [{ source: 'project', settings: { modelPicker: projectPicker } }],
        });
        expect((await discoverClaudeModels('/workspace'))?.options).toEqual([]);
    });

    it('uses the configured gateway models and never returns secrets', () => {
        const catalog = claudeModelsFromSettings({
            model: 'Opus[1m]',
            env: {
                ANTHROPIC_MODEL: 'deepseek-v4.1-flash',
                ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4.1-flash[1M]',
                ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4.1-flash[1M]',
                ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4.1-flash',
                ANTHROPIC_AUTH_TOKEN: 'secret-token',
                ANTHROPIC_BASE_URL: 'https://private.example',
            },
        }, {});
        expect(catalog).toEqual({
            currentCode: 'deepseek-v4.1-flash',
            options: [
                { code: 'deepseek-v4.1-flash', value: 'deepseek-v4.1-flash' },
                { code: 'deepseek-v4.1-flash[1M]', value: 'deepseek-v4.1-flash[1M]' },
            ],
        });
        expect(JSON.stringify(catalog)).not.toContain('secret-token');
        expect(JSON.stringify(catalog)).not.toContain('private.example');
    });

    it('resolves aliases and preserves a configured context suffix', () => {
        expect(claudeModelsFromSettings({ model: 'Opus[1m]', env: {
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'gateway-opus',
        } }, {}).currentCode).toBe('gateway-opus[1m]');
        expect(claudeModelsFromSettings({ model: 'Sonnet', env: {
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-sonnet[1M]',
        } }, {}).currentCode).toBe('gateway-sonnet[1M]');
    });

    it('respects availableModels including an empty allowlist', () => {
        expect(claudeModelsFromSettings({ model: 'host-model', availableModels: [] }, {}))
            .toEqual({ currentCode: 'host-model', options: [] });
        expect(claudeModelsFromSettings({ model: 'host-model', availableModels: ['allowed', 'allowed'] }, {}).options)
            .toEqual([{ code: 'allowed', value: 'allowed' }]);
    });

    it('inherits a process model and does not invent models for an unconfigured host', () => {
        expect(claudeModelsFromSettings({}, { ANTHROPIC_MODEL: 'process-model' }).currentCode).toBe('process-model');
        expect(claudeModelsFromSettings({}, {})).toEqual({ currentCode: null, options: [] });
    });

    it('uses user settings for a machine and the full cascade for a session', async () => {
        resolveSettings.mockResolvedValue({ effective: { model: 'host-model' } });
        await discoverClaudeModels();
        expect(resolveSettings).toHaveBeenLastCalledWith({ cwd: undefined, settingSources: ['user'] });
        await discoverClaudeModels('/workspace');
        expect(resolveSettings).toHaveBeenLastCalledWith({ cwd: '/workspace', settingSources: ['user', 'project', 'local'] });
    });

    it('leaves discovery unavailable when settings cannot be resolved', async () => {
        resolveSettings.mockRejectedValue(new Error('unreadable settings'));
        expect(await discoverClaudeModels()).toBeNull();
    });
});
