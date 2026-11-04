import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, cpSync, rmSync, existsSync, symlinkSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import assert from 'node:assert/strict';
import { renderCompose, siteDirectory } from './check.mjs';
import { FixtureProcesses } from './fixture-process.mjs';
import { pairedUnitPolicy } from './paired-contract.mjs';
import { fixtureManagedPair } from './paired-fixture.mjs';

const root = resolve(siteDirectory, '../../..');
const runID = `happy-control-fixture-${randomUUID().slice(0, 8)}`;
const directory = mkdtempSync(join(tmpdir(), runID + '-'));
const label = `com.happy.automation.fixture=${runID}`;
const dockerDirectory = join(directory, 'docker-cli'); mkdirSync(dockerDirectory);
const plugin = [join(homedir(), '.docker/cli-plugins/docker-compose'), '/usr/libexec/docker/cli-plugins/docker-compose', '/usr/lib/docker/cli-plugins/docker-compose'].find(existsSync);
if (plugin) { mkdirSync(join(dockerDirectory, 'cli-plugins')); symlinkSync(plugin, join(dockerDirectory, 'cli-plugins/docker-compose')); }
const dockerEnv = { PATH: process.env.PATH, DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: dockerDirectory };
const created = [], checks = [];
let network, workerAbort, workerRun, rig, releaseSpawn, artifactImage, pair;
const processes = new FixtureProcesses();
const emit = (event, values = {}) => process.stdout.write(JSON.stringify({ event, ...values }) + '\n');
const check = (name, value) => { assert.ok(value, name); checks.push(name); emit('pass', { check: name }); };
async function command(executable, args, options = {}) {
    try { return await processes.run(executable, args, { ...options, cwd: options.cwd ?? root, env: executable === 'docker' ? { ...dockerEnv, ...options.env } : { PATH: process.env.PATH } }); }
    catch (error) { if (error.result && !processes.stopping) privateFile(join(directory, 'last-command.log'), error.result.output + error.result.error); throw error; }
}
const docker = (args, options) => command('docker', args, options);
const wait = (ms, cleanup = false) => processes.delay(ms, {cleanup});
async function until(fn, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { if (processes.stopping) throw Object.assign(Error('FIXTURE_STOPPED'), {code:'FIXTURE_STOPPED'}); try { const value = await fn(); if (value) return value; } catch {} await wait(250); } throw Error('FIXTURE_WAIT_TIMEOUT'); }
function privateFile(path, data) { writeFileSync(path, data, { mode: 0o600 }); chmodSync(path, 0o600); }
async function keyCertificate(name, ca, sans, client = false) {
    const key = join(directory, name + '.key'), csr = join(directory, name + '.csr'), cert = join(directory, name + '.crt');
    await command('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${name}`]);
    const ext = join(directory, name + '.ext'); privateFile(ext, `basicConstraints=CA:FALSE\nextendedKeyUsage=${client ? 'clientAuth' : 'serverAuth'}\nsubjectAltName=${sans}\n`);
    await command('openssl', ['x509', '-req', '-in', csr, '-CA', join(directory, ca + '.crt'), '-CAkey', join(directory, ca + '.key'), '-CAcreateserial', '-days', '1', '-extfile', ext, '-out', cert]);
    chmodSync(key, 0o400); return { key, cert };
}
function httpsCall(url, { method = 'GET', headers = {}, body, ca, cert, key, servername } = {}) {
    return new Promise((resolvePromise, reject) => {
        processes.check();
        const p = httpsRequest(url, { method, headers, ca, cert, key, servername, signal: processes.signal, timeout: 10000, rejectUnauthorized: true }, response => {
            const chunks = []; let size = 0;
            response.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) p.destroy(); else chunks.push(chunk); });
            response.on('end', () => resolvePromise({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
            response.on('error', reject);
        });
        p.on('timeout', () => p.destroy(Error('FIXTURE_HTTP_TIMEOUT'))); p.on('error', reject);
        if (body !== undefined) p.write(body); p.end();
    });
}
async function containerPort(id, port) { const r = await docker(['port', id, port + '/tcp']); const match = /^127\.0\.0\.1:(\d+)$/m.exec(r.output); assert.ok(match, 'LOOPBACK_PUBLICATION_REQUIRED'); return Number(match[1]); }
const runtime = ['--pull', 'never', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--pids-limit', '128', '--cpus', '0.5', '--label', label];
const mount = (source, target) => ['--mount', `type=bind,src=${source},dst=${target},readonly`];

async function main() {
    const args = process.argv.slice(2);
    const interruptSmoke = ['--interrupt-smoke','--interrupt-wait'].includes(args[0]);
    const interruptWait = args[0] === '--interrupt-wait';
    const reuse = args.length === 3 && args[1] === '--image' && /^sha256:[a-f0-9]{64}$/.test(args[2]);
    assert.ok(args[0] === '--local-only' && args.length === 1 || ['--local-only','--interrupt-smoke','--interrupt-wait'].includes(args[0]) && reuse, 'EXPLICIT_LOCAL_FIXTURE_MODE_REQUIRED');
    emit('fixture_started', { runID, mode: args[0].slice(2), realHappyAuth: false });
    assert.equal(process.getuid(), 1000, 'fixture matches production numeric uid');
    const node = JSON.parse((await docker(['image', 'inspect', 'node:22-bookworm-slim', '--format', '{{json .Id}}'])).output);
    const nginxRef = process.env.HAPPY_FIXTURE_NGINX_IMAGE ?? 'nginx:alpine';
    assert.ok(nginxRef === 'nginx:alpine' || /^sha256:[a-f0-9]{64}$/.test(nginxRef), 'EXPLICIT_CACHED_NGINX_REQUIRED');
    const nginx = JSON.parse((await docker(['image', 'inspect', nginxRef, '--format', '{{json .Id}}'])).output);
    emit('cached_images', { node, nginx, registryPull: false });
    const context = join(directory, 'context'); mkdirSync(context);
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) cpSync(join(root, name), join(context, name));
    for (const pkg of ['happy-agent', 'happy-wire']) {
        const source = join(root, 'packages', pkg), target = join(context, 'packages', pkg); mkdirSync(target, { recursive: true });
        for (const file of ['package.json', 'tsconfig.json']) cpSync(join(source, file), join(target, file));
        cpSync(join(source, 'src'), join(target, 'src'), { recursive: true });
        if (pkg === 'happy-agent') { mkdirSync(join(target, 'bin')); for (const file of ['happy-agent.mjs', 'happy-control.mjs', 'happy-control-call.mjs']) cpSync(join(source, 'bin', file), join(target, 'bin', file)); }
    }
    const buildPath = join(context, 'deploy/automation/site-99-55'); mkdirSync(buildPath, { recursive: true });
    for (const file of ['Dockerfile.control', 'Dockerfile.control.dockerignore', 'healthcheck.mjs']) cpSync(join(siteDirectory, file), join(buildPath, file));
    const tag = runID + ':local';
    const dockerfile = join(buildPath, 'Dockerfile.control');
    privateFile(dockerfile, readFileSync(dockerfile, 'utf8').replace('FROM ${CONTROL_NODE_IMAGE} AS build', 'FROM ${CONTROL_NODE_IMAGE} AS build\nLABEL com.happy.automation.fixture=' + runID));
    let image;
    if (reuse) {
        image = args[2];
        const labels = JSON.parse((await docker(['image', 'inspect', image, '--format', '{{json .Config.Labels}}'])).output);
        assert.ok(/^happy-control-fixture-/.test(labels?.['com.happy.automation.fixture'] ?? '') || /^[a-f0-9]{40}$/.test(labels?.['com.happy.automation.source-tree'] ?? ''), 'FIXTURE_OR_REVIEWED_SOURCE_IMAGE_REQUIRED');
    } else {
    emit('build_started', { base: node, packageRegistry: 'https://registry.npmmirror.com', cpuLimit: 1, memoryMiB: 2048 });
    // Legacy builder uses the cached image ID without registry resolution and supports per-RUN resource limits.
    // The explicitly staged context contains only the two source workspaces and public build inputs.
    await docker(['build', '--pull=false', '--force-rm', '--cpu-period', '100000', '--cpu-quota', '100000', '--memory', '2g', '--memory-swap', '2g', '--label', label, '--build-arg', `CONTROL_NODE_IMAGE=${node}`, '-f', join(buildPath, 'Dockerfile.control'), '-t', tag, context], { env: { DOCKER_BUILDKIT: '0' }, timeout: 900000 });
    image = JSON.parse((await docker(['image', 'inspect', tag, '--format', '{{json .Id}}'])).output);
    }
    artifactImage = image;
    emit('image_built', { image, tag: reuse ? 'reused-local-fixture' : tag });
    check('image-production-export-loads', (await docker(['run', '--rm', '--network', 'none', ...runtime, '--entrypoint', 'node', image, '--input-type=module', '-e', 'const p=await import("/app/packages/happy-agent/dist/automation/production/index.mjs");if(typeof p.startHost!=="function")process.exit(1)'])).code === 0);

    const nodeVersion = (await docker(['run', '--rm', '--network', 'none', ...runtime, '--entrypoint', 'node', image, '--version'])).output.trim();
    const nginxVersion = (await docker(['run', '--rm', '--network', 'none', ...runtime, '--entrypoint', 'nginx', nginx, '-v'])).error.trim();
    emit('runtime_versions', { nodeVersion, nginxVersion });

    for (const name of ['root-ca', 'wrong-ca']) {
        await command('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(directory, name + '.key'), '-out', join(directory, name + '.crt'), '-days', '1', '-subj', `/CN=Happy isolated ${name}`]); chmodSync(join(directory, name + '.key'), 0o400);
    }
    const inner = await keyCertificate('inner', 'root-ca', 'DNS:happy-control-55.internal');
    const outer = await keyCertificate('outer', 'root-ca', 'DNS:localhost,IP:127.0.0.1');
    const owner = await keyCertificate('owner', 'root-ca', 'DNS:fixture-owner');
    const client = await keyCertificate('proxy-client', 'root-ca', 'DNS:fixture-proxy', true);
    const wrongClient = await keyCertificate('wrong-client', 'wrong-ca', 'DNS:wrong-fixture', true);
    const caPath = join(directory, 'root-ca.crt'), wrongCAPath = join(directory, 'wrong-ca.crt'), ca = readFileSync(caPath);
    // Docker 29 suppresses published ports on --internal networks; use a dedicated bridge,
    // matching the site Compose topology, with every host publication pinned to 127.0.0.1.
    network = (await docker(['network', 'create', '--driver', 'bridge', '--label', label, runID])).output.trim();

    const ownerScript = join(directory, 'owner.mjs'); privateFile(ownerScript, `import{createServer}from'node:https';import{readFileSync}from'node:fs';createServer({key:readFileSync('/fixture/owner.key'),cert:readFileSync('/fixture/owner.crt')},(q,r)=>{r.setHeader('content-type','application/json');if(q.url==='/v1/account/profile'&&q.headers.authorization==='Bearer fixture-owner-A')r.end(JSON.stringify({id:'userA'}));else{r.statusCode=401;r.end('{}')}}).listen(8443,'0.0.0.0');`);
    const ownerName = runID + '-owner'; created.push(ownerName);
    await docker(['run', '-d', '--name', ownerName, '--network', network, '--network-alias', 'fixture-owner', ...runtime, '--label', 'com.docker.compose.project=' + runID + '-unrelated', '--label', 'com.docker.compose.service=control', '--label', 'com.happy.automation.managed-pair=site-99-55-v1', ...mount(ownerScript, '/fixture/owner.mjs'), ...mount(owner.key, '/fixture/owner.key'), ...mount(owner.cert, '/fixture/owner.crt'), '--entrypoint', 'node', node, '/fixture/owner.mjs']);

    const outerPath = join(directory, 'outer.conf');
    const wrapper = location => `worker_processes 1;pid /tmp/nginx.pid;error_log stderr crit;events{worker_connections 128;}http{access_log off;client_body_temp_path /tmp/client;proxy_temp_path /tmp/proxy;fastcgi_temp_path /tmp/fcgi;uwsgi_temp_path /tmp/uwsgi;scgi_temp_path /tmp/scgi;server{listen 8443 ssl;server_name localhost;ssl_certificate /fixture/outer.crt;ssl_certificate_key /fixture/outer.key;${location}\nlocation /{return 404;}}}`;
    privateFile(outerPath, wrapper('location /happy-control/v1/ { return 503; }'));
    const outerName = runID + '-outer'; created.push(outerName);
    await docker(['run', '-d', '--name', outerName, '--network', network, ...runtime, '--label', 'com.docker.compose.project=' + runID, '--label', 'com.docker.compose.service=unrelated-fixture', '--label', 'com.happy.automation.managed-pair=site-99-55-v1', '-p', '127.0.0.1::8443', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m,mode=0700,uid=1000,gid=1000', ...mount(outerPath, '/fixture/nginx.conf'), ...mount(outer.key, '/fixture/outer.key'), ...mount(outer.cert, '/fixture/outer.crt'), ...mount(caPath, '/etc/nginx/happy-control-pki/server-ca.crt'), ...mount(wrongCAPath, '/etc/nginx/happy-control-pki/wrong-ca.crt'), ...mount(client.cert, '/etc/nginx/happy-control-pki/client.crt'), ...mount(client.key, '/etc/nginx/happy-control-pki/client.key'), '--entrypoint', 'nginx', nginx, '-g', 'daemon off;', '-c', '/fixture/nginx.conf']);
    const outsidePort = await containerPort(outerName, 8443), outside = `https://localhost:${outsidePort}`;
    const outerIP = JSON.parse((await docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', outerName])).output)[runID].IPAddress;
    const configDir = join(directory, 'config'), state = join(directory, 'state'), pki = join(directory, 'pki');
    for (const p of [configDir, state, pki]) mkdirSync(p, { mode: 0o700 });
    cpSync(inner.cert, join(pki, 'server.crt')); cpSync(inner.key, join(pki, 'server.key')); cpSync(caPath, join(pki, 'client-ca.crt'));
    const template55 = readFileSync(join(siteDirectory, 'nginx-55.conf.example'), 'utf8');
    privateFile(join(configDir, 'nginx-55.conf'), template55.replace('allow 192.168.99.57;', `allow ${outerIP};`));
    const { fixtureRig } = await import('../../../packages/happy-agent/examples/rest-fixture.ts');
    const { ProofClient, HTTPWorkerRunner } = await import('../../../packages/happy-agent/src/automation/rest/index.ts');
    rig = await fixtureRig({ multipleProjects: true, directorySelection: true });
    privateFile(join(configDir, 'host.json'), JSON.stringify({ version: 1, role: 'host', listen: { host: '127.0.0.1', port: 9010 }, origin: 'https://localhost', relayURL: 'https://fixture-owner:8443', stateDirectory: '/var/lib/happy-control', clients: [rig.clientRegistration], workers: [rig.registration],
        serviceTokens: { maxGrantMs: 2592000000, clients: [{ id: 'fixture-service', userID: 'userA', name: 'Isolated backend fixture', generation: 'fixture_v1' }] } }));
    const badConfig = join(directory, 'invalid-host.json');
    const validHost = JSON.parse(readFileSync(join(configDir, 'host.json'), 'utf8'));
    privateFile(badConfig, JSON.stringify({ ...validHost, listen: { host: '0.0.0.0', port: 9010 } }));
    const rejected = await docker(['run', '--rm', '--network', 'none', ...runtime, ...mount(badConfig, '/etc/happy-control/host.json'), image], {allowFailure:true});
    check('image-invalid-config-fails-before-listen', rejected.code !== 0);
    const unsafeState = join(directory, 'unsafe-state'); mkdirSync(unsafeState, {mode:0o777}); chmodSync(unsafeState,0o777);
    const unsafe = await docker(['run', '--rm', '--network', 'none', ...runtime, ...mount(join(configDir,'host.json'), '/etc/happy-control/host.json'), '--mount', `type=bind,src=${unsafeState},dst=/var/lib/happy-control`, image], {allowFailure:true});
    check('image-unsafe-state-fails-closed', unsafe.code !== 0);
    const compose = renderCompose(); compose.name = runID;
    Object.assign(compose.services.control, { image, pull_policy: 'never', restart: 'no', cpus: 1, mem_limit: '512m', labels: { ...compose.services.control.labels, 'com.happy.automation.fixture': runID } });
    compose.services.control.environment.NODE_EXTRA_CA_CERTS = '/fixture/root-ca.crt';
    compose.services.control.ports[0].host_ip = '127.0.0.1'; compose.services.control.ports[0].published = '0';
    compose.services.control.volumes[0].source = join(configDir, 'host.json'); compose.services.control.volumes[1].source = state;
    compose.services.control.volumes.push({ type: 'bind', source: caPath, target: '/fixture/root-ca.crt', read_only: true, bind: { create_host_path: false } });
    Object.assign(compose.services.control.healthcheck, { interval: '1s', start_period: '1s' });
    Object.assign(compose.services.gateway, { image: nginx, pull_policy: 'never', restart: 'no', cpus: 0.5, mem_limit: '128m', labels: { ...compose.services.gateway.labels, 'com.happy.automation.fixture': runID } });
    for (const v of compose.services.gateway.volumes) v.source = v.target === '/etc/nginx/nginx.conf' ? join(configDir, 'nginx-55.conf') : join(pki, v.target.split('/').at(-1));
    compose.networks.control = { external: true, name: runID };
    const composePath = join(directory, 'compose.json'); privateFile(composePath, JSON.stringify(compose));
    const dc = (args, options = {}) => docker(['compose', '--env-file', '/dev/null', '-f', composePath, '--profile', 'approved-deployment', ...args], { timeout: 120000, ...options });
    const policy = pairedUnitPolicy(readFileSync(join(siteDirectory, 'happy-control-pair.service.example'), 'utf8'));
    // Execute the unit stop script with only the isolated project/config directory substituted.
    const stopPair = () => command('/bin/sh', ['-ec', policy.stopScript.replaceAll('/run/happy-control-docker-cli', dockerDirectory).replaceAll('project=happy-control', 'project=' + runID)], { cleanup: true });
    const startPair = () => fixtureManagedPair({ dc, stopPair, policy, delay: wait, signal: processes.signal, onEvent: emit });
    const pairIDs = async () => {
        const ids = {};
        for (const service of ['control', 'gateway']) {
            const id = (await dc(['ps', '-q', service])).output.trim();
            if (!id) return false;
            const running = (await docker(['inspect', '--format', '{{.State.Running}}', id])).output.trim();
            if (running !== 'true') return false;
            ids[service] = id;
        }
        return ids;
    };
    const pairStopped = async () => {
        for (const service of ['control', 'gateway']) {
            // Negative evidence must check BOTH members, including created/exited containers.
            const id = (await dc(['ps', '-a', '-q', service])).output.trim();
            if (id && (await docker(['inspect', '--format', '{{.State.Running}}', id])).output.trim() !== 'false') return false;
        }
        return true;
    };
    const waitPair = async previous => until(async () => {
        const ids = await pairIDs();
        return ids && (!previous || ids.control !== previous.control && ids.gateway !== previous.gateway) && ids;
    }, 60000);
    created.push(runID + '-control-1', runID + '-gateway-1');
    pair = startPair();
    let ids = await waitPair();
    const controlID = ids.control, gatewayID = ids.gateway;
    check('native-inner-nginx-syntax', (await docker(['exec', gatewayID, 'nginx', '-t', '-c', '/etc/nginx/nginx.conf'])).code === 0);
    // The site connects to a stable host IP. Only this temporary Docker fixture needs DNS refresh
    // after pair recreation; no test-driven reload should hide an entry recovery failure.
    const template57 = readFileSync(join(siteDirectory, 'nginx-57.location.conf.example'), 'utf8').replace('proxy_pass https://192.168.99.55:9011;', 'resolver 127.0.0.11 valid=1s ipv6=off;\n    set $fixture_upstream https://control:9443;\n    proxy_pass $fixture_upstream;');
    async function outerConfig(text) { privateFile(outerPath, wrapper(text)); await docker(['exec', outerName, 'nginx', '-t', '-c', '/fixture/nginx.conf']); await docker(['exec', outerName, 'nginx', '-s', 'reload', '-c', '/fixture/nginx.conf']); await wait(500); }
    await outerConfig(template57); check('native-outer-nginx-syntax', true);
    const fetchTLS = async (url, options = {}) => { const r = await httpsCall(url, { method: options.method, headers: options.headers, body: options.body, ca }); return new Response(r.body, { status: r.status, headers: r.headers }); };
    const controlClient = new ProofClient(outside + '/happy-control/v1', rig.clientIdentity, 'client', { fetch: fetchTLS });
    const workerClient = new ProofClient(outside + '/happy-control/v1', rig.workerIdentity, 'worker', { fetch: fetchTLS });
    const compatibility = async () => { const r = await httpsCall(outside + '/happy-control/v1/compatibility', { ca }); return r.status === 200; };
    check('two-native-nginx-hops-verified-tls-mtls', await until(compatibility));
    if (interruptSmoke) {
        emit('interrupt_smoke_started');
        const timer = setTimeout(() => process.kill(process.pid, 'SIGINT'), 250);
        try { if (interruptWait) await wait(5000); else await docker(['exec', ownerName, 'node', '-e', 'setInterval(()=>{},1000)']); } finally { clearTimeout(timer); }
        throw Error('INTERRUPTION_NOT_OBSERVED');
    }
    const insidePort = await containerPort(controlID, 9443), inside = `https://127.0.0.1:${insidePort}/happy-control/v1/compatibility`;
    check('missing-client-certificate-denied', (await httpsCall(inside, { ca, servername: 'happy-control-55.internal' })).status === 400);
    const wrong = await httpsCall(inside, { ca, servername: 'happy-control-55.internal', cert: readFileSync(wrongClient.cert), key: readFileSync(wrongClient.key) }).catch(e => ({ tlsCode: e.code }));
    check('untrusted-client-certificate-denied', wrong.status === 400 || ['EPROTO', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA'].includes(wrong.tlsCode));
    check('non-proxy-source-denied', (await httpsCall(inside, { ca, servername: 'happy-control-55.internal', cert: readFileSync(client.cert), key: readFileSync(client.key) })).status === 403);
    await outerConfig(template57.replace('proxy_ssl_name happy-control-55.internal;', 'proxy_ssl_name wrong-name.fixture;'));
    check('wrong-upstream-san-denied', (await httpsCall(outside + '/happy-control/v1/compatibility', { ca })).status === 502);
    await outerConfig(template57.replace('/server-ca.crt;', '/wrong-ca.crt;'));
    check('wrong-upstream-ca-denied', (await httpsCall(outside + '/happy-control/v1/compatibility', { ca })).status === 502);
    await outerConfig(template57); check('verified-tls-recovers', await until(compatibility));
    check('probes-not-public', (await httpsCall(outside + '/readyz', { ca })).status === 404);
    const ownerRequest = async (route, method = 'GET', body) => {
        const result = await httpsCall(outside + '/happy-control/v1' + route, { ca, method, headers: { origin: 'https://localhost', authorization: 'Bearer fixture-owner-A', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: result.status, ...JSON.parse(result.body) };
    };
    const waitForWorker = () => until(async () => {
        const value = await ownerRequest('/service-connections/options');
        return value.ok && value.data.workers.some(w => w.id === 'worker' && w.projectScopes === 1 && w.directoryScopes === 1);
    });
    const createGrant = async ttl => {
        const pending = await controlClient.request('POST', '/connections', { workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: [...rig.registration.methods], sessionIDs: [], expiresAt: Date.now() + ttl }); assert.equal(pending.ok, true);
        const consent = await ownerRequest(`/connections/${pending.data.id}/consent`);
        assert.equal((await ownerRequest(`/connections/${pending.data.id}/approve`, 'POST', { digest: consent.data.digest, challenge: consent.data.challenge })).ok, true); return pending.data.id;
    };
    const grant = await createGrant(300000);
    workerAbort = new AbortController(); const runner = new HTTPWorkerRunner(workerClient, rig.registration, rig.transport, join(directory, 'worker'));
    await runner.pollOnce(); workerRun = runner.run(workerAbort.signal, 250, () => {});
    check('signed-full-path-query-through-native-proxies', (await controlClient.request('GET', '/machines?limit=1', undefined, grant)).ok === true);
    const task = { requestID: 'native-task', machineID: 'machineA', projectID: 'projectA' };
    const [a, b] = await Promise.all([controlClient.request('POST', '/tasks', task, grant), controlClient.request('POST', '/tasks', task, grant)]);
    check('concurrent-create-idempotency', a.ok && b.ok && a.data.sessionID === b.data.sessionID && rig.spawnCount === 1);
    const sessionID = a.data.sessionID;
    check('mock-relay-submitted-ack-contract', (await controlClient.request('POST', `/sessions/${sessionID}/messages`, { requestID: 'native-send', text: 'fixture instruction' }, grant)).data.state === 'submitted');
    for (let n = 0; n < 20; n++) rig.complete(sessionID, 'turn' + n, 'completed', '汉'.repeat(16000));
    const logs = await controlClient.request('GET', `/sessions/${sessionID}/events?after_seq=0&limit=100`, undefined, grant);
    check('large-worker-result-and-cursor', logs.ok && logs.data.nextCursor === 61 && Buffer.byteLength(JSON.stringify(logs)) > 256 * 1024);
    const result = await controlClient.request('GET', `/sessions/${sessionID}/result?turnID=turn0&after_seq=0&limit=100`, undefined, grant);
    check('final-turn-attribution', result.ok && result.data.outcome === 'completed' && result.data.attribution === 'session_turn_only');
    const cancelled = await controlClient.request('POST', `/sessions/${sessionID}/cancel`, { requestID: 'native-cancel' }, grant);
    check('cancel-ack-does-not-claim-stopped', cancelled.data.state === 'cancel_requested' && cancelled.data.process === 'unknown');
    const namespace = async id => (await docker(['exec', id, 'readlink', '/proc/1/ns/net'])).output.trim();
    check('managed-initial-shared-namespace', await namespace(ids.control) === await namespace(ids.gateway));
    await docker(['restart', controlID]);
    ids = await waitPair(ids);
    check('managed-control-restart-recreates-both', pair.starts === 2 && await namespace(ids.control) === await namespace(ids.gateway));
    check('managed-control-restart-recovers-without-proxy-reload', await until(compatibility));
    await waitForWorker();
    check('persistent-grant-and-receipt-after-recreate', (await controlClient.request('GET', '/requests/native-task', undefined, grant)).data.sessionID === sessionID);
    check('repeat-after-recreate-does-not-spawn', (await controlClient.request('POST', '/tasks', task, grant)).data.sessionID === sessionID && rig.spawnCount === 1);
    releaseSpawn = rig.pauseSpawn();
    const inflight = controlClient.request('POST', '/tasks', { ...task, requestID: 'revoke-inflight' }, grant);
    await until(() => rig.spawnCount === 2); await ownerRequest(`/connections/${grant}`, 'DELETE'); releaseSpawn(); releaseSpawn = undefined;
    check('revoke-inflight-fails-closed', (await inflight).error.code === 'GRANT_REVOKED');
    check('reconnect-does-not-restore-revoked-grant', (await controlClient.request('GET', '/machines', undefined, grant)).error.code === 'GRANT_REVOKED');
    const expiry = await createGrant(1500); await wait(1600);
    check('expiry-fails-closed', (await controlClient.request('GET', '/machines', undefined, expiry)).error.code === 'GRANT_EXPIRED');
    await docker(['kill', '--signal', 'KILL', ids.gateway]);
    ids = await waitPair(ids);
    check('managed-gateway-crash-recreates-both', pair.starts === 3 && await namespace(ids.control) === await namespace(ids.gateway));
    check('managed-gateway-crash-recovers-without-proxy-reload', await until(compatibility));
    await waitForWorker();
    check('revocation-persists-through-managed-recovery', (await controlClient.request('GET', '/machines', undefined, grant)).error.code === 'GRANT_REVOKED');
    check('expiry-persists-through-managed-recovery', (await controlClient.request('GET', '/machines', undefined, expiry)).error.code === 'GRANT_EXPIRED');
    let stopped;
    renameSync(composePath, composePath + '.offline');
    try { stopped = await pair.stop(); } finally { renameSync(composePath + '.offline', composePath); }
    check('missing-compose-config-still-stops-both', await pairStopped());
    const neighbourStates = await Promise.all([ownerName, outerName].map(async name => (await docker(['inspect', '--format', '{{.State.Running}}', name])).output.trim()));
    check('stop-label-scope-spares-unrelated-fixtures', neighbourStates.every(value => value === 'true'));
    await wait(750);
    check('explicit-managed-stop-does-not-restart', stopped.reason === 'stopped' && pair.starts === 3 && await pairStopped());

    // A hard control crash leaves the exclusive owner lock. Never remove it to force recovery.
    pair = startPair(); ids = await waitPair(); await until(compatibility); await waitForWorker();
    // Exercise the immutable production image's optional service-bearer path through BOTH native proxies.
    // Only synthetic owner/worker/relay identities are used; no Happy credential or real grant is read.
    const servicePending = await ownerRequest('/service-connections', 'POST', { clientID: 'fixture-service', workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: [...rig.registration.methods], sessionIDs: [], expiresAt: Date.now() + 2592000000 });
    check('image-service-30day-pending', servicePending.ok && servicePending.data.credentialMode === 'service-token-v1');
    const serviceID = servicePending.data.id, serviceConsent = await ownerRequest(`/connections/${serviceID}/consent`);
    check('image-service-old-approval-rejected', (await ownerRequest(`/connections/${serviceID}/approve`, 'POST', { digest: serviceConsent.data.digest, challenge: serviceConsent.data.challenge })).status === 426);
    check('image-service-explicit-approval', (await ownerRequest(`/connections/${serviceID}/approve`, 'POST', { digest: serviceConsent.data.digest, challenge: serviceConsent.data.challenge, credentialMode: 'service-token-v1' })).ok === true);
    const issued = await ownerRequest(`/connections/${serviceID}/service-token`, 'POST');
    check('image-service-one-time-delivery', issued.ok && typeof issued.data.token === 'string' && (await ownerRequest(`/connections/${serviceID}/service-token`, 'POST')).error.code === 'SERVICE_TOKEN_ALREADY_ISSUED');
    const serviceToken = issued.data.token;
    const serviceRequest = async (route, method = 'GET', body) => {
        const r = await httpsCall(outside + '/happy-control/v1' + route, { ca, method, headers: { authorization: 'Bearer ' + serviceToken, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, headers: r.headers, ...JSON.parse(r.body) };
    };
    const serviceMachines = await serviceRequest('/machines?limit=1');
    check('image-service-native-mtls-query-and-no-store', serviceMachines.ok && serviceMachines.headers['cache-control'] === 'no-store');
    check('image-service-not-worker-credential', (await serviceRequest('/worker/poll', 'POST', { protocol: 1 })).status === 401);
    check('image-service-scope-rejected', (await serviceRequest('/tasks', 'POST', { requestID: 'service-denied', machineID: 'other', projectID: 'projectA' })).error.code === 'SCOPE_DENIED');
    const serviceTask = { requestID: 'native-service-task', machineID: 'machineA', projectID: 'projectA' }, beforeServiceSpawns = rig.spawnCount;
    const serviceCreated = await serviceRequest('/tasks', 'POST', serviceTask), serviceSession = serviceCreated.data?.sessionID;
    check('image-service-create-idempotency', serviceCreated.data?.state === 'confirmed' && (await serviceRequest('/tasks', 'POST', serviceTask)).data?.sessionID === serviceSession && rig.spawnCount === beforeServiceSpawns + 1);
    check('image-service-send-persistent-ack', (await serviceRequest(`/sessions/${serviceSession}/messages`, 'POST', { requestID: 'native-service-send', text: 'fixture service instruction' })).data?.state === 'submitted');
    rig.complete(serviceSession, 'service_turn', 'completed', 'credential must be redacted: ' + serviceToken);
    const serviceResult = await serviceRequest(`/sessions/${serviceSession}/result?turnID=service_turn&after_seq=0&limit=2`);
    const serviceLast = await serviceRequest(`/sessions/${serviceSession}/result?turnID=service_turn&after_seq=${serviceResult.data?.nextCursor}&limit=2`);
    check('image-service-cursor-result-and-secret-redaction', serviceResult.ok && serviceLast.data?.ready && serviceLast.data.outcome === 'completed' && !JSON.stringify([serviceResult, serviceLast]).includes(serviceToken));
    const serviceCancel = await serviceRequest(`/sessions/${serviceSession}/cancel`, 'POST', { requestID: 'native-service-cancel' });
    rig.setProcess('stopped');
    check('image-service-cancel-ack-versus-stopped', serviceCancel.data?.state === 'cancel_requested' && serviceCancel.data.process === 'unknown' && (await serviceRequest('/requests/native-service-cancel')).data?.process === 'stopped');
    await docker(['restart', ids.control]); ids = await waitPair(ids); await until(compatibility); await waitForWorker();
    check('image-service-digest-and-receipt-survive-pair-recovery', (await serviceRequest('/requests/native-service-task')).data?.sessionID === serviceSession && (await ownerRequest(`/connections/${serviceID}/service-token`, 'POST')).error.code === 'SERVICE_TOKEN_ALREADY_ISSUED');
    await ownerRequest(`/connections/${serviceID}`, 'DELETE');
    check('image-service-revocation-persists', (await serviceRequest('/machines')).error.code === 'GRANT_REVOKED');
    const serviceRecords = (await import('node:fs')).readdirSync(join(state, 'state')).filter(n => n.endsWith('.json')).map(n => readFileSync(join(state, 'state', n), 'utf8')).join('\n');
    check('image-service-durable-state-holds-no-plaintext-token', !serviceRecords.includes(serviceToken));
    // Multi-project grant exercised against this exact image, through native HTTPS/mTLS proxies.
    const multiCompatibility = await httpsCall(outside + '/happy-control/v1/compatibility', { ca });
    check('image-multi-project-capability', JSON.parse(multiCompatibility.body).data?.projectScopes === 1);
    const multiPending = await ownerRequest('/service-connections', 'POST', { clientID: 'fixture-service', workerID: 'worker', machineID: 'machineA', scopeVersion: 2, projectIDs: ['projectB', 'projectA'], methods: [...rig.registration.methods], sessionIDs: [], expiresAt: Date.now() + 3600000 });
    check('image-multi-project-frozen-directories', multiPending.ok && multiPending.data.projects?.[0].directory === rig.project && multiPending.data.projects?.[1].directory === rig.projectB);
    const multiID = multiPending.data.id, multiConsent = await ownerRequest(`/connections/${multiID}/consent`);
    const multiApproval = { digest: multiConsent.data.digest, challenge: multiConsent.data.challenge, credentialMode: 'service-token-v1' };
    check('image-multi-project-old-page-fails-closed', (await ownerRequest(`/connections/${multiID}/approve`, 'POST', multiApproval)).status === 426);
    check('image-multi-project-explicit-full-approval', (await ownerRequest(`/connections/${multiID}/approve`, 'POST', { ...multiApproval, scopeVersion: 2 })).ok);
    const multiIssued = await ownerRequest(`/connections/${multiID}/service-token`, 'POST'), multiToken = multiIssued.data?.token;
    check('image-multi-project-one-time-token', multiIssued.ok && (await ownerRequest(`/connections/${multiID}/service-token`, 'POST')).error.code === 'SERVICE_TOKEN_ALREADY_ISSUED');
    const multiRequest = async (route, method = 'GET', body) => {
        const result = await httpsCall(outside + '/happy-control/v1' + route, { ca, method, headers: { authorization: 'Bearer ' + multiToken, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: result.status, ...JSON.parse(result.body) };
    };
    rig.setProcess('running');
    const multiA = await multiRequest('/tasks', 'POST', { requestID: 'multi-a', machineID: 'machineA', projectID: 'projectA' });
    const multiB = await multiRequest('/tasks', 'POST', { requestID: 'multi-b', machineID: 'machineA', projectID: 'projectB' });
    const multiSession = multiB.data?.sessionID, fixtureSessions = (await rig.transport.sessions()).sessions;
    check('image-multi-project-one-token-two-directories', multiA.data?.state === 'confirmed' && multiB.data?.state === 'confirmed' && fixtureSessions.find(s => s.id === multiA.data.sessionID)?.metadata.path === rig.project && fixtureSessions.find(s => s.id === multiSession)?.metadata.path === rig.projectB);
    check('image-multi-project-global-request-id-conflict', (await multiRequest('/tasks', 'POST', { requestID: 'multi-a', machineID: 'machineA', projectID: 'projectB' })).error.code === 'REQUEST_ID_CONFLICT');
    check('image-multi-project-unselected-directory-denied', (await multiRequest('/tasks', 'POST', { requestID: 'multi-c', machineID: 'machineA', projectID: 'projectC' })).error.code === 'SCOPE_DENIED');
    const multiSent = await multiRequest(`/sessions/${multiSession}/messages`, 'POST', { requestID: 'multi-send', text: 'fixture multi-project instruction' });
    rig.complete(multiSession, 'multi_turn');
    check('image-multi-project-message-and-turn-result', multiSent.data?.state === 'submitted' && (await multiRequest(`/sessions/${multiSession}/result?turnID=multi_turn`)).data?.outcome === 'completed');
    await docker(['restart', ids.control]); ids = await waitPair(ids); await until(compatibility); await waitForWorker();
    check('image-multi-project-receipt-survives-pair-recovery', (await multiRequest('/requests/multi-b')).data?.sessionID === multiSession);
    await ownerRequest(`/connections/${multiID}`, 'DELETE');
    check('image-multi-project-revocation-fails-closed', (await multiRequest('/machines')).error.code === 'GRANT_REVOKED');
    const multiRecords = (await import('node:fs')).readdirSync(join(state, 'state')).filter(n => n.endsWith('.json')).map(n => readFileSync(join(state, 'state', n), 'utf8')).join('\n');
    check('image-multi-project-no-plaintext-credential', !multiRecords.includes(multiToken));
    // Give this separate scenario its own bounded pair supervisor budget; retain the SAME current state.
    await pair.stop(); await pair.completed;
    pair = startPair(); ids = await waitPair(); await until(compatibility); await waitForWorker();
    // Owner-selected paths against this exact image; directory probing stays read-only and fixture-local.
    const selectedDirectory = join(rig.dir, 'selected-unregistered'); mkdirSync(selectedDirectory);
    const selected = await ownerRequest('/service-connections/resolve-directories', 'POST', { clientID: 'fixture-service', workerID: 'worker', machineID: 'machineA', directories: [rig.project, selectedDirectory] });
    check('image-directory-canonical-owner-resolution', selected.ok && selected.data.projects.some(p => p.directory === selectedDirectory) && selected.data.projects.length === 2);
    check('image-directory-root-itself-denied', (await ownerRequest('/service-connections/resolve-directories', 'POST', { clientID: 'fixture-service', workerID: 'worker', machineID: 'machineA', directories: [rig.dir] })).error.code === 'SCOPE_DENIED');
    const directoryBody = { clientID: 'fixture-service', workerID: 'worker', machineID: 'machineA', scopeVersion: 3, projectIDs: selected.data.projects.map(p => p.id), projects: selected.data.projects, selectionID: selected.data.selectionID, methods: [...rig.registration.methods], sessionIDs: [], expiresAt: Date.now() + 3600000 };
    const directoryPending = await ownerRequest('/service-connections', 'POST', directoryBody);
    check('image-directory-pending-and-one-use-selection', directoryPending.ok && (await ownerRequest('/service-connections', 'POST', directoryBody)).error.code === 'DIRECTORY_SELECTION_REPLAY');
    const directoryID = directoryPending.data.id, directoryConsent = await ownerRequest(`/connections/${directoryID}/consent`);
    const directoryApproval = { digest: directoryConsent.data.digest, challenge: directoryConsent.data.challenge, credentialMode: 'service-token-v1' };
    check('image-directory-old-page-rejected', (await ownerRequest(`/connections/${directoryID}/approve`, 'POST', { ...directoryApproval, scopeVersion: 2 })).status === 426);
    check('image-directory-explicit-v3-worker-recheck', (await ownerRequest(`/connections/${directoryID}/approve`, 'POST', { ...directoryApproval, scopeVersion: 3 })).ok);
    const directoryIssued = await ownerRequest(`/connections/${directoryID}/service-token`, 'POST'), directoryToken = directoryIssued.data?.token;
    check('image-directory-one-time-token', directoryIssued.ok && typeof directoryToken === 'string');
    const directoryRequest = async (route, method = 'GET', body, extraHeaders = {}) => {
        const r = await httpsCall(outside + '/happy-control/v1' + route, { ca, method, headers: { authorization: 'Bearer ' + directoryToken, ...extraHeaders, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, ...JSON.parse(r.body) };
    };
    const chosen = selected.data.projects.find(p => p.directory === selectedDirectory);
    const directoryTask = await directoryRequest('/tasks', 'POST', { requestID: 'directory-unregistered', machineID: 'machineA', projectID: chosen.id });
    check('image-directory-task-bound-to-canonical-path', directoryTask.data?.state === 'confirmed' && (await rig.transport.sessions()).sessions.find(s => s.id === directoryTask.data.sessionID)?.metadata.path === selectedDirectory);
    check('image-directory-unselected-project-denied', (await directoryRequest('/tasks', 'POST', { requestID: 'directory-denied', machineID: 'machineA', projectID: 'projectB' })).error.code === 'SCOPE_DENIED');
    check('image-directory-service-cannot-resolve-paths', (await directoryRequest('/service-connections/resolve-directories', 'POST', { clientID: 'fixture-service', workerID: 'worker', machineID: 'machineA', directories: [selectedDirectory] }, { origin: 'https://localhost' })).status === 401);
    await docker(['restart', ids.control]); ids = await waitPair(ids); await until(compatibility); await waitForWorker();
    check('image-directory-receipt-survives-pair-recovery', (await directoryRequest('/requests/directory-unregistered')).data?.sessionID === directoryTask.data.sessionID);
    await ownerRequest(`/connections/${directoryID}`, 'DELETE');
    check('image-directory-revocation-fails-closed', (await directoryRequest('/machines')).error.code === 'GRANT_REVOKED');
    check('image-directory-policy-does-not-mutate-project-registry', JSON.stringify(JSON.parse(readFileSync(join(configDir, 'host.json'), 'utf8')).workers[0].projects) === JSON.stringify(rig.registration.projects));
    const ownerLock = join(state, '.gateway-owner'), lockBefore = readFileSync(ownerLock, 'utf8');
    await docker(['kill', '--signal', 'KILL', ids.control]);
    const limited = await pair.completed;
    check('hard-crash-retries-are-bounded', limited.reason === 'restart-limit' && limited.starts === policy.maxStarts);
    check('hard-crash-preserves-owner-lock', readFileSync(ownerLock, 'utf8') === lockBefore);
    const unavailable = await httpsCall(outside + '/happy-control/v1/compatibility', { ca });
    const bothStopped = await pairStopped();
    emit('hard_crash_observation', { httpStatus: unavailable.status, bothStopped });
    check('hard-crash-fails-closed-at-public-entry', [502, 504].includes(unavailable.status) && bothStopped);
    emit('managed_recovery', { foregroundCompose: true, actualSystemdActivated: false, fixtureRestartDelayMs: 250, productionRestartDelayMs: policy.restartDelayMs, startLimit: policy.maxStarts, hardCrashLock: 'preserved-manual-recovery-required' });
    const files = (await import('node:fs')).readdirSync(join(state, 'state')).filter(n => n.endsWith('.json')).map(n => readFileSync(join(state, 'state', n), 'utf8')).join('\n');
    check('state-does-not-persist-private-keys-or-instruction', !files.includes('PRIVATE KEY') && !files.includes('fixture instruction') && !files.includes('Bearer fixture-owner'));
    processes.check();
    emit('completed', { passed: checks.length, image, nodeVersion, nginxVersion, realHappyAuth: false, productionDeployed: false });
}
let cleaning;
async function cleanup() {
    if (cleaning) return cleaning;
    cleaning = (async () => {
        const errors = [];
        releaseSpawn?.(); workerAbort?.abort();
        const bounded = async (name, fn) => { let timer; try { await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 15000); })]); } catch { errors.push(name); } finally { clearTimeout(timer); } };
        await bounded('worker-close', async () => { await workerRun; });
        await bounded('fixture-close', async () => { await rig?.close(); });
        await bounded('pair-stop', async () => { await pair?.stop(); });
        const teardown = (args) => docker(args, { cleanup: true, allowFailure: true });
        let containerCount = 'unknown', networkCount = 'unknown';
        // Labels cover resources whose daemon-side creation completed before the CLI returned an ID.
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const listed = await teardown(['ps', '-aq', '--filter', 'label=' + label]);
                if (listed.code !== 0) { errors.push('container-query'); break; }
                const ids = listed.output.split(/\s+/).filter(Boolean);
                if (ids.length) { const removed = await teardown(['rm', '-f', ...ids]); if (removed.code !== 0) errors.push('container-remove'); }
                const networks = await teardown(['network', 'ls', '-q', '--filter', 'label=' + label]);
                if (networks.code !== 0) { errors.push('network-query'); break; }
                const netIDs = networks.output.split(/\s+/).filter(Boolean);
                if (netIDs.length) { const removed = await teardown(['network', 'rm', ...netIDs]); if (removed.code !== 0) errors.push('network-remove'); }
                await wait(300, true);
            } catch { errors.push('docker-teardown'); }
        }
        try {
            const containers = await teardown(['ps', '-aq', '--filter', 'label=' + label]);
            if (containers.code === 0) containerCount = containers.output.split(/\s+/).filter(Boolean).length;
            const networks = await teardown(['network', 'ls', '-q', '--filter', 'label=' + label]);
            if (networks.code === 0) networkCount = networks.output.split(/\s+/).filter(Boolean).length;
        } catch { errors.push('final-query'); }
        let testKeysRemoved = false;
        try { rmSync(directory, { recursive: true, force: true }); testKeysRemoved = !existsSync(directory); } catch { errors.push('temporary-directory-remove'); }
        if (containerCount !== 0 || networkCount !== 0 || !testKeysRemoved || errors.length) process.exitCode = 1;
        emit('cleanup', { runID, remainingContainers: containerCount, remainingNetworks: networkCount, testKeysRemoved, errors, retainedLocalImage: artifactImage ?? null });
    })(); return cleaning;
}
// One finally owns teardown. The main path cannot launch more work after a stop.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { processes.stop(); workerAbort?.abort(); });
try { await main(); } catch (error) {
    emit(processes.stopping ? 'interrupted' : 'failed', { code: error.code ?? error.message, ...(error.code === 'ERR_ASSERTION' ? { assertion: error.message.slice(0, 300) } : {}), passed: checks.length, realHappyAuth: false });
    const sanitize = text => text.replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[omitted]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [omitted]').replace(/HappyProof\s+[^\s"']+/g, 'HappyProof [omitted]');
    if (!processes.stopping && existsSync(join(directory, 'last-command.log'))) emit('diagnostic', { tail: sanitize(readFileSync(join(directory, 'last-command.log'), 'utf8')).slice(-1800) });
    for (const name of processes.stopping ? [] : created) {
        const meta = await docker(['inspect', '--format', '{{json .State.Status}} {{json .NetworkSettings.Ports}}', name], { allowFailure: true });
        if (!meta.code) {
            emit('fixture_container', { name, metadata: meta.output.trim() });
            const logs = await docker(['logs', '--tail', '8', name], { allowFailure: true });
            if (logs.output || logs.error) emit('fixture_log', { name, tail: sanitize(logs.output + logs.error).slice(-1600) });
        }
    }
    process.exitCode = processes.stopping ? 130 : 1;
} finally { await cleanup(); if (processes.stopping && process.exitCode !== 1) process.exitCode = 130; }
