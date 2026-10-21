import { afterEach, describe, expect, it, vi } from 'vitest';

const { resolveSettings } = vi.hoisted(() => ({ resolveSettings: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ resolveSettings }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

import { claudeModelsFromSettings, discoverClaudeModels } from './discoverModels';

afterEach(() => vi.clearAllMocks());

describe('Claude host model discovery', () => {
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
