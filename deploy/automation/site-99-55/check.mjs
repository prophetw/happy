import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { pairedUnitPolicy } from './paired-contract.mjs';

export const siteDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(siteDirectory, '../../..');
const load = name => JSON.parse(readFileSync(join(siteDirectory, name), 'utf8'));
export function templates() { return { host: load('host.json.example'), worker: load('worker.json.example'), grant: load('grant-request.json.example') }; }

/** Inert local validation only: imports schemas, never starts a service or opens Happy auth files. */
export async function validatePublicConfig({ host, worker, grant }, now = Date.now()) {
    const { hostConfigSchema, workerConfigSchema } = await import(pathToFileURL(join(root, 'packages/happy-agent/dist/automation/production/index.mjs')).href);
    const h = hostConfigSchema.parse(host), w = workerConfigSchema.parse(worker);
    assert.equal(h.origin, 'https://szsp.suitbim.com.cn:7100');
    assert.deepEqual(h.additionalBrowserOrigins, ['http://localhost:8989']);
    assert.equal(h.relayURL, h.origin + '/home-relay');
    assert.equal(w.relayURL, h.relayURL);
    assert.equal(w.endpoint, h.origin + '/happy-control/v1');
    assert.equal(h.listen.host, '127.0.0.1'); assert.equal(h.listen.port, 9010);
    assert.equal(h.stateDirectory, '/var/lib/happy-control');
    assert.equal(h.mcp, undefined); assert.equal(h.secrets, undefined); // direct signed REST only
    assert.equal(h.clients.length, 1); assert.equal(h.workers.length, 1);
    assert.equal(JSON.stringify(h.workers[0]), JSON.stringify(w.registration));
    const r = w.registration;
    assert.equal(h.clients[0].userID, r.userID);
    for (const entry of [h.clients[0], r]) {
        assert.equal(entry.externalIdentity, undefined);
        assert.equal(createPublicKey(entry.publicKey).asymmetricKeyType, 'ed25519');
    }
    assert.ok(!JSON.stringify({ h, w, grant }).includes('REPLACE_'), 'UNRESOLVED_PUBLIC_PLACEHOLDER');
    assert.deepEqual(Object.keys(grant).sort(), ['expiresAt', 'machineID', 'methods', 'projectID', 'sessionIDs', 'workerID']);
    assert.equal(grant.workerID, r.id); assert.equal(grant.machineID, r.machineID);
    const project = r.projects.find(p => p.id === grant.projectID); assert.ok(project);
    assert.ok(Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > now && grant.expiresAt <= now + h.maxGrantMs, 'EXPLICIT_FINITE_EXPIRY_REQUIRED');
    assert.ok(Array.isArray(grant.methods) && grant.methods.length && new Set(grant.methods).size === grant.methods.length && grant.methods.every(m => r.methods.includes(m)), 'METHOD_SCOPE_DENIED');
    assert.ok(Array.isArray(grant.sessionIDs) && grant.sessionIDs.every(id => project.sessionIDs.includes(id)), 'SESSION_SCOPE_DENIED');
    assert.ok(!r.projects.some(p => p.directory === '/home/dev/code/agent-runtime-bridge'), 'BRIDGE_IS_NOT_THE_DEPLOYMENT_TEST_PROJECT');
    return { publicConfigConsistent: true, realIdentityVerified: false, realGrantCreated: false };
}

