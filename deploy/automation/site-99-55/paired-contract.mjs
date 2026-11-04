import assert from 'node:assert/strict';

/** The unit is authoritative; isolated fixtures execute its exact Compose action suffixes. */
export function pairedUnitPolicy(text) {
    const fields = key => [...text.matchAll(new RegExp('^' + key + '=(.*)$', 'gm'))].map(match => match[1]);
    const field = key => {
        const matches = fields(key);
        assert.equal(matches.length, 1, 'EXACT_UNIT_FIELD_REQUIRED:' + key); return matches[0];
    };
    const dockerPrefix = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', '--config', '/run/happy-control-docker-cli'];
    const args = field('ExecStart').split(/\s+/);
    assert.deepEqual(args.slice(0, 8), [...dockerPrefix, 'compose', '--project-name', 'happy-control']);
    assert.ok(args.includes('approved-deployment'));
    assert.equal(field('RuntimeDirectory'), 'happy-control-docker-cli'); assert.equal(field('RuntimeDirectoryMode'), '0700');
    assert.equal(field('WorkingDirectory'), '/');
    assert.equal(field('UnsetEnvironment'), 'DOCKER_CONTEXT DOCKER_HOST DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH');
    const pre = fields('ExecStartPre'); assert.equal(pre.length, 3);
    assert.deepEqual(pre.slice(0, 2), ['/usr/bin/install -d -m 0700 /run/happy-control-docker-cli/cli-plugins', '/usr/bin/ln -sfn /data/code/happy-control/release/tools/docker-compose /run/happy-control-docker-cli/cli-plugins/docker-compose']);
    assert.ok(pre[2].startsWith([...dockerPrefix, 'compose'].join(' ') + ' '));
    const index = args.indexOf('up'); assert.ok(index > 0);
    assert.equal(field('Type'), 'simple'); assert.equal(field('Restart'), 'always');
    assert.equal(field('SuccessExitStatus'), '130');
    assert.equal(field('RestartSec'), '10'); assert.equal(field('StartLimitIntervalSec'), '300'); assert.equal(field('StartLimitBurst'), '3');
    assert.equal(field('KillSignal'), 'SIGINT'); assert.equal(field('KillMode'), 'control-group');
    const up = args.slice(index);
    assert.deepEqual(up, ['up', '--force-recreate', '--abort-on-container-exit', '--no-build', '--pull', 'never', '--no-color', 'control', 'gateway']);
    assert.equal(field('ExecStopPost'), field('ExecStop'));
    const match = /^\/bin\/sh -ec '(.*)'$/.exec(field('ExecStop')); assert.ok(match);
    const stopScript = match[1].replaceAll('$$', '$');
    assert.ok(stopScript.startsWith('failed=0; for member in gateway control; do '));
    assert.ok(stopScript.endsWith('done; exit $failed'));
    assert.ok(stopScript.includes(dockerPrefix.join(' ') + ' ps -q --filter label=com.docker.compose.project=happy-control --filter label=com.docker.compose.service=$member --filter label=com.happy.automation.managed-pair=site-99-55-v1'));
    assert.ok(stopScript.includes(dockerPrefix.join(' ') + ' stop --time 25 $ids || failed=1'));
    assert.doesNotMatch(stopScript, /\bcompose\s|deploy\.env|compose\.yaml/);
    assert.doesNotMatch(text, /^Exec.*(?:\bdown\b|\bprune\b|\brm\b|gateway-owner|daemon\.state)/m);
    return { up, stopScript, maxStarts: 3, restartDelayMs: 10000, windowMs: 300000 };
}
