import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureProcesses } from './fixture-process.mjs';
const environment = { PATH: process.env.PATH };
test('nonzero and signal exits never become a successful command', async () => {
    const p = new FixtureProcesses();
    await assert.rejects(p.run(process.execPath, ['-e', 'process.exit(7)'], { env: environment }), e => e.code === 'COMMAND_EXIT_FAILED' && e.result.code === 7);
    await assert.rejects(p.run(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM")'], { env: environment }), e => e.code === 'COMMAND_SIGNAL' && e.result.signal === 'SIGTERM');
    assert.equal(p.active.size, 0);
});
test('timeout is rejected even when the child signal has no numeric exit code', async () => {
    const p = new FixtureProcesses();
    await assert.rejects(p.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: environment, timeout: 60 }), e => e.code === 'COMMAND_TIMEOUT');
    assert.equal(p.active.size, 0);
});
test('a stop aborts work, prevents subsequent launches, and still allows explicit teardown', async () => {
    const p = new FixtureProcesses();
    const work = p.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: environment });
    const rejected = assert.rejects(work, e => e.code === 'FIXTURE_STOPPED');
    await new Promise(resolve => setTimeout(resolve, 60)); p.stop(); p.stop(); await rejected;
    await assert.rejects(p.run(process.execPath, ['-e', 'process.exit(0)'], { env: environment }), e => e.code === 'FIXTURE_STOPPED');
    assert.equal(p.active.size, 0);
    assert.equal((await p.run(process.execPath, ['-e', 'process.exit(0)'], { env: environment, cleanup: true })).code, 0);
});

test('stop leaves already running teardown commands alive', async () => {
    const p = new FixtureProcesses();
    const cleanup = p.run(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),120)'], { env: environment, cleanup: true });
    p.stop(); assert.equal((await cleanup).code, 0); assert.equal(p.active.size, 0);
});

test('stop aborts non-process waits and remains visible at completion checkpoints', async () => {
    const p = new FixtureProcesses(); const waiting = p.delay(5000);
    const rejected = assert.rejects(waiting, e => e.code === 'FIXTURE_STOPPED');
    p.stop(); await rejected; assert.equal(p.signal.aborted, true);
    assert.throws(() => p.check(), e => e.code === 'FIXTURE_STOPPED');
    await p.delay(1, {cleanup:true});
});
