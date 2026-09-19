import type { Machine, MachineMetadata } from './storageTypes';

/**
 * The dsh model catalog a machine's daemon probed over a throwaway ACP
 * session and published as machine metadata (`dshModels`).
 *
 * dsh's option codes are opaque provider/model route strings, so the app can
 * only offer this list — never a hardcoded one. Sessions replace it with the
 * live catalog once their own config options arrive.
 */
export type DshModelCatalog = {
    options: Array<{ code: string; value: string; description?: string | null }>;
    /** The ambient model dsh runs without an override. */
    currentCode: string | null;
};

/** The catalog one machine published, or null when it probed none. */
export function getMachineDshModelCatalog(
    metadata: MachineMetadata | null | undefined,
): DshModelCatalog | null {
    const published = metadata?.dshModels;
    if (!published || !Array.isArray(published.options) || published.options.length === 0) {
        return null;
    }
    return {
        options: published.options,
        currentCode: published.currentCode ?? null,
    };
}

/**
 * What to call dsh's ambient "no override" default: the model dsh itself
 * runs right now when the catalog names one, and "Default model" otherwise.
 */
export function getDshModelCatalogDefaultName(catalog: DshModelCatalog | null): string {
    const currentName = catalog?.currentCode
        ? catalog.options.find((option) => option.code === catalog.currentCode)?.value
        : undefined;
    return currentName ?? 'Default model';
}

/**
 * The catalog to show when no particular machine is picked yet: the liveliest
 * machine that has one, so the agent-defaults screen and offline drafts can
 * still offer dsh's models rather than a lone "Default model" row.
 */
export function collectDshModelCatalog(machines: readonly Machine[]): DshModelCatalog | null {
    // Online first (their daemons can still be asked to run a session), then
    // most recently active — the same preference the machine pickers use.
    const sorted = [...machines].sort((left, right) => (
        Number(right.active) - Number(left.active)
        || (right.activeAt ?? 0) - (left.activeAt ?? 0)
    ));
    for (const machine of sorted) {
        const catalog = getMachineDshModelCatalog(machine.metadata);
        if (catalog) {
            return catalog;
        }
    }
    return null;
}
