export interface AccountAccessPolicy {
    restricted: boolean;
    allows(accountId: string): boolean;
}

let configuredValue: string | undefined;
let policy: AccountAccessPolicy | undefined;

/** Unset preserves the hosted server; an explicitly empty list denies everyone. */
export function getAccountAccessPolicy(): AccountAccessPolicy {
    const value = process.env.HAPPY_ALLOWED_ACCOUNT_IDS;
    if (policy && configuredValue === value) return policy;

    const normalized = value?.trim();
    if (normalized === undefined || normalized === '*') {
        policy = { restricted: false, allows: () => true };
    } else {
        const ids = normalized === '' ? [] : normalized.split(',').map(id => id.trim());
        if (ids.some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) {
            throw new Error('HAPPY_ALLOWED_ACCOUNT_IDS must be comma-separated account IDs, empty to deny all, or * to allow all');
        }
        const allowedIds = new Set(ids);
        policy = { restricted: true, allows: accountId => allowedIds.has(accountId) };
    }
    configuredValue = value;
    return policy;
}

export class AccountAccessDeniedError extends Error {
    readonly statusCode = 403;

    constructor() {
        super('Account is not allowed on this relay');
        this.name = 'AccountAccessDeniedError';
    }
}
