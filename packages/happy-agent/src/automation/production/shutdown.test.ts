import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function availablePort() {
    const server = createServer();
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(r => server.close(() => r()));
    return port;
}
describe('production signal shutdown', () => {
    it.each([false, true])('closes once with repeated signals (during startup: %s)', async duringStartup => {
        const directory = await mkdtemp(join(tmpdir(), 'happy-shutdown-fixture-'));
        const state = join(directory, 'state'); await mkdir(state, { mode: 0o700 });
        const config = join(directory, 'host.json');
        await writeFile(config, JSON.stringify({ version: 1, role: 'host', listen: { host: '127.0.0.1', port: await availablePort() }, origin: 'https://fixture.test', relayURL: 'https://fixture.test', stateDirectory: state, clients: [], workers: [] }), { mode: 0o600 });
        const script = `import{productionMain}from ${JSON.stringify(resolve('src/automation/production/main.ts'))};import{startHost}from ${JSON.stringify(resolve('src/automation/production/host.ts'))};await productionMain(['--config',${JSON.stringify(config)}],async(...args)=>{const host=await startHost(...args);const close=host.app.close.bind(host.app);host.app.close=async()=>{await new Promise(r=>setTimeout(r,250));await close();process.stdout.write('closed-once\\n')};${duringStartup ? "process.stdout.write('ready\\n');await new Promise(r=>setTimeout(r,250));" : ''}return host});${duringStartup ? '' : "process.stdout.write('ready\\n');"}`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; let error = '';
        const exited = new Promise<{ code: number | null; signal: string | null }>(r => child.once('exit', (code, signal) => r({ code, signal })));
        const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
        try {
            await new Promise<void>((r, reject) => {
                child.stdout.on('data', data => { output += data.toString(); if (output.includes('ready\n')) r(); });
                child.stderr.on('data', data => { error += data.toString(); });
                child.once('exit', () => { if (!output.includes('ready\n')) reject(Error('fixture startup failed: ' + error)); });
            });
            child.kill('SIGTERM');
            await new Promise(r => setTimeout(r, 60));
            child.kill('SIGTERM');
            const result = await exited;
            expect(result).toEqual({ code: 0, signal: null });
            expect(output.match(/closed-once/g)).toHaveLength(1);
            const { existsSync } = await import('node:fs');
            expect(existsSync(join(state, '.gateway-owner'))).toBe(false);
        } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; await rm(directory, { recursive: true, force: true }); }
    }, 12000);
});
