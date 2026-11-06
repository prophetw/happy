import { proofHeaders, type ProofIdentity } from './auth';
import { ApiError } from './schema';

export interface ControlClient {
    request(method: string, route: string, body?: unknown, grantID?: string): Promise<any>;
}
type ClientOptions = { allowLoopback?: boolean; now?: () => number; timeoutMs?: number; fetch?: typeof fetch; signal?: AbortSignal };
function controlUrl(baseUrl: string, options: ClientOptions) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/happy-control/v1'
        || (url.protocol !== 'https:' && !(options.allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new ApiError('INVALID_CONTROL_URL');
    return url;
}
async function requestControl(url: URL, options: ClientOptions, method: string, route: string, body: unknown, headers: (path: string) => Promise<Record<string, string>> | Record<string, string>): Promise<any> {
    if (!/^\/[A-Za-z0-9_/?=&%-]*$/.test(route) || route.includes('..') || route.startsWith('//')) throw new ApiError('INVALID_ROUTE');
    const path = url.pathname + route;
    try {
        const response = await (options.fetch ?? fetch)(url.origin + path, {
            method, headers: { ...await headers(path), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 20000), ...(options.signal ? [options.signal] : [])]) as NonNullable<Parameters<typeof fetch>[1]>['signal'],
        });
        return await response.json();
    } catch { throw new ApiError('CONTROL_UNAVAILABLE_OR_UNKNOWN', 503); }
}

/** Fixed-origin connector. Private keys stay in the caller's secret provider, never tool arguments. */
export class ProofClient implements ControlClient {
    private url: URL;
    constructor(baseUrl: string, private identity: ProofIdentity, private kind: 'client' | 'worker', private options: ClientOptions = {}) {
        this.url = controlUrl(baseUrl, options);
    }
    async request(method: string, route: string, body?: unknown, grantID = ''): Promise<any> {
        return requestControl(this.url, this.options, method, route, body,
            path => proofHeaders(this.identity, this.kind, method, path, body, grantID, this.options.now?.()));
    }
}

/** Per-request bearer adapter. Authentication and every grant check remain at the fixed REST gateway. */
export class ServiceTokenClient implements ControlClient {
    private url: URL;
    constructor(baseUrl: string, private token: string, private options: ClientOptions = {}) {
        this.url = controlUrl(baseUrl, options);
        if (token.length > 256 || !/^hsvc1\./.test(token)) throw new ApiError('INVALID_SERVICE_TOKEN', 401);
    }
    async request(method: string, route: string, body?: unknown): Promise<any> {
        return requestControl(this.url, this.options, method, route, body, () => ({ authorization: `Bearer ${this.token}` }));
    }
}
