import { readProductionConfig } from './config';
import { startHost } from './host';

export async function productionMain(argv: string[], boot = startHost) {
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    let closing = false, shutdownRequested = false;
    const shutdown = () => {
        shutdownRequested = true;
        if (host && !closing) { closing = true; void host.app.close().catch(() => { process.exitCode = 1; }); }
    };
    // Compose and the supervisor may both signal the same container during pair shutdown.
    // Keep the handlers installed while app.close() is pending; a second signal must not
    // revert to Node's default termination and strand the durable gateway owner lock.
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
    try {
        if (argv.length !== 2 || argv[0] !== '--config') throw new Error('CONFIG_ARGUMENT_REQUIRED');
        const config = readProductionConfig(argv[1]);
        if (config.role !== 'host') throw new Error('HOST_CONFIG_REQUIRED');
        // A supervisor can signal after the durable owner is acquired but before listen resolves.
        host = await boot(config, event => { process.stdout.write(JSON.stringify({ event: 'audit', ...event }) + '\n'); });
        if (shutdownRequested) shutdown();
        return host;
    } catch (error) {
        process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
        throw error;
    }
}
