import * as React from 'react';
import { machineListDirectory, type DirectoryEntry } from '@/sync/ops';

/** Discard late replies when navigation changes the directory or computer. */
export function useMachineDirectory(machineId: string | null, path: string | null) {
    const [revision, setRevision] = React.useState(0);
    const [result, setResult] = React.useState<{
        machineId: string | null;
        path: string | null;
        directories: DirectoryEntry[];
        loading: boolean;
        error: string | null;
    }>({ machineId: null, path: null, directories: [], loading: false, error: null });

    React.useEffect(() => {
        if (!machineId || !path) return;
        let cancelled = false;
        setResult({ machineId, path, directories: [], loading: true, error: null });
        void machineListDirectory(machineId, path).then((response) => {
            if (cancelled) return;
            setResult({
                machineId,
                path,
                directories: response.success
                    ? (response.entries ?? []).filter((entry) => entry.type === 'directory')
                        .sort((a, b) => a.name.localeCompare(b.name))
                    : [],
                loading: false,
                error: response.success ? null : response.error ?? 'Failed to list directory',
            });
        });
        return () => { cancelled = true; };
    }, [machineId, path, revision]);

    const current = result.machineId === machineId && result.path === path;
    return {
        directories: current ? result.directories : [],
        loading: !!machineId && !!path && (!current || result.loading),
        error: current ? result.error : null,
        retry: React.useCallback(() => setRevision((value) => value + 1), []),
    };
}
