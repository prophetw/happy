/** A retained screen loses ownership of an asynchronous navigation when focus or its binding changes. */
export function createTestloopDotsNavigationGuard() {
    let source: string | null = null;
    let generation = 0;
    return {
        update(sourceIdentity: string, active: boolean) {
            const next = active ? sourceIdentity : null;
            if (source !== next) { source = next; generation++; }
        },
        invalidate() { source = null; generation++; },
        begin() {
            if (source === null) return null;
            const originalSource = source, originalGeneration = ++generation;
            const isCurrent = () => source === originalSource && generation === originalGeneration;
            return {
                isCurrent,
                async afterReady(prepare: () => Promise<void>, open: () => void) {
                    if (!isCurrent()) return false;
                    await prepare();
                    if (!isCurrent()) return false;
                    open();
                    return true;
                },
            };
        },
    };
}
