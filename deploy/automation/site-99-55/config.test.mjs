import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { templates, validatePublicConfig, renderCompose, validateCompose, validateProxyContracts, siteDirectory, checkTemplates } from './check.mjs';
import { probeReady } from './healthcheck.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
function fixtureConfig() {
    const values = templates();
    const key = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    values.host.clients[0].userID = 'fixture-user'; values.host.clients[0].publicKey = key();
    values.host.workers[0].userID = 'fixture-user'; values.host.workers[0].machineID = 'fixture-machine'; values.host.workers[0].publicKey = key();
    values.worker.registration = copy(values.host.workers[0]); values.worker.happyHomeDirectory = '/fixture-unused/happy';
    values.grant.machineID = 'fixture-machine'; values.grant.expiresAt = Date.now() + 60000;
    return values;
}
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('compose renders inertly, isolates services, publishes NGINX only, and cannot overlap old relay state', () => {
    const config = renderCompose(); assert.equal(validateCompose(config), true);
    for (const mutate of [
        c => { c.services.control.ports[0].host_ip = '0.0.0.0'; },
        c => { c.services.control.ports[0].target = 9010; },
        c => { c.services.gateway.network_mode = 'host'; },
        c => { c.services.control.volumes[1].source = '/data/code/happy-relay'; },
        c => { c.services.control.volumes[0].bind.create_host_path = true; },
        c => { c.services.control.environment.TOKEN = 'fixture-not-a-credential'; },
        c => { c.services.control.read_only = false; },
        c => { c.services.control.restart = 'on-failure:5'; },
        c => { c.services.gateway.restart = 'always'; },
        c => { delete c.services.gateway.labels['com.happy.automation.managed-pair']; },
        c => { c.services.gateway.volumes[1].target = '/etc/happy-control/pki'; },
    ]) { const bad = copy(config); mutate(bad); assert.throws(() => validateCompose(bad)); }
});
test('templates remain explicitly unready; no actual identities/grants/certificates are needed for validation', async () => {
    const value = await checkTemplates(); assert.equal(value.templatesValid, true); assert.equal(value.deploymentReady, false);
    assert.equal(value.secretsRead, false); assert.equal(value.realGrantCreated, false); assert.equal(value.serverContacted, false);
    await assert.rejects(validatePublicConfig(templates()));
});
test('public config schemas bind the same user/worker/machine and a finite dedicated-session scope', async () => {
    const value = await validatePublicConfig(fixtureConfig()); assert.equal(value.publicConfigConsistent, true); assert.equal(value.realIdentityVerified, false);
    for (const mutate of [
        c => { c.host.clients[0].userID = 'other-user'; },
        c => { c.worker.registration.machineID = 'other-machine'; },
        c => { c.grant.machineID = 'other-machine'; },
        c => { c.grant.workerID = 'other-worker'; },
        c => { c.grant.projectID = 'other-project'; },
        c => { c.grant.methods = ['shell']; },
        c => { c.grant.sessionIDs = ['existing-session']; },
        c => { c.grant.expiresAt = 0; },
        c => { c.grant.expiresAt = Date.now() + 7200000; },
        c => { c.host.listen.host = '0.0.0.0'; },
        c => { c.worker.token = 'fixture-not-a-credential'; },
        c => { c.host.workers[0].projects[0].directory = '/home/dev/code/agent-runtime-bridge'; c.worker.registration = copy(c.host.workers[0]); },
    ]) { const bad = fixtureConfig(); mutate(bad); await assert.rejects(validatePublicConfig(bad)); }
});
test('explicit service-token MCP candidate needs existing service tokens but no OAuth provider', async () => {
    const value = fixtureConfig();
    value.host.serviceTokens = { clients: [{ id: 'fixture-service', userID: 'fixture-user', name: 'Fixture Dot', generation: 'fixture_v1' }] };
    value.host.mcp = { mode: 'service-token-v1' };
    const result = await validatePublicConfig(value, Date.now(), true);
    assert.equal(result.publicConfigConsistent, true); assert.equal(result.realIdentityVerified, false);
    const missing = copy(value); delete missing.host.serviceTokens;
    await assert.rejects(validatePublicConfig(missing, Date.now(), true));
});
test('both proxy contracts require mTLS/verified upstream, preserve signature input, and disable content spooling', () => {
    const a = readFileSync(join(siteDirectory, 'nginx-55.conf.example'), 'utf8'), b = readFileSync(join(siteDirectory, 'nginx-57.location.conf.example'), 'utf8');
    assert.equal(validateProxyContracts(a, b), true);
    for (const [x, y] of [
        [a.replace('ssl_verify_client on;', 'ssl_verify_client off;'), b],
        [a, b.replace('proxy_ssl_verify on;', 'proxy_ssl_verify off;')],
        [a.replace('127.0.0.1:9010;', '127.0.0.1:9010/;'), b],
        [a, b.replace('192.168.99.55:9011;', '192.168.99.55:9011/;')],
        [a, b.replace('location = /happy-control/mcp', 'location ^~ /happy-control/mcp')],
        [a.replace('location = /happy-control/mcp', 'location ^~ /happy-control/mcp'), b],
        [a, b.replace(/(location = \/happy-control\/mcp \{[\s\S]*?)proxy_set_header Authorization \$http_authorization;\n/, '$1')],
        [a, b + '\nrewrite ^ /v1/machines;\n'],
        [a.replace('proxy_request_buffering off;', 'proxy_request_buffering on;'), b],
    ]) assert.throws(() => validateProxyContracts(x, y));
});
test('readiness fails closed on unavailable, HTML, old protocol, oversized or unhealthy replies', async () => {
    const server = createServer((req, res) => {
        assert.equal(req.url, '/readyz'); assert.equal(req.headers.authorization, undefined);
        res.statusCode = status; res.end(body);
    });
    let status = 200, body = '';
    await listen(server); const port = server.address().port;
    try {
        for (const [code, value, expected] of [
            [200, { version: 1, ok: true, data: { ready: true, protocol: 1 } }, true],
            [503, { version: 1, ok: false }, false], [200, '<html>unrelated app</html>', false],
            [200, { version: 1, ok: true, data: { ready: true, protocol: 0 } }, false], [200, 'x'.repeat(2049), false],
        ]) { status = code; body = typeof value === 'string' ? value : JSON.stringify(value); assert.equal(await probeReady({ port }), expected); }
    } finally { await close(server); }
    assert.equal(await probeReady({ port, timeoutMs: 100 }), false);
});
test('two simulated proxy hops carry full path/query/POST signature to real fixture REST; rewriting fails', async () => {
    // Transport contract simulation, NOT a claim that native NGINX/mTLS/container integration was run.
    const { fixtureRig } = await import('../../../packages/happy-agent/examples/rest-fixture.ts');
    const { ProofClient } = await import('../../../packages/happy-agent/src/automation/rest/client.ts');
    const rig = await fixtureRig(); const proxies = [];
    let rewrite = false;
    const proxy = upstream => createServer((req, res) => {
        if (!req.url.startsWith('/happy-control/v1/')) { res.writeHead(404); res.end(); return; }
        const url = rewrite ? req.url.replace('limit=1', 'limit=2') : req.url;
        const call = request(upstream + url, { method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
        call.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(call);
    });
    try {
        const grant = await rig.connect(); await rig.startWorker();
        const inside = proxy(rig.address); proxies.push(inside); const insideUrl = await listen(inside);
        const outside = proxy(insideUrl); proxies.push(outside); const outsideUrl = await listen(outside);
        const client = new ProofClient(outsideUrl + '/happy-control/v1', rig.clientIdentity, 'client', { allowLoopback: true });
        assert.equal((await client.request('GET', '/machines?limit=1', undefined, grant)).ok, true);
        const created = await client.request('POST', '/tasks', { requestID: 'proxy-fixture-task', machineID: 'machineA', projectID: 'projectA' }, grant);
        assert.equal(created.data.state, 'confirmed'); assert.equal(rig.spawnCount, 1);
        assert.equal((await fetch(outsideUrl + '/readyz')).status, 404);
        rewrite = true; assert.equal((await client.request('GET', '/machines?limit=1', undefined, grant)).error.code, 'INVALID_PROOF');
    } finally { for (const p of proxies.reverse()) await close(p); await rig.close(); }
});
