// Run after building happy-wire and happy-cli:
// pnpm exec tsx packages/happy-app/scripts/relay-custom-url.e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import nacl from 'tweetnacl';
import { io } from 'socket.io-client';
import { getServerSocketEndpoint } from '@slopus/happy-wire/serverUrl';
import { SessionClient } from '../../happy-agent/src/session.ts';
import { resumeSessionOnMachine, spawnSessionOnMachine } from '../../happy-agent/src/machineRpc.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const runId = `relay-custom-url-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const artifacts = path.join(repo, '.e2e-artifacts', runId);
const dataDir = await mkdtemp(path.join(tmpdir(), 'happy-relay-e2e-'));
await mkdir(artifacts, { recursive: true });
const children = [];
const sockets = [];
const failures = [];
const results = [];
let browser;
let page;
let proxyServer;
let proxy;
let agent;
let cliSession;
let machineClient;

async function waitFor(check, description, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out: ${description}`);
}
async function withTimeout(promise, description, timeoutMs = 10_000) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
        })]);
    } finally {
        clearTimeout(timer);
    }
}
async function allocatePort() {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function start(command, args, cwd, env, logName) {
    const log = await open(path.join(artifacts, logName), 'w');
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    children.push(child);
    await log.close();
    return child;
}
async function jsonRequest(url, token, body) {
    const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200, `${new URL(url).pathname} returned ${response.status}`);
    return response.json();
}
async function waitConnected(socket) {
    if (socket.connected) return;
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Socket connection timeout')), 10_000);
        socket.once('connect', () => { clearTimeout(timeout); resolve(); });
        socket.once('connect_error', error => { clearTimeout(timeout); reject(error); });
    });
}

try {
    const backendPort = await allocatePort();
    const proxyPort = await allocatePort();
    const webPort = await allocatePort();
    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const proxyOrigin = `http://127.0.0.1:${proxyPort}`;
    const baseUrl = `${proxyOrigin}/relay`;
    const webOrigin = `http://localhost:${webPort}`;
    const staticDir = path.join(dataDir, 'static');
    await mkdir(staticDir);
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Self-hosted Happy</title>');
    const env = {
        ...process.env, NODE_ENV: 'development', APP_ENV: 'development',
        DB_PROVIDER: 'pglite', DATA_DIR: dataDir, PGLITE_DIR: path.join(dataDir, 'pglite'),
        HANDY_MASTER_SECRET: randomBytes(32).toString('hex'),
        HOST: '127.0.0.1', PORT: String(backendPort), PUBLIC_URL: baseUrl,
        HAPPY_STATIC_DIR: staticDir, METRICS_ENABLED: 'false', REDIS_URL: '', S3_HOST: '',
        GITHUB_CLIENT_ID: '', GITHUB_APP_ID: '', EXPO_NO_TELEMETRY: '1',
        EXPO_PUBLIC_HARNESS_MODE: '', EXPO_PUBLIC_DEV_TOKEN: '', EXPO_PUBLIC_DEV_SECRET: '',
        EXPO_PUBLIC_LOG_SERVER_URL: '', EXPO_PUBLIC_HAPPY_SERVER_URL: backendOrigin,
        BROWSER: 'none', CI: '1',
    };
    const serverCwd = path.join(repo, 'packages/happy-server');
    console.log('Starting temporary Happy server and local prefix proxy...');
    const migration = await start(process.execPath, ['--import', 'tsx', 'sources/standalone.ts', 'migrate'], serverCwd, env, 'migrate.log');
    const [migrationCode] = await withTimeout(once(migration, 'exit'), 'temporary migrations', 60_000);
    assert.equal(migrationCode, 0, 'Temporary database migrations failed');
    await start(process.execPath, ['--import', 'tsx', 'sources/standalone.ts', 'serve'], serverCwd, env, 'server.log');
    await waitFor(async () => { try { return (await fetch(`${backendOrigin}/health`)).ok; } catch { return false; } }, 'Happy server health');

    const cliRequire = createRequire(new URL('../../happy-cli/package.json', import.meta.url));
    proxy = cliRequire('http-proxy').createProxyServer({ target: backendOrigin, ws: true, changeOrigin: true });
    proxy.on('error', error => failures.push(`Proxy: ${error.message}`));
    proxyServer = createServer((req, res) => {
        if (req.url === '/not-happy/health') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ service: 'other-service', status: 'ok' }));
            return;
        }
        if (!req.url.startsWith('/relay/')) { res.writeHead(404); res.end(); return; }
        req.url = req.url.slice('/relay'.length);
        proxy.web(req, res);
    });
    proxyServer.on('upgrade', (req, socket, head) => {
        if (!req.url.startsWith('/relay/')) { socket.destroy(); return; }
        req.url = req.url.slice('/relay'.length);
        proxy.ws(req, socket, head);
    });
    await new Promise(resolve => proxyServer.listen(proxyPort, '127.0.0.1', resolve));

    const secret = new Uint8Array(randomBytes(32));
    const keypair = nacl.sign.keyPair.fromSeed(secret);
    const challenge = new Uint8Array(randomBytes(32));
    const { token } = await jsonRequest(`${baseUrl}/v1/auth`, null, {
        publicKey: Buffer.from(keypair.publicKey).toString('base64'),
        challenge: Buffer.from(challenge).toString('base64'),
        signature: Buffer.from(nacl.sign.detached(challenge, keypair.secretKey)).toString('base64'),
    });
    for (const url of [backendOrigin, `${baseUrl}/`]) {
        const endpoint = getServerSocketEndpoint(url);
        const socket = io(endpoint.origin, { path: endpoint.path, transports: ['websocket'], reconnection: false, auth: { token } });
        sockets.push(socket);
        await waitConnected(socket);
        assert.equal(socket.nsp, '/');
        results.push(`${url === backendOrigin ? 'Root' : 'Prefixed'} authenticated Socket.IO connection`);
    }

    process.env.HAPPY_HOME_DIR = path.join(dataDir, 'cli');
    process.env.HAPPY_SERVER_URL = `${baseUrl}/`;
    const { ApiClient, configuration } = await import('../../happy-cli/dist/lib.mjs');
    assert.equal(configuration.serverUrl, baseUrl);
    const api = await ApiClient.create({ token, encryption: { type: 'legacy', secret } });
    const session = await api.getOrCreateSession({
        tag: randomUUID(), metadata: { path: dataDir, host: 'relay-fixture', flavor: 'claude' },
        state: { controlledByUser: false, requests: {} },
    });
    assert.ok(session);
    cliSession = api.sessionSyncClient(session);
    const message = new Promise(resolve => cliSession.onUserMessage(resolve));
    agent = new SessionClient({ sessionId: session.id, encryptionKey: secret, encryptionVariant: 'legacy', token, serverUrl: baseUrl });
    await withTimeout(once(agent, 'connected'), 'happy-agent session connection');
    agent.sendMessage('relay prefix regression');
    const received = await withTimeout(message, 'CLI receiving the agent message');
    assert.equal(received.content.text, 'relay prefix regression');
    results.push('Built CLI session and happy-agent exchange an encrypted message through the prefix');
    const reconnected = once(agent, 'connected');
    agent.socket.io.engine.close();
    await withTimeout(reconnected, 'happy-agent reconnect');
    results.push('happy-agent reconnects through the same prefix after transport loss');

    const machine = await api.getOrCreateMachine({ machineId: randomUUID(), metadata: { host: 'relay-fixture', platform: process.platform } });
    machineClient = api.machineSyncClient(machine);
    // Verify RPC routing without launching an external coding provider.
    machineClient.setRPCHandlers({
        spawnSession: async () => ({ type: 'success', sessionId: session.id }),
        resumeSession: async () => ({ type: 'success', sessionId: session.id }),
        stopSession: () => true, requestShutdown: () => {},
    });
    machineClient.connect();
    await waitFor(() => machineClient.isReady(), 'machine RPC registration');
    const agentMachine = { id: machine.id, encryption: { key: secret, variant: 'legacy' } };
    const agentConfig = { serverUrl: baseUrl };
    assert.equal((await spawnSessionOnMachine(agentConfig, agentMachine, token, { directory: dataDir })).sessionId, session.id);
    assert.equal((await resumeSessionOnMachine(agentConfig, agentMachine, token, session.id)).sessionId, session.id);
    results.push('CLI machine connection and both happy-agent spawn/resume RPC paths');

    const blob = Buffer.from('encrypted attachment fixture');
    const upload = await jsonRequest(`${baseUrl}/v1/sessions/${session.id}/attachments/request-upload`, token, { filename: 'blob', size: blob.length });
    assert.ok(upload.uploadUrl.startsWith(`${baseUrl}/v1/`));
    const uploadResult = await fetch(upload.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: blob });
    assert.equal(uploadResult.status, 200);
    const download = await jsonRequest(`${baseUrl}/v1/sessions/${session.id}/attachments/request-download`, token, { ref: upload.ref });
    assert.ok(download.downloadUrl.startsWith(`${baseUrl}/v1/`));
    const downloaded = await fetch(download.downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), blob);
    results.push('Local attachment upload/download retains PUBLIC_URL prefix');

    console.log('Protocol checks passed; starting local Expo web app...');
    await start('pnpm', ['exec', 'expo', 'start', '--web', '--host', 'localhost', '--port', String(webPort)], path.join(repo, 'packages/happy-app'), env, 'web.log');
    await waitFor(async () => { try { return (await fetch(webOrigin)).ok; } catch { return false; } }, 'Expo web server', 60_000);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    await context.addInitScript(() => { window.__HAPPY_CONFIG__ = { disableAnalytics: true }; });
    page = await context.newPage();
    const webSockets = [];
    page.on('pageerror', error => failures.push(`Page: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') failures.push(`Console: ${message.text()}`); });
    page.on('response', response => {
        if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
    });
    page.on('requestfailed', request => {
        const error = request.failure()?.errorText;
        if (error !== 'net::ERR_ABORTED') failures.push(`Request: ${new URL(request.url()).pathname}: ${error}`);
    });
    page.on('websocket', socket => {
        const record = { pathname: new URL(socket.url()).pathname, connected: false };
        webSockets.push(record);
        socket.on('framereceived', frame => { if (String(frame.payload).startsWith('40{')) record.connected = true; });
    });
    await page.goto(webOrigin, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.getByRole('button', { name: /create (?:an )?account/i }).click({ timeout: 120_000 });
    await page.waitForFunction(() => Boolean(localStorage.getItem('auth_credentials')));
    await waitFor(() => webSockets.some(socket => socket.pathname === '/v1/updates/' && socket.connected), 'App root connection');
    await page.goto(`${webOrigin}/server`);
    await page.getByRole('textbox').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'server-settings.png') });
    const input = page.getByRole('textbox');
    await input.fill(`${proxyOrigin}/not-happy`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(/not a valid Happy server/i).waitFor();
    assert.equal(await page.evaluate(() => Boolean(localStorage.getItem('auth_credentials'))), true);
    await input.fill(`${baseUrl}/`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Cancel', { exact: true }).click();
    assert.equal(await page.evaluate(() => Boolean(localStorage.getItem('auth_credentials'))), true);
    results.push('App rejects another service and cancelling a switch retains the current login');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Continue', { exact: true }).click();
    await page.waitForFunction(() => !localStorage.getItem('auth_credentials'));
    await page.getByRole('textbox').waitFor();
    assert.equal(await page.getByRole('textbox').inputValue(), baseUrl);
    await page.screenshot({ path: path.join(artifacts, 'custom-server-saved.png') });
    await page.goto(webOrigin);
    await page.getByRole('button', { name: /create (?:an )?account/i }).click();
    await waitFor(() => webSockets.some(socket => socket.pathname === '/relay/v1/updates/' && socket.connected), 'App prefixed connection');
    await page.screenshot({ path: path.join(artifacts, 'custom-server-connected.png') });
    results.push('App saves a normalized custom URL, reloads, signs in and connects through /relay');

    await page.goto(`${webOrigin}/server`);
    await page.getByRole('button', { name: 'Reset to Default', exact: true }).click();
    await page.getByText('Reset', { exact: true }).click();
    await page.waitForFunction(() => !localStorage.getItem('auth_credentials'));
    await page.getByRole('textbox').waitFor();
    assert.equal(await page.getByRole('textbox').inputValue(), backendOrigin);
    results.push('Reset removes the override and restores the configured root server');
    assert.deepEqual(failures, [], 'Unexpected browser or proxy errors');
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'passed', results, failures, webSockets }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks: results.length, artifacts: path.relative(repo, artifacts), results }, null, 2));
} catch (error) {
    if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(artifacts, 'failure.png') });
        await writeFile(path.join(artifacts, 'failure-page.txt'), await page.locator('body').ariaSnapshot());
    }
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'failed', error: error.message, results, failures }, null, 2));
    console.error(`Relay E2E failed: ${error.message}. Artifacts: ${path.relative(repo, artifacts)}`);
    process.exitCode = 1;
} finally {
    await browser?.close();
    agent?.close();
    await cliSession?.close();
    machineClient?.shutdown();
    sockets.forEach(socket => socket.disconnect());
    proxy?.close();
    if (proxyServer) {
        proxyServer.closeAllConnections();
        await new Promise(resolve => proxyServer.close(resolve));
    }
    for (const child of children) {
        if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    }
    await Promise.all(children.filter(child => child.exitCode === null).map(child => Promise.race([
        once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5_000)),
    ])));
    await rm(dataDir, { recursive: true, force: true });
}
