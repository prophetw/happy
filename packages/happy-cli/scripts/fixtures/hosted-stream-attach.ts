// Fake authenticated session attachment only. ApiSession transport/encryption is real.
export const ApiClient = { create: async () => ({ attachSession: async (options: any) => {
    const metadata = { path: '/fixture', host: 'fixture', testloopDots: { dotId: globalThis.__fixtureDotId, workspaceId: 'fixture' } };
    options.validateMetadata(metadata);
    return { id: 'fixture-session', metadata, metadataVersion: 0, agentState: null, agentStateVersion: 0,
        encryptionKey: Buffer.alloc(32), encryptionVariant: 'dataKey' };
} }) };
