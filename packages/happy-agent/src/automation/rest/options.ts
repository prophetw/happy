/**
 * Owner-approved launch option allowlists and the option resolution contract.
 *
 * A delegated task may only use launch options the owner explicitly granted for
 * that worker/machine (or approved in the individual connection scope). Callers
 * can never raise permissions above the ambient defaults by supplying fields;
 * unknown or unlisted values fail closed with OPTION_DENIED.
 *
 * This module must not import from ./schema (schema imports this file).
 */
import { z } from 'zod';

export const launchAgents = ['claude', 'codex'] as const;
// Installed Claude provider model IDs may include a context window suffix such as [1M].
export const launchOptionValue = z.string().regex(/^[A-Za-z0-9_.:\[\]-]{1,128}$/);

const agentPolicyFields = {
    agent: z.enum(launchAgents),
    /** Explicitly allowed override values; empty list = no override for that field. */
    models: z.array(launchOptionValue).max(128).default([]),
    permissionModes: z.array(launchOptionValue).max(16).default([]),
} as const;
export const launchAgentPolicySchema = z.object(agentPolicyFields).strict();
export const launchOptionsPolicySchema = z.object({
    version: z.literal(1),
    agents: z.array(launchAgentPolicySchema).min(1).max(launchAgents.length)
        .refine(a => new Set(a.map(p => p.agent)).size === a.length),
}).strict();
export type LaunchOptionsPolicy = z.infer<typeof launchOptionsPolicySchema>;

/** Optional per-task overrides. Omitted fields always fall back to worker defaults. */
export const taskOptionsSchema = z.object({
    agent: z.enum(launchAgents).optional(),
    model: launchOptionValue.optional(),
    permissionMode: launchOptionValue.optional(),
    effort: launchOptionValue.optional(),
}).strict();
export type TaskOptions = z.infer<typeof taskOptionsSchema>;

/** Connection field (owner-approved) limiting what a grant may select. */
export const connectionOptionsSchema = z.object({
    agents: z.array(z.object(agentPolicyFields).strict()).min(1).max(launchAgents.length)
        .refine(a => new Set(a.map(p => p.agent)).size === a.length),
}).strict();
export type ConnectionOptions = z.infer<typeof connectionOptionsSchema>;

/** Per-agent catalog entry as enforced by the daemon that actually spawns. */
export type OptionCatalogEntry = {
    agent: string;
    models: string[];
    permissionModes: string[];
    /** Union of every listed model's efforts; per-model support is enforced by the agent CLI. */
    efforts: string[];
    defaultModel: string;
    defaultPermissionMode: string;
    /** Empty string = no effort flag passed to the CLI. */
    defaultEffort: string;
};

export class OptionsDenied extends Error {
    readonly code = 'OPTION_DENIED';
    constructor() { super('OPTION_DENIED'); }
}

/** Wire shape of the daemon's `options` RPC reply (keys only, no free text). */
export const optionCatalogEntrySchema = z.object({
    agent: launchOptionValue,
    models: z.array(launchOptionValue).max(256),
    permissionModes: z.array(launchOptionValue).max(32),
    efforts: z.array(launchOptionValue).max(32),
    defaultModel: launchOptionValue,
    defaultPermissionMode: launchOptionValue,
    defaultEffort: z.union([launchOptionValue, z.literal('')]),
}).strict();
export const optionCatalogSchema = z.object({
    version: z.literal(1), defaultAgent: launchOptionValue,
    agents: z.array(optionCatalogEntrySchema).max(8),
}).strict();
export type OptionCatalog = z.infer<typeof optionCatalogSchema>;

/**
 * Discovery view: only the options this grant can actually select. Ambient
 * defaults stay listed; legacy workers without an allowlist expose defaults
 * only (empty selectable lists), matching their fixed-launch behaviour.
 */
