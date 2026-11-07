const HTTP_URL_PATTERN = /^https?:\/\//i;

export function isHttpMarkdownLink(url: string): boolean {
    return HTTP_URL_PATTERN.test(url.trim());
}

/** Only Happy's canonical session route; never resolve arbitrary relative URLs. */
export function markdownSessionId(url: string): string | null {
    return /^\/session\/([A-Za-z0-9_-]+)$/.exec(url)?.[0] === url
        ? url.slice('/session/'.length)
        : null;
}
