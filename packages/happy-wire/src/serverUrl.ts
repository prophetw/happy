/** The configured URL is an API base URL, including any proxy path prefix. */
export function normalizeServerUrl(value: string): string {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Server URL must use HTTP or HTTPS protocol');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error('Server URL must not include credentials, a query, or a fragment');
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Socket.IO treats the URL pathname as a namespace, not a transport prefix.
 * Connect to the root namespace and put the prefix in the transport path.
 */
export function getServerSocketEndpoint(value: string): { origin: string; path: string } {
    const url = new URL(normalizeServerUrl(value));
    const basePath = url.pathname.replace(/\/+$/, '');
    return { origin: url.origin, path: `${basePath}/v1/updates` };
}
