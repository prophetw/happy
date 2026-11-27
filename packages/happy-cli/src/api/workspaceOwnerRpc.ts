import { workspaceOwnerRpcRequestSchema } from '@slopus/happy-wire';

function localTarget(value: string | undefined): string | undefined {
    if (!value) return;
    try {
        const url = new URL(value);
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.href === url.origin + '/') {
            return url.origin;
        }
    } catch { /* Invalid local configuration leaves the bridge disabled. */ }
    return undefined;
}

export function createWorkspaceOwnerRpc(
    config: { url?: string; origin?: string },
    machineID: string,
    bearer: () => string,
) {
    const target = localTarget(config.url);
    const origin = localTarget(config.origin);
    if (!target || !origin) return;

    const failure = (status: number, code: string, dispatch = 'not_started') =>
        ({ status, body: { version: 1, ok: false, error: { code }, dispatch } });

    return async (input: unknown) => {
        const parsed = workspaceOwnerRpcRequestSchema.safeParse(input);
        if (!parsed.success) return failure(400, 'INVALID_REQUEST');
        const { route, body } = parsed.data;
        if ('machineID' in body && body.machineID !== machineID) return failure(403, 'WORKSPACE_SCOPE_DENIED');

        try {
            const response = await fetch(`${target}/api/workspace-owner/v1/${route}`, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(route === 'delivery' ? 155_000 : 24_000),
                headers: { Origin: origin, Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
        } catch {
            const mayMutate = route === 'write' || route === 'delivery' || route === 'reclaim';
            return failure(503, mayMutate ? 'WORKSPACE_RESULT_UNKNOWN' : 'WORKSPACE_MANAGER_UNAVAILABLE',
                mayMutate ? 'unknown' : 'not_started');
        }
    };
}
