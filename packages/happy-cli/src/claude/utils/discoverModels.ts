import { resolveSettings, type Settings } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@/ui/logger';

export type ClaudeModelCatalog = {
    options: Array<{ code: string; value: string; description?: string | null }>;
    currentCode: string | null;
};

/** Only publish model configuration, never provider URLs or credentials. */
export function claudeModelsFromSettings(
    settings: Pick<Settings, 'model' | 'env' | 'availableModels'>,
    runtimeEnv: NodeJS.ProcessEnv = process.env,
): ClaudeModelCatalog {
    const env = { ...runtimeEnv, ...settings.env };
    const modelString = (value: unknown): string | null => (
        typeof value === 'string' && value.trim() ? value.trim() : null
    );
    const resolveModel = (value: unknown): string | null => {
        const model = modelString(value);
        const alias = model?.match(/^(opus|sonnet|haiku)(\[1m\])?$/i);
        if (!alias) return model;
        const mapped = modelString(env[`ANTHROPIC_DEFAULT_${alias[1].toUpperCase()}_MODEL`]);
        if (!mapped) return model;
        return alias[2] && !/\[1m\]$/i.test(mapped) ? `${mapped}${alias[2]}` : mapped;
    };
    const currentCode = resolveModel(modelString(env.ANTHROPIC_MODEL) ?? settings.model);
    // availableModels is an allowlist; [] offers only the ambient default.
    const configured = settings.availableModels ?? [
        currentCode,
        env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ];
    const codes = [...new Set(configured.map(resolveModel).filter((code): code is string => Boolean(code) && code !== 'default'))];
    return { options: codes.map(code => ({ code, value: code })), currentCode };
}

/** Use Claude's own settings merge engine, including CLAUDE_CONFIG_DIR. */
export async function discoverClaudeModels(cwd?: string): Promise<ClaudeModelCatalog | null> {
    try {
        const { effective } = await resolveSettings({
            cwd,
            // A machine has no project yet; a session has a working directory.
            settingSources: cwd ? ['user', 'project', 'local'] : ['user'],
        });
        return claudeModelsFromSettings(effective);
    } catch {
        logger.debug('[ClaudeModels] Could not resolve Claude Code model settings');
        return null;
    }
}
