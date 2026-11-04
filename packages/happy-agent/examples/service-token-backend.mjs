/** Minimal backend client. The application injects a secret provider; no token literals/config files/logging. */
export function serviceBackend({ endpoint, getToken, fetchImpl = fetch }) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.pathname !== '/happy-control/v1' || url.username || url.password || url.search || url.hash) throw Error('INVALID_CONTROL_URL');
    return async function call(method, route, body) {
        const notSent = code => ({ version: 1, ok: false, error: { code, retryable: false }, dispatch: 'not_sent' });
        if (!['GET', 'POST'].includes(method) || typeof route !== 'string' || !/^\/[A-Za-z0-9_/?=&%-]*$/.test(route) || route.startsWith('//') || route.includes('..') || route.split('?')[0].includes('%')) return notSent('INVALID_ROUTE');
        const target = new URL(url.origin + url.pathname + route);
        if (target.origin !== url.origin || !target.pathname.startsWith(url.pathname + '/')) return notSent('INVALID_ROUTE');
        let token;
        try { token = await getToken(); } catch { return notSent('SERVICE_CREDENTIAL_UNAVAILABLE'); }
        if (typeof token !== 'string' || !/^hsvc1\.[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{43}$/.test(token)) return notSent('SERVICE_CREDENTIAL_UNAVAILABLE');
        try {
            const response = await fetchImpl(target.href, { method, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000),
                headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const result = await response.json();
            if (result?.version !== 1 || typeof result.ok !== 'boolean') throw Error();
            return result;
        } catch {
            // Never serialize raw fetch/HTTP errors. Do not retry mutations automatically.
            return { version: 1, ok: false, error: { code: 'CONTROL_UNAVAILABLE_OR_UNKNOWN', retryable: false },
                ...(method === 'POST' ? { data: { state: 'unknown', ...(typeof body?.requestID === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.requestID) ? { requestID: body.requestID } : {}) } } : {}) };
        }
    };
}
