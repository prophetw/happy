import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lockGateway } from './gatewayLock';
const directories: string[] = [];
const directory = () => { const d = mkdtempSync(join(tmpdir(), 'gateway-lock-')); directories.push(d); return d; };
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
it('refuses concurrent owners and permits an orderly reopen', () => {
    const d = directory(), release = lockGateway(d);
    expect(() => lockGateway(d)).toThrow('GATEWAY_DIRECTORY_LOCKED'); release();
    expect(existsSync(join(d, '.gateway-owner'))).toBe(false); lockGateway(d)();
});
it('recovers after SIGKILL without removing durable authorization data', async () => {
    const d = directory(); writeFileSync(join(d, 'grants-evidence'), 'preserve');
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `import { lockGateway } from ${JSON.stringify(new URL('./gatewayLock.ts', import.meta.url).href)}; lockGateway(${JSON.stringify(d)}); process.stdout.write('locked'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw Error('child failed'); })]);
        expect(() => lockGateway(d)).toThrow('GATEWAY_DIRECTORY_LOCKED');
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        expect(existsSync(join(d, '.gateway-owner'))).toBe(true);
        lockGateway(d)(); expect(existsSync(join(d, 'grants-evidence'))).toBe(true);
    } finally { child.kill('SIGKILL'); }
});
it('does not automatically take over a marker from the previous locking protocol', () => {
    const d = directory(); writeFileSync(join(d, '.gateway-owner'), JSON.stringify({ instance: 'legacy', pid: 7 }), { mode: 0o600 });
    expect(() => lockGateway(d)).toThrow('GATEWAY_DIRECTORY_LOCKED');
});
