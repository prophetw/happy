import { proofHeaders, type ProofIdentity } from './auth';
import { ApiError } from './schema';

/** Fixed-origin connector. Private keys stay in the caller's secret provider, never tool arguments. */
export class ProofClient {
    private url: URL;
    constructor(baseUrl: string, private identity: ProofIdentity, private kind: 'client' | 'worker', private options: { allowLoopback?: boolean; now?: () => number; timeoutMs?: number; fetch?: typeof fetch; signal?: AbortSignal } = {}) {
        this.url = new URL(baseUrl);
        if (this.url.username || this.url.password || this.url.search || this.url.hash || this.url.pathname !== '/happy-control/v1'
            || (this.url.protocol !== 'https:' && !(options.allowLoopback && this.url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(this.url.hostname)))) throw new ApiError('INVALID_CONTROL_URL');
    }
    async request(method: string, route: string, body?: unknown, grantID = ''): Promise<any> {
        if (!/^\/[A-Za-z0-9_/?=&%-]*$/.test(route) || route.includes('..') || route.startsWith('//')) throw new ApiError('INVALID_ROUTE');
        const path = this.url.pathname + route;
        try {
            const response = await (this.options.fetch ?? fetch)(this.url.origin + path, {
                method, headers: { ...await proofHeaders(this.identity, this.kind, method, path, body, grantID, this.options.now?.()),
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? 20000), ...(this.options.signal ? [this.options.signal] : [])]) as NonNullable<Parameters<typeof fetch>[1]>['signal'],
            });
            const result = await response.json();
            return result;
        } catch { throw new ApiError('CONTROL_UNAVAILABLE_OR_UNKNOWN', 503); }
    }
}
