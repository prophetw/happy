import { createLocalJWKSet, createRemoteJWKSet, customFetch, jwtVerify, type JSONWebKeySet } from 'jose';
import { ApiError, type ExternalIdentity } from '../rest/schema';

export type OAuthConfig = { issuer: string; jwksURL: string; resource: string; scope: string; tenantClaim: string; algorithms: ('RS256' | 'ES256' | 'EdDSA')[] };
export type TokenVerifier = (token: string) => Promise<ExternalIdentity>;
/** OAuth resource server only. The external AS owns PKCE, registration, consent and token lifecycle. */
export function oauthVerifier(config: OAuthConfig, fixtureKeys?: JSONWebKeySet): TokenVerifier {
    const urls = [config.issuer, config.jwksURL, config.resource].map(s => new URL(s));
    if (urls.some(u => u.protocol !== 'https:' || u.username || u.password || u.hash || u.search)) throw new ApiError('INVALID_OAUTH_CONFIG');
    if (new URL(config.jwksURL).origin !== new URL(config.issuer).origin) throw new ApiError('INVALID_OAUTH_CONFIG');
    const keys = fixtureKeys ? createLocalJWKSet(fixtureKeys) : createRemoteJWKSet(new URL(config.jwksURL), { timeoutDuration: 5000, cooldownDuration: 30000, [customFetch]: (url, init) => fetch(url, { ...init, redirect: 'error' } as NonNullable<Parameters<typeof fetch>[1]>) });
    return async token => {
        try {
            if (token.length > 16384) throw new Error();
            const { payload } = await jwtVerify(token, keys, { issuer: config.issuer, audience: config.resource,
                algorithms: config.algorithms, requiredClaims: ['exp', 'iat', 'sub'], maxTokenAge: '15m', clockTolerance: 0 });
            if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.exp <= payload.iat || payload.exp - payload.iat > 900) throw new Error();
            const client = payload.client_id ?? payload.azp, tenant = payload[config.tenantClaim];
            if (typeof payload.sub !== 'string' || !payload.sub || typeof tenant !== 'string' || !tenant
                || typeof client !== 'string' || !client || (payload.client_id && payload.azp && payload.client_id !== payload.azp)
                || typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(config.scope)) throw new Error();
            return { issuer: config.issuer, subject: payload.sub, tenant, oauthClientID: client };
        } catch { throw new ApiError('OAUTH_INVALID_TOKEN', 401); }
    };
}
