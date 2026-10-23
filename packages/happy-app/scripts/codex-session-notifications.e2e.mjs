// With Expo web already running: pnpm exec node packages/happy-app/scripts/ios-session-notifications.e2e.mjs
// HAPPY_COMPLETION_WEB_ORIGIN defaults to http://127.0.0.1:8989.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { chromium } from 'playwright';
import { createEnvelope } from '@slopus/happy-wire';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const artifacts = path.join(repo, '.e2e-artifacts', `codex-session-notifications-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const temporary = await mkdtemp(path.join(tmpdir(), 'happy-completion-'));
await mkdir(artifacts, { recursive: true });
const webOrigin = process.env.HAPPY_COMPLETION_WEB_ORIGIN ?? 'http://127.0.0.1:8989';
const children = [];
const clients = [];
const failures = [];
const checks = [];
let browser;
let page;
let machineClient;
let heartbeat;

async function waitFor(check, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out: ${label}`);
}
async function start(args, env, name) {
    const log = await open(path.join(artifacts, name), 'w');
    const child = spawn(process.execPath, args, { cwd: path.join(repo, 'packages/happy-server'), env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    children.push(child);
    await log.close();
    return child;
}
function pass(label) { checks.push(label); console.log(`PASS: ${label}`); }

try {
    const allocator = createServer();
    await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
    const port = allocator.address().port;
    await new Promise(resolve => allocator.close(resolve));
    const serverUrl = `http://127.0.0.1:${port}`;
    const env = {
        ...process.env, NODE_ENV: 'development', DB_PROVIDER: 'pglite', DATA_DIR: temporary,
        PGLITE_DIR: path.join(temporary, 'pglite'), HANDY_MASTER_SECRET: randomBytes(32).toString('hex'),
        HOST: '127.0.0.1', PORT: String(port), PUBLIC_URL: serverUrl, REDIS_URL: '', S3_HOST: '',
        HAPPY_ALLOWED_ACCOUNT_IDS: '*', METRICS_ENABLED: 'false', GITHUB_CLIENT_ID: '', GITHUB_APP_ID: '',
    };
    console.log('Starting isolated completion fixture...');
    const migration = await start(['--import', 'tsx', 'sources/standalone.ts', 'migrate'], env, 'migrate.log');
    const [code] = await once(migration, 'exit');
    assert.equal(code, 0, 'Temporary database migration');
    await start(['--import', 'tsx', 'sources/standalone.ts', 'serve'], env, 'server.log');
    await waitFor(async () => { try { return (await fetch(`${serverUrl}/health`)).ok; } catch { return false; } }, 'temporary relay');

    const secret = new Uint8Array(randomBytes(32));
    const keypair = nacl.sign.keyPair.fromSeed(secret);
    const challenge = new Uint8Array(randomBytes(32));
    const auth = await fetch(`${serverUrl}/v1/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        publicKey: Buffer.from(keypair.publicKey).toString('base64'), challenge: Buffer.from(challenge).toString('base64'),
        signature: Buffer.from(nacl.sign.detached(challenge, keypair.secretKey)).toString('base64'),
    }) });
    assert.equal(auth.status, 200);
    const { token } = await auth.json();
    process.env.HAPPY_HOME_DIR = path.join(temporary, 'cli');
    process.env.HAPPY_SERVER_URL = serverUrl;
    const { ApiClient } = await import('../../happy-cli/dist/lib.mjs');
    const api = await ApiClient.create({ token, encryption: { type: 'legacy', secret } });
    const machine = await api.getOrCreateMachine({ machineId: randomUUID(), metadata: {
        host: 'completion-fixture', platform: process.platform, displayName: 'Web 验收电脑',
        homeDir: temporary, happyHomeDir: path.join(temporary, 'cli'),
    } });
    machineClient = api.machineSyncClient(machine);
    machineClient.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorMessage: 'Fixture only' }), stopSession: () => true, requestShutdown() {} });
    machineClient.connect();
    await waitFor(() => machineClient.isReady(), 'fixture machine');
    const sessions = [];
    for (const title of ['Codex 通知回归验证']) {
        const session = await api.getOrCreateSession({ tag: randomUUID(), metadata: {
            path: temporary, host: 'completion-fixture', machineId: machine.id, flavor: 'codex',
            summary: { text: title, updatedAt: Date.now() },
        }, state: { controlledByUser: false, requests: {} } });
        assert.ok(session);
        sessions.push(session);
        clients.push(api.sessionSyncClient(session));
    }
    await waitFor(() => clients.every(client => client.socket.connected), 'fixture sessions');
    const thinking = [false];
    const ping = () => clients.forEach((client, index) => client.keepAlive(thinking[index], 'remote'));
    ping();
    heartbeat = setInterval(ping, 2000);

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'zh-CN', colorScheme: 'dark' });
    await context.addInitScript(({ serverUrl, token, secret }) => {
        if (location.protocol === 'about:' || location.protocol === 'data:') return;
        window.__HAPPY_CONFIG__ = { serverUrl, disableAnalytics: true };
        localStorage.setItem('auth_credentials', JSON.stringify({ token, secret }));
        const prefix = 'mmkv.default' + String.fromCharCode(92, 92);
        localStorage.setItem(prefix + 'settings', JSON.stringify({ settings: { preferredLanguage: 'zh-Hans', sessionListGrouping: 'project' }, version: null }));
    }, { serverUrl, token, secret: Buffer.from(secret).toString('base64') });
    page = await context.newPage();
    page.on('pageerror', error => failures.push(`Page: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') failures.push(`Console: ${message.text()}`); });
    page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });
    page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') failures.push(`Request: ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`); });
    await page.goto(webOrigin, { waitUntil: 'domcontentloaded' });
    await page.getByText('Codex 通知回归验证', { exact: true }).first().waitFor({ timeout: 45_000 });

    const client = clients[0];
    const sessionId = sessions[0].id;
    const card = page.getByTestId(`session-completion-${sessionId}`);
    const summary = page.getByTestId('mobile-attention-summary');
    const banner = page.getByTestId('mobile-attention-banner');
    const attentionKey = `session-attention-v1:${sessionId}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    let turn;
    const emit = async ev => {
        client.sendSessionProtocolMessage(createEnvelope('agent', ev, { turn }));
        await client.flush();
    };
    const startTurn = async () => {
        turn = randomUUID();
        thinking[0] = true;
        await emit({ t: 'turn-start' });
        ping();
    };
    const finishTurn = async (status, errorCode) => {
        thinking[0] = false;
        await emit({ t: 'turn-end', status, ...(errorCode ? { errorCode } : {}) });
        ping();
    };
    const pushEvent = async (kind, errorCode) => {
        const response = await fetch(`${serverUrl}/v1/sessions/${sessionId}/push-event`, {
            method: 'POST', headers, body: JSON.stringify({
                kind, title: kind === 'failed' ? `Execution failed (${errorCode})` : "It's ready!",
                body: 'Codex 通知回归验证', data: { sessionId, provider: 'codex', ...(errorCode ? { errorCode } : {}) },
            }),
        });
        assert.equal(response.status, 200, 'push-event accepted');
        const outcome = await response.json();
        assert.equal(outcome.result, 'no_tokens', 'isolated account has no phone push token');
    };
    const readAttention = async () => {
        const response = await fetch(`${serverUrl}/v1/kv/${encodeURIComponent(attentionKey)}`, { headers });
        assert.equal(response.status, 200);
        const item = await response.json();
        return { ...item, record: JSON.parse(Buffer.from(item.value, 'base64').toString()) };
    };
    const showPreview = async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${webOrigin}/dev/session-notifications`, { waitUntil: 'domcontentloaded' });
        // This route renders the production mobile notification component on Web.
        await page.addStyleTag({ content: '[data-testid="session-completion-notifications"] { display: none !important; }' });
    };

    await startTurn();
    await page.getByText('运行中', { exact: true }).first().waitFor();
    thinking[0] = false;
    ping();
    await page.waitForTimeout(1800);
    assert.equal(await card.count(), 0);
    assert.equal(await page.getByText('已完成', { exact: true }).count(), 0);
    pass('Codex idle presence before its outcome never produces a success notification');

    await finishTurn('failed', 'serverOverloaded');
    await pushEvent('failed', 'serverOverloaded');
    await page.getByText('执行失败', { exact: true }).first().waitFor();
    assert.equal(await card.count(), 0);
    await page.screenshot({ path: path.join(artifacts, 'web-failed.png') });
    pass('Desktop Web shows the failed status and no successful completion card');
    const originalFailure = (await readAttention()).record;
    assert.equal(originalFailure.kind, 'failed');
    assert.equal(originalFailure.errorCode, 'serverOverloaded');

    await showPreview();
    await summary.waitFor();
    await summary.click();
    await page.getByTestId('mobile-attention-list').getByText('执行失败 (serverOverloaded)', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'model-capacity-error.png') });
    await page.getByRole('button', { name: '关闭提醒列表', exact: true }).last().click();
    pass('The shared mobile component displays the exact provider error type serverOverloaded');

    await startTurn();
    await waitFor(async () => !(await summary.count()), 'retry clears the previous failure');
    thinking[0] = false;
    ping();
    await page.waitForTimeout(1800);
    assert.equal(await summary.count(), 0);
    await finishTurn('completed');
    await banner.getByText('已完成', { exact: true }).waitFor();
    await pushEvent('done');
    assert.equal(await banner.getByText(/serverOverloaded|执行失败/).count(), 0);
    assert.match(await summary.getAttribute('aria-label'), /1 个已完成.*0 个待处理/);
    await page.screenshot({ path: path.join(artifacts, 'retry-success.png') });
    pass('A successful retry changes the banner to completed without retaining the old failure');
    await page.waitForTimeout(4000);
    assert.equal(await banner.count(), 0);
    assert.match(await summary.getAttribute('aria-label'), /1 个已完成.*0 个待处理/);
    assert.equal((await readAttention()).record.kind, 'done');
    pass('The success remains correct after heartbeats, durable event delivery and banner timeout');

    // Replay an older failure at a newer KV version, as a delayed device write.
    let staleWritten = false;
    for (let attempt = 0; attempt < 3 && !staleWritten; attempt++) {
        const current = await readAttention();
        const response = await fetch(`${serverUrl}/v1/kv`, { method: 'POST', headers, body: JSON.stringify({ mutations: [{
            key: attentionKey, version: current.version, value: Buffer.from(JSON.stringify({ ...originalFailure, read: false })).toString('base64'),
        }] }) });
        assert.equal(response.status, 200);
        staleWritten = (await response.json()).success;
    }
    assert.ok(staleWritten, 'delayed failure fixture was actually published');
    await page.waitForTimeout(1800);
    assert.equal(await banner.count(), 0);
    assert.match(await summary.getAttribute('aria-label'), /1 个已完成.*0 个待处理/);
    await waitFor(async () => (await readAttention()).record.kind === 'done', 'client reconciles delayed failure without losing success');
    pass('A delayed failure with a newer KV version cannot overwrite the successful retry');

    await page.setViewportSize({ width: 1365, height: 900 });
    await page.goto(webOrigin, { waitUntil: 'domcontentloaded' });
    await card.waitFor();
    await page.screenshot({ path: path.join(artifacts, 'web-retry-success.png') });
    assert.equal(await page.getByText('执行失败', { exact: true }).count(), 0);
    pass('Desktop Web and a page reload restore the successful result rather than the old error');
    await showPreview();
    await summary.waitFor();

    await startTurn();
    await waitFor(async () => !(await summary.count()), 'new turn clears success');
    await finishTurn('cancelled');
    await page.waitForTimeout(1800);
    assert.equal(await summary.count(), 0);
    assert.equal(await card.count(), 0);
    pass('User cancellation produces neither a success popup nor a failure popup');

    await startTurn();
    await finishTurn('failed', 'transportError');
    await banner.getByText('执行失败 (transportError)', { exact: true }).waitFor();
    await pushEvent('failed', 'transportError');
    await page.screenshot({ path: path.join(artifacts, 'transport-error.png') });
    assert.equal((await readAttention()).record.errorCode, 'transportError');
    pass('An abnormal execution interruption displays transportError and persists that type');
    await banner.getByRole('button').first().click();
    await page.waitForURL(`**/session/${sessionId}`);
    await waitFor(async () => !(await summary.count()), 'opened conversation is read');
    await waitFor(async () => (await readAttention()).record.read, 'failure read receipt persists');
    pass('Clicking the error reminder opens the exact conversation and marks the result read');

    assert.deepEqual(failures, [], 'Browser console, page and HTTP errors');
    pass('No page errors, console errors, unexpected HTTP errors or failed requests');
} catch (error) {
    failures.push(error.stack ?? String(error));
    if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    console.error(error.message);
    process.exitCode = 1;
} finally {
    clearInterval(heartbeat);
    await browser?.close();
    await Promise.all(clients.map(client => client.close()));
    machineClient?.shutdown();
    for (const child of children.reverse()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: failures.length ? 'FAILED' : 'PASS', checks, failures }, null, 2));
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    console.log(`Artifacts: ${path.relative(repo, artifacts)}`);
}
