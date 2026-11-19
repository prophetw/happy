import type { MachineMetadata } from '@/api/types';
import { AGY_EFFORTS } from '../agyStream/constants';

/**
 * Launch option catalog for delegated (automation REST) sessions.
 *
 * The catalog is derived from the same machine metadata the app pickers use
 * (`codexModels` / `claudeModels`, refreshed by ApiMachineClient). The Codex
 * defaults also apply when the caller cannot discover launch options.
 */
export type AutomationOption = { key: string; name: string; description?: string | null };
export type AutomationAgentCatalog = {
    agent: 'claude' | 'codex' | 'agy';
    models: AutomationOption[];
    permissionModes: AutomationOption[];
    /** Union of every listed model's efforts; per-model support is enforced by the agent itself. */
    efforts: string[];
    defaultModel: string;
    defaultPermissionMode: string;
    /** Empty string = no effort flag passed to the CLI. */
    defaultEffort: string;
};

export const AUTOMATION_DEFAULT_AGENT = 'codex' as const;
export const CODEX_AUTOMATION_DEFAULTS = {
    agent: AUTOMATION_DEFAULT_AGENT,
    model: 'gpt-6.2-sol',
    permissionMode: 'default',
    effort: 'max',
} as const;

const CODEX_PERMISSION_MODES: AutomationOption[] = [
    { key: 'auto', name: 'Auto', description: 'Codex reviews its own calls and asks when needed' },
    { key: 'safe-yolo', name: 'Workspace', description: 'Workspace sandbox without prompts' },
    { key: 'read-only', name: 'Read', description: 'Read-only' },
    { key: 'yolo', name: 'Yolo', description: 'No sandbox, no prompts' },
    { key: 'default', name: 'Default', description: 'Ask-first baseline (untrusted + workspace-write)' },
];
const CLAUDE_PERMISSION_MODES: AutomationOption[] = [
    { key: 'auto', name: 'Auto', description: 'Harness reviews its own calls and stops when it wants a human' },
    { key: 'acceptEdits', name: 'Edits', description: 'Accept file edits automatically' },
    { key: 'plan', name: 'Plan', description: 'Plan only' },
    { key: 'bypassPermissions', name: 'Yolo', description: 'Bypass all permission prompts' },
    { key: 'default', name: 'Default', description: 'No harness override' },
];
const CODEX_EFFORTS_FALLBACK = ['low', 'medium', 'high', 'xhigh', CODEX_AUTOMATION_DEFAULTS.effort];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function buildAutomationCatalog(metadata: MachineMetadata | null | undefined): AutomationAgentCatalog[] {
    const codexModels: AutomationOption[] = (metadata?.codexModels?.options ?? [])
        .map(m => ({ key: m.code, name: m.value, description: m.description ?? null }));
    // Keep the current and previous automation defaults available during catalog refresh.
    if (!codexModels.some(m => m.key === 'gpt-6.1-sol')) codexModels.unshift({ key: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' });
    if (!codexModels.some(m => m.key === CODEX_AUTOMATION_DEFAULTS.model))
        codexModels.unshift({ key: CODEX_AUTOMATION_DEFAULTS.model, name: 'GPT-6.2 Sol' });
    const codexEfforts = new Set<string>(CODEX_EFFORTS_FALLBACK);
    for (const m of metadata?.codexModels?.options ?? []) for (const level of m.thinkingLevels) codexEfforts.add(level);
    const claudeModels: AutomationOption[] = [
        { key: 'default', name: metadata?.claudeModels?.currentCode ?? 'Default model', description: 'Claude Code default' },
        ...(metadata?.claudeModels?.options ?? []).filter(m => m.code !== 'default')
            .map(m => ({ key: m.code, name: m.value, description: m.description ?? null })),
    ];
    const agents: AutomationAgentCatalog[] = [
        { agent: 'codex', models: codexModels, permissionModes: CODEX_PERMISSION_MODES, efforts: [...codexEfforts],
            defaultModel: CODEX_AUTOMATION_DEFAULTS.model, defaultPermissionMode: CODEX_AUTOMATION_DEFAULTS.permissionMode,
            defaultEffort: CODEX_AUTOMATION_DEFAULTS.effort },
        { agent: 'claude', models: claudeModels, permissionModes: CLAUDE_PERMISSION_MODES, efforts: CLAUDE_EFFORTS,
            defaultModel: 'default', defaultPermissionMode: 'default', defaultEffort: '' },
    ];
    if (metadata?.agyModels) agents.push({ agent: 'agy',
        models: [{ key: 'default', name: metadata.agyModels.currentCode ?? 'Default model' },
            ...metadata.agyModels.options.filter(m => m.code !== 'default')
                .map(m => ({ key: m.code, name: m.value, description: m.description ?? null }))],
        permissionModes: [{ key: 'default', name: 'Default' }, { key: 'bypassPermissions', name: 'Yolo' }],
        efforts: [...AGY_EFFORTS], defaultModel: 'default', defaultPermissionMode: 'default', defaultEffort: '',
    });
    return agents.filter(entry => metadata?.cliAvailability?.[entry.agent] !== false);
}

export function automationDefaults(catalog: AutomationAgentCatalog[], agent: string) {
    const entry = catalog.find(c => c.agent === agent) ?? catalog[0];
    return { agent: entry.agent, model: entry.defaultModel, permissionMode: entry.defaultPermissionMode, effort: entry.defaultEffort };
}
