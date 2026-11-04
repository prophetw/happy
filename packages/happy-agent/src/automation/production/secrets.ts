import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { join } from 'node:path';
import { privateDirectory, privateRead } from '../rest/privateFs';
import { ApiError } from '../rest/schema';
import type { ProofIdentity } from '../rest/auth';

/** A vault/HSM adapter may implement this without exposing key bytes. No implicit env/file discovery. */
export interface SecretProvider {
    identity(ref: string, id: string, expectedPublicKey: string): Promise<ProofIdentity>;
    close(): Promise<void>;
}
export type EncryptedKeyReference = { encryptedPKCS8: string; passphraseCredential: string };
/** On-disk keys MUST be encrypted PKCS8; passphrases are service-manager credentials, not config/env values. */
export class EncryptedCredentialProvider implements SecretProvider {
    private closed = false;
    constructor(private references: Record<string, EncryptedKeyReference>, private credentialsDirectory: string) {}
    async identity(ref: string, id: string, expectedPublicKey: string): Promise<ProofIdentity> {
        let pem: Buffer | undefined, password: Buffer | undefined;
        try {
            if (this.closed || !Object.hasOwn(this.references, ref)) throw new Error();
            const r = this.references[ref];
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(r.passphraseCredential)) throw new Error();
            privateDirectory(this.credentialsDirectory);
            pem = privateRead(r.encryptedPKCS8, 32768);
            if (!pem.toString('ascii').startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')) throw new Error();
            password = privateRead(join(this.credentialsDirectory, r.passphraseCredential), 4096);
            if (!password.length) throw new Error();
            const key = createPrivateKey({ key: pem, format: 'pem', passphrase: password });
            const expected = createPublicKey(expectedPublicKey).export({ type: 'spki', format: 'der' });
            if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected)) throw new Error();
            return { id, sign: async bytes => { if (this.closed) throw new ApiError('SECRET_PROVIDER_CLOSED', 503); return sign(null, bytes, key); } };
        } catch { throw new ApiError('SECRET_PROVIDER_UNAVAILABLE', 503); }
        finally { pem?.fill(0); password?.fill(0); }
    }
    async close() { this.closed = true; }
}