export function filterCatalogForGrant(catalog: OptionCatalog, workerPolicy: LaunchOptionsPolicy | undefined,
    grantOptions: ConnectionOptions | undefined): { defaultAgent: string; agents: OptionCatalogEntry[] } {
    if (!workerPolicy) {
        return { defaultAgent: catalog.defaultAgent, agents: catalog.agents.filter(a => a.agent === catalog.defaultAgent)
            .map(a => ({ agent: a.agent, models: [], permissionModes: [], efforts: [],
                defaultModel: a.defaultModel, defaultPermissionMode: a.defaultPermissionMode, defaultEffort: a.defaultEffort })) };
    }
    const agents: OptionCatalogEntry[] = [];
    for (const entry of catalog.agents) {
        const workerAgent = workerPolicy.agents.find(a => a.agent === entry.agent);
        if (!workerAgent) continue;
        const grantAgent = grantOptions?.agents.find(a => a.agent === entry.agent);
        if (grantOptions && !grantAgent) continue;
        const narrow = (values: string[], workerList: string[], grantList: string[] | undefined, fallback: string) => {
            let result = values.filter(v => workerList.includes(v) || v === fallback);
            if (grantList) result = result.filter(v => grantList.includes(v) || v === fallback);
            return result;
        };
        agents.push({ agent: entry.agent,
            models: narrow(entry.models, workerAgent.models, grantAgent?.models, entry.defaultModel),
            permissionModes: narrow(entry.permissionModes, workerAgent.permissionModes, grantAgent?.permissionModes, entry.defaultPermissionMode),
            efforts: entry.efforts,
            defaultModel: entry.defaultModel, defaultPermissionMode: entry.defaultPermissionMode, defaultEffort: entry.defaultEffort });
    }
    return { defaultAgent: catalog.defaultAgent, agents };
}

export type ResolvedTaskOptions = { agent: string; model: string; permissionMode: string; effort: string };

/**
 * Resolve requested options against the worker allowlist and the grant's own
 * approved subset. The allowlists constrain *overrides*; the ambient defaults
 * (what the owner's automation already launches with no options) stay valid.
 */
export function resolveTaskOptions(requested: TaskOptions, workerPolicy: LaunchOptionsPolicy | undefined,
    grantOptions: ConnectionOptions | undefined, defaultAgent: string, catalog: OptionCatalogEntry[]): ResolvedTaskOptions {
    const entry = (agent: string) => {
        const found = catalog.find(c => c.agent === agent);
        if (!found) throw new OptionsDenied();
        return found;
    };
    const defaultsOf = (agent: string): ResolvedTaskOptions => {
        const c = entry(agent);
        return { agent: c.agent, model: c.defaultModel, permissionMode: c.defaultPermissionMode, effort: c.defaultEffort };
    };
    const agent = requested.agent ?? defaultAgent;
    const anyOverride = requested.agent !== undefined || requested.model !== undefined
        || requested.permissionMode !== undefined || requested.effort !== undefined;
    // Legacy workers without an allowlist keep the old fixed-launch behaviour.
    if (!workerPolicy) {
        if (anyOverride) throw new OptionsDenied();
        return defaultsOf(agent);
    }
    const workerAgent = workerPolicy.agents.find(a => a.agent === agent);
    if (!workerAgent) throw new OptionsDenied();
    const grantAgent = grantOptions?.agents.find(a => a.agent === agent);
    if (grantOptions && !grantAgent) throw new OptionsDenied();
    const c = entry(agent);
    const resolved: ResolvedTaskOptions = { agent,
        model: requested.model ?? c.defaultModel,
        permissionMode: requested.permissionMode ?? c.defaultPermissionMode,
        effort: requested.effort ?? c.defaultEffort };
    const check = (value: string, requestedValue: string | undefined, workerList: string[], grantList: string[] | undefined, catalogList: string[]) => {
        if (requestedValue === undefined) return; // Ambient default, see doc comment.
        if (!workerList.includes(value)) throw new OptionsDenied();
        if (grantList && !grantList.includes(value)) throw new OptionsDenied();
        // A live catalog rejects values the agent does not actually offer.
        if (catalogList.length && !catalogList.includes(value)) throw new OptionsDenied();
    };
    check(resolved.model, requested.model, workerAgent.models, grantAgent?.models, c.models);
    check(resolved.permissionMode, requested.permissionMode, workerAgent.permissionModes, grantAgent?.permissionModes, c.permissionModes);
    if (requested.effort !== undefined && c.efforts.length && !c.efforts.includes(resolved.effort)) throw new OptionsDenied();
    return resolved;
}

/** A connection may only narrow the worker's own allowlist. */
export function validateGrantOptions(requested: ConnectionOptions | undefined, workerPolicy: LaunchOptionsPolicy | undefined): boolean {
    if (!requested) return true;
    if (!workerPolicy) return false;
    return requested.agents.every(grantAgent => {
        const workerAgent = workerPolicy.agents.find(a => a.agent === grantAgent.agent);
        return !!workerAgent
            && grantAgent.models.every(m => workerAgent.models.includes(m))
            && grantAgent.permissionModes.every(p => workerAgent.permissionModes.includes(p));
    });
}
