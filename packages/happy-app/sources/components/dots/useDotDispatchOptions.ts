import * as React from 'react';
import type { DotDispatchCatalog, DotDispatchConnection, ReadDotDispatchOptions } from '@/sync/dotsWorkspaceRead';
import type { DotDispatchTarget } from '@/sync/testloopDots';

type ReadResult<T> = { request: object; value: T | null };

/** A catalog only belongs to one open editor, request and target machine. */
export function useDotDispatchOptions(dotId: string | undefined, read: ReadDotDispatchOptions) {
    const [attempt, retry] = React.useReducer(value => value + 1, 0);
    const scope = React.useMemo(() => ({}), [dotId, read]);
    const directoryRequest = React.useMemo(() => ({}), [scope, attempt]);
    const [directory, setDirectory] = React.useState<ReadResult<DotDispatchConnection[]>>();
    const [selected, setSelected] = React.useState<{ scope: object; target: DotDispatchTarget }>();
    const targets = directory?.request === directoryRequest ? directory.value : undefined;
    const preferred = selected?.scope === scope ? selected.target : undefined;
    const connection = preferred
        ? targets?.find(item => item.connectionID === preferred.connectionID && item.machineID === preferred.machineID)
        : targets?.length === 1 ? targets[0] : undefined;

    React.useEffect(() => {
        if (!dotId) return;
        let current = true;
        const settle = (value: DotDispatchConnection[] | null) => {
            if (current) setDirectory({ request: directoryRequest, value });
        };
        void read(dotId).then(result => settle('targets' in result ? result.targets : null), () => settle(null));
        return () => { current = false; };
    }, [read, dotId, directoryRequest]);

    const connectionID = connection?.connectionID, machineID = connection?.machineID;
    const target = React.useMemo(() => connectionID && machineID ? { connectionID, machineID } : undefined, [connectionID, machineID]);
    const catalogRequest = React.useMemo(() => ({}), [directoryRequest, target]);
    const [options, setOptions] = React.useState<ReadResult<DotDispatchCatalog>>();
    const catalog = options?.request === catalogRequest ? options.value : undefined;
    React.useEffect(() => {
        if (!dotId || !target) return;
        let current = true;
        const settle = (value: DotDispatchCatalog | null) => {
            if (current) setOptions({ request: catalogRequest, value });
        };
        void read(dotId, target).then(result => settle('catalog' in result ? result.catalog : null), () => settle(null));
        return () => { current = false; };
    }, [read, dotId, target, catalogRequest]);

    return {
        targets, connection, target, catalog, retry,
        loading: targets === undefined || (target !== undefined && catalog === undefined),
        failed: targets === null || catalog === null,
        selectTarget: (id: string) => {
            const choice = targets?.find(item => item.connectionID === id);
            if (choice) setSelected({ scope, target: choice });
        },
    };
}
