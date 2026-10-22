import { resolveSettings, type Settings } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@/ui/logger';

export type ClaudeModelCatalog = {
    options: Array<{ code: string; value: string; description?: string | null }>;
    currentCode: string | null;
};

/** Only publish model configuration, never provider URLs or credentials. */
export function claudeModelsFromSettings(
    settings: Pick<Settings, 'model' | 'env' | 'availableModels' | 'modelPicker'>,
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
    const options: ClaudeModelCatalog['options'] = codes.map(code => ({ code, value: code }));
    const normalize = (model: string): string => model.toLowerCase().replace(/\[1m\]$/, '');
    const isAllowed = (code: string): boolean => settings.availableModels === undefined || settings.availableModels.some(allowed => {
        const model = normalize(code);
        const entry = normalize(allowed.trim());
        const resolvedAllowed = resolveModel(allowed);
        if (!resolvedAllowed) return false;
        if (model === entry || normalize(resolveModel(code)!) === normalize(resolvedAllowed)) return true;
        // Claude allowlists also accept family aliases and version prefixes.
        const prefix = /^(opus|sonnet|haiku)(?:-|$)/.test(entry) ? `claude-${entry}` : entry;
        return /^claude-(opus|sonnet|haiku)(?:-|$)/.test(prefix) && model.startsWith(prefix);
    });
    const curated: ClaudeModelCatalog['options'] = [];
    const seen = new Set<string>();
    for (const row of settings.modelPicker?.options ?? []) {
        // Picker IDs are --model values, including aliases, used verbatim.
        const code = modelString(row.model);
        if (!code || code === 'default' || seen.has(code) || !isAllowed(code)) continue;
        seen.add(code);
        curated.push({
            code,
            value: modelString(row.label) ?? code,
            description: modelString(row.description) ?? `Custom model (${code})`,
        });
    }
    // Claude keeps the ambient lineup if no curated rows survive filtering.
    if (curated.length === 0) return { options, currentCode };
    if (settings.modelPicker?.replaceBuiltInOptions) return { options: curated, currentCode };
    return { options: [...options, ...curated.filter(row => !codes.includes(row.code))], currentCode };
}

/** Use Claude's own settings merge engine, including CLAUDE_CONFIG_DIR. */
export async function discoverClaudeModels(cwd?: string): Promise<ClaudeModelCatalog | null> {
    try {
        const { effective, sources } = await resolveSettings({
            cwd,
            // A machine has no project yet; a session has a working directory.
            settingSources: cwd ? ['user', 'project', 'local'] : ['user'],
        });
        // resolveSettings exposes the raw cascade. Claude only honors picker
        // configuration from user, SDK/flag and managed sources, without merging.
        const trusted = sources?.filter(({ source, settings }) => (
            (source === 'user' || source === 'flag' || source === 'managed') && settings.modelPicker !== undefined
        ));
        const pickerSource = trusted?.filter(({ source }) => source === 'managed').at(-1) ?? trusted?.at(-1);
        return claudeModelsFromSettings({
            ...effective,
            modelPicker: sources ? pickerSource?.settings.modelPicker : effective.modelPicker,
        });
    } catch {
        logger.debug('[ClaudeModels] Could not resolve Claude Code model settings');
        return null;
    }
}
