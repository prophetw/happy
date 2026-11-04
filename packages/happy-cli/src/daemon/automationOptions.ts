import type { MachineMetadata } from '@/api/types';

/**
 * Launch option catalog for delegated (automation REST) sessions.
 *
 * The catalog is derived from the same machine metadata the app pickers use
 * (`codexModels` / `claudeModels`, refreshed by ApiMachineClient). The ambient
 * defaults are exactly what automation spawned before options existed, so an
 * old caller that sends no options gets an identical session.
 */
export type AutomationOption = { key: string; name: string; description?: string | null };
export type AutomationAgentCatalog = {
    agent: 'claude' | 'codex';
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
const CODEX_EFFORTS_FALLBACK = ['low', 'medium', 'high', 'xhigh'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function buildAutomationCatalog(metadata: MachineMetadata | null | undefined): AutomationAgentCatalog[] {
    const codexModels: AutomationOption[] = (metadata?.codexModels?.options ?? [])
        .map(m => ({ key: m.code, name: m.value, description: m.description ?? null }));
    // The pre-options automation launch pinned gpt-6.1-sol; keep it selectable
    // even before the first catalog refresh lands.
    if (!codexModels.some(m => m.key === 'gpt-6.1-sol')) codexModels.unshift({ key: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' });
    const codexEfforts = new Set<string>(CODEX_EFFORTS_FALLBACK);
    for (const m of metadata?.codexModels?.options ?? []) for (const level of m.thinkingLevels) codexEfforts.add(level);
    const claudeModels: AutomationOption[] = [
        { key: 'default', name: metadata?.claudeModels?.currentCode ?? 'Default model', description: 'Claude Code default' },
        ...(metadata?.claudeModels?.options ?? []).filter(m => m.code !== 'default')
            .map(m => ({ key: m.code, name: m.value, description: m.description ?? null })),
    ];
    return [
        { agent: 'codex', models: codexModels, permissionModes: CODEX_PERMISSION_MODES, efforts: [...codexEfforts],
            defaultModel: 'gpt-6.1-sol', defaultPermissionMode: 'default', defaultEffort: 'high' },
        { agent: 'claude', models: claudeModels, permissionModes: CLAUDE_PERMISSION_MODES, efforts: CLAUDE_EFFORTS,
            defaultModel: 'default', defaultPermissionMode: 'default', defaultEffort: '' },
    ];
}

export function automationDefaults(catalog: AutomationAgentCatalog[], agent: string) {
    const entry = catalog.find(c => c.agent === agent) ?? catalog[0];
    return { agent: entry.agent, model: entry.defaultModel, permissionMode: entry.defaultPermissionMode, effort: entry.defaultEffort };
}
