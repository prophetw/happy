import { z } from 'zod';
import { ProofClient } from '../rest/client';
import { callControlTool, toolContracts } from '../rest/mcp';
import { ApiError } from '../rest/schema';
import { callerConfigSchema, readProductionConfig, type CallerConfig } from './config';
import { EncryptedCredentialProvider, type SecretProvider } from './secrets';

const requestSchema = z.object({ tool: z.string().min(1).max(64), input: z.unknown() }).strict();
type Dependencies = { provider?: SecretProvider; fetch?: typeof fetch };
const failure = (code: string) => ({ version: 1, ok: false, error: { code, retryable: false } });

/** Reuses the fixed REST mappings. One call, one credential lifetime, no listener or retries. */
export async function executeControlCall(config: CallerConfig, request: unknown, deps: Dependencies = {}) {
    let provider: SecretProvider | undefined;
    let mutationRequestID: unknown;
    let mutationStarted = false;
    try {
        const cfg = callerConfigSchema.parse(config), value = requestSchema.parse(request);
        const enrollment = value.tool === 'happy_request_connection';
        if (!enrollment && !Object.hasOwn(toolContracts, value.tool)) return failure('UNKNOWN_CONTROL_OPERATION');
        if (enrollment && !cfg.connectionScope) return failure('CONTROL_CONNECTION_SCOPE_REQUIRED');
        if (!enrollment && !cfg.grantID) return failure('CONTROL_OWNER_APPROVAL_REQUIRED');
        const name = value.tool as keyof typeof toolContracts;
        const args = (enrollment ? z.object({}).strict() : toolContracts[name].schema).parse(value.input) as Record<string, unknown>;
        provider = deps.provider ?? new EncryptedCredentialProvider(cfg.secrets.keys, cfg.secrets.credentialsDirectory);
        const identity = await provider.identity(cfg.identityRef, cfg.registration.id, cfg.registration.publicKey);
        const client = new ProofClient(cfg.endpoint, identity, 'client', { fetch: deps.fetch });
        mutationStarted = enrollment || toolContracts[name].method === 'POST';
        if (mutationStarted) mutationRequestID = args.requestID;
        const uncertain = () => ({ ...failure('CONTROL_UNAVAILABLE_OR_UNKNOWN'),
            ...(mutationStarted ? { data: { state: 'unknown', ...(mutationRequestID ? { requestID: mutationRequestID } : {}) } } : {}) });
        try {
            const result = enrollment ? await client.request('POST', '/connections', cfg.connectionScope)
                : await callControlTool(client, cfg.grantID!, name, args);
            // A lost/malformed mutation reply cannot prove the operation was not dispatched.
            if (!result || result.version !== 1 || typeof result.ok !== 'boolean') return uncertain();
            return result;
        } catch { return uncertain(); }
    } catch (error) {
        if (error instanceof z.ZodError) return failure('CONTROL_INPUT_OR_CONFIG_INVALID');
        // Provider and filesystem diagnostics must never become assistant-visible output.
        return failure('CONTROL_CREDENTIAL_UNAVAILABLE');
    } finally {
        try { await provider?.close(); }
        catch { return { ...failure('CONTROL_CREDENTIAL_CLEANUP_FAILED'),
            ...(mutationStarted ? { data: { state: 'unknown', ...(mutationRequestID ? { requestID: mutationRequestID } : {}) } } : {}) }; }
    }
}

export async function restCallerMain(argv: string[], request: unknown, deps: Dependencies = {}) {
    if (argv.length !== 2 || argv[0] !== '--config') return failure('CONTROL_CONFIG_ARGUMENT_REQUIRED');
    try {
        const config = readProductionConfig(argv[1]);
        if (config.role !== 'caller') return failure('CONTROL_CALLER_CONFIG_REQUIRED');
        return await executeControlCall(config, request, deps);
    } catch { return failure('CONTROL_INPUT_OR_CONFIG_INVALID'); }
}

/** Bound stdin before parsing; neither keys nor arbitrary endpoint/method arguments are accepted. */
export async function readControlRequest(stream: AsyncIterable<Uint8Array | string>) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stream) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 512 * 1024) throw new ApiError('CONTROL_INPUT_TOO_LARGE');
        chunks.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new ApiError('CONTROL_INPUT_INVALID'); }
}
