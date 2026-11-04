import { expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { ProofClient } from './client';
it('aborts an outstanding signed worker request on supervisor shutdown without retry or leaked errors', async () => {
    const controller = new AbortController(), pair = generateKeyPairSync('ed25519');let calls = 0;let observed: AbortSignal | undefined;
    const request = (async (_url: unknown, input: RequestInit) => { calls++; observed = input.signal as AbortSignal;
        return new Promise<Response>((_, reject) => { observed!.addEventListener('abort', () => reject(Error('fixture-private-error')), { once: true }); if (observed!.aborted) reject(Error('fixture-private-error')); });
    }) as typeof fetch;
    const client = new ProofClient('https://fixture.invalid/happy-control/v1', { id: 'fixture-worker', privateKey: pair.privateKey }, 'worker', { signal: controller.signal, fetch: request });
    const pending = client.request('POST', '/worker/poll', { protocol: 1 });
    await new Promise(r => setTimeout(r, 0));controller.abort();
    await expect(pending).rejects.toThrow('CONTROL_UNAVAILABLE_OR_UNKNOWN');expect(observed?.aborted).toBe(true);expect(calls).toBe(1);
});
