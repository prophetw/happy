import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pairedUnitPolicy } from './paired-contract.mjs';

const unit = readFileSync(new URL('./happy-control-pair.service.example', import.meta.url), 'utf8');
test('unit owns both containers, includes successful exits, and bounds retries without deleting state', () => {
    const policy = pairedUnitPolicy(unit);
    assert.equal(policy.maxStarts, 3); assert.equal(policy.restartDelayMs, 10000);
    for (const [before, after] of [
        ['Restart=always', 'Restart=on-failure'],
        ['SuccessExitStatus=130', 'SuccessExitStatus=0'],
        ['--abort-on-container-exit ', ''],
        ['--force-recreate ', ''],
        ['--pull never', '--pull always'],
        ['StartLimitBurst=3', 'StartLimitBurst=0'],
        ['KillMode=control-group', 'KillMode=process'],
        ['for member in gateway control', 'for member in control'],
        ['project=happy-control', 'project=other-project'],
        ['unix:///var/run/docker.sock', 'tcp://unapproved:2375'],
        ['/data/code/happy-control/release/tools/docker-compose', '/root/.docker/cli-plugins/docker-compose'],
    ]) assert.throws(() => pairedUnitPolicy(unit.replace(before, after)));
    assert.throws(() => pairedUnitPolicy(unit + '\nExecStopPost=/bin/rm /var/lib/happy-control/.gateway-owner\n'));
});
