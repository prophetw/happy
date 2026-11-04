import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureProcesses } from './fixture-process.mjs';
import { fixtureManagedPair } from './paired-fixture.mjs';

for (const externalSignal of [false, true]) test(`stopping during the retry wait cannot resurrect a pair (${externalSignal ? 'signal' : 'explicit stop'})`, async () => {
    const processes = new FixtureProcesses();
    const calls = [];
    let enteredDelay;
    const waiting = new Promise(resolve => { enteredDelay = resolve; });
    const pair = fixtureManagedPair({
        dc: async args => { calls.push(args[0]); return {code: 1}; },
        stopPair: async () => { calls.push('stop'); },
        policy: {up: ['up'], maxStarts: 3},
        signal: processes.signal,
        delay: ms => { enteredDelay(); return processes.delay(ms); },
        restartDelayMs: 25,
    });
    await waiting;
    if (externalSignal) processes.stop();
    const result = await pair.stop();
    assert.equal(result.reason, 'stopped'); assert.equal(result.starts, 1);
    assert.equal(calls.filter(v => v === 'up').length, 1);
    assert.ok(calls.includes('stop'));
});