/** No daemon access: compose config only; no real .env, Docker credential store, cert or key is read. */
export function renderCompose() {
    const directory = mkdtempSync(join(tmpdir(), 'happy-compose-config-'));
    try {
        // Discover the already installed Compose executable, without opening Docker config.json.
        const plugin = [join(homedir(), '.docker/cli-plugins/docker-compose'), '/usr/libexec/docker/cli-plugins/docker-compose', '/usr/lib/docker/cli-plugins/docker-compose', '/usr/local/libexec/docker/cli-plugins/docker-compose', '/usr/local/lib/docker/cli-plugins/docker-compose'].find(existsSync);
        if (plugin) { mkdirSync(join(directory, 'cli-plugins')); symlinkSync(plugin, join(directory, 'cli-plugins/docker-compose')); }
        const digest = character => 'sha256:' + character.repeat(64);
        const output = execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', join(siteDirectory, 'compose.yaml.example'), '--profile', 'approved-deployment', 'config', '--format', 'json'], {
            cwd: directory, encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
            env: { PATH: process.env.PATH, DOCKER_CONFIG: directory,
                CONTROL_IMAGE: 'happy-control:fixture@' + digest('1'), CONTROL_NGINX_IMAGE: 'nginx:fixture@' + digest('2'),
                CONTROL_CONFIG_DIRECTORY: '/data/code/happy-control/config', CONTROL_STATE_DIRECTORY: '/data/code/happy-control/state', CONTROL_PKI_DIRECTORY: '/run/happy-control/pki' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return JSON.parse(output);
    } finally { rmSync(directory, { recursive: true, force: true }); }
}
export function validateCompose(compose) {
    assert.equal(compose.name, 'happy-control');
    assert.deepEqual(Object.keys(compose.services).sort(), ['control', 'gateway']);
    const { control, gateway } = compose.services;
    assert.equal(gateway.network_mode, 'service:control'); assert.equal(gateway.depends_on.control.condition, 'service_healthy');
    assert.equal(gateway.ports, undefined); assert.equal(control.ports.length, 1);
    const port = control.ports[0]; assert.equal(port.host_ip, '192.168.99.55'); assert.equal(port.published, '9011'); assert.equal(port.target, 9443);
    for (const service of [control, gateway]) {
        assert.equal(service.restart, 'no'); assert.equal(service.pull_policy, 'never');
        assert.equal(service.labels['com.happy.automation.managed-pair'], 'site-99-55-v1');
        assert.match(service.image, /@sha256:[a-f0-9]{64}$/);
        assert.deepEqual(service.profiles, ['approved-deployment']); assert.equal(service.user, '1000:1000');
        assert.equal(service.read_only, true); assert.deepEqual(service.cap_drop, ['ALL']); assert.ok(service.security_opt.includes('no-new-privileges:true'));
        assert.equal(service.privileged, undefined); assert.equal(service.container_name, undefined);
        assert.ok(!service.volumes.some(v => /docker\.sock|happy-relay|bim-engine|dify/.test(v.source)));
        assert.ok(service.volumes.every(v => v.type === 'bind' && v.bind.create_host_path !== true));
    }
    assert.deepEqual(control.environment, { NODE_ENV: 'production' });
    assert.equal(control.volumes.filter(v => !v.read_only).length, 1);
    assert.equal(control.volumes.find(v => !v.read_only).target, '/var/lib/happy-control');
    assert.ok(gateway.volumes.every(v => v.read_only));
    assert.deepEqual(gateway.volumes.filter(v => v.target.startsWith('/etc/happy-control/pki')).map(v => v.target).sort(), ['/etc/happy-control/pki/client-ca.crt', '/etc/happy-control/pki/server.crt', '/etc/happy-control/pki/server.key']);
    return true;
}
export function validateProxyContracts(text55, text57) {
    for (const text of [text55, text57]) {
        assert.match(text, /location \^~ \/happy-control\/v1\/\s*\{/);
        assert.doesNotMatch(text, /^\s*(rewrite|return\s+30\d|proxy_cache|proxy_store|include)\b/m);
        assert.match(text, /proxy_set_header Authorization \$http_authorization;/);
        assert.match(text, /proxy_request_buffering off;/); assert.match(text, /proxy_buffering off;/);
        assert.match(text, /access_log off;/); assert.match(text, /error_log stderr crit;/);
        assert.doesNotMatch(text, /location[^\n]*(?:\/happy\/|\/home-relay\/|\/happy-control\/mcp)/);
    }
    assert.match(text55, /proxy_pass http:\/\/127\.0\.0\.1:9010;/);
    assert.match(text55, /ssl_verify_client on;/); assert.match(text55, /ssl_client_certificate \/etc\/happy-control\/pki\/client-ca\.crt;/);
    assert.match(text55, /allow 192\.168\.99\.57;\s*deny all;/);
    for (const name of ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']) assert.match(text55, new RegExp(name + '_temp_path /tmp/'));
    assert.match(text55, /listen 9443 ssl;/); assert.doesNotMatch(text55, /listen[^;]*9010/);
    assert.match(text57, /proxy_pass https:\/\/192\.168\.99\.55:9011;/);
    assert.match(text57, /proxy_ssl_verify on;/); assert.match(text57, /proxy_ssl_name happy-control-55\.internal;/);
    assert.match(text57, /proxy_ssl_certificate_key \/etc\/nginx\/happy-control-pki\/client\.key;/);
    return true;
}
export async function checkTemplates() {
    const values = templates();
    assert.ok(JSON.stringify(values).includes('REPLACE_')); assert.equal(values.grant.expiresAt, 0);
    assert.equal(JSON.stringify(values.host.workers[0]), JSON.stringify(values.worker.registration));
    assert.equal(values.host.clients[0].userID, values.worker.registration.userID);
    assert.equal(values.grant.workerID, values.worker.registration.id);
    assert.equal(values.grant.machineID, values.worker.registration.machineID);
    assert.equal(values.grant.projectID, values.worker.registration.projects[0].id);
    assert.deepEqual(values.grant.methods, values.worker.registration.methods);
    assert.deepEqual(values.grant.sessionIDs, []); assert.deepEqual(values.worker.registration.projects[0].sessionIDs, []);
    validateCompose(renderCompose());
    pairedUnitPolicy(readFileSync(join(siteDirectory, 'happy-control-pair.service.example'), 'utf8'));
    validateProxyContracts(readFileSync(join(siteDirectory, 'nginx-55.conf.example'), 'utf8'), readFileSync(join(siteDirectory, 'nginx-57.location.conf.example'), 'utf8'));
    return { templatesValid: true, deploymentReady: false, validation: 'compose-render-and-local-contracts',
        missing: ['approved digest-pinned images', 'approved user/machine/public keys/project/expiry', 'TLS credentials and mounts', 'private file permissions', 'worker update window', 'real REST caller credential hosting', 'live deployment acceptance (not checked by this command)'],
        serverContacted: false, secretsRead: false, realGrantCreated: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        assert.deepEqual(process.argv.slice(2), ['--templates']);
        process.stdout.write(JSON.stringify(await checkTemplates()) + '\n');
    } catch { process.stderr.write('Local site configuration check failed; no service was started.\n'); process.exitCode = 1; }
}
