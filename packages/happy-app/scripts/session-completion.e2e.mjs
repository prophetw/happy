// With Expo web already running: pnpm exec node packages/happy-app/scripts/session-completion.e2e.mjs
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

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const artifacts = path.join(repo, '.e2e-artifacts', `session-completion-${new Date().toISOString().replace(/[:.]/g, '-')}`);
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
    for (const title of ['检查 Web 状态通知', '优化目录选择与搜索']) {
        const session = await api.getOrCreateSession({ tag: randomUUID(), metadata: {
            path: temporary, host: 'completion-fixture', machineId: machine.id, flavor: 'claude',
            summary: { text: title, updatedAt: Date.now() },
        }, state: { controlledByUser: false, requests: {} } });
        assert.ok(session);
        sessions.push(session);
        clients.push(api.sessionSyncClient(session));
    }
    await waitFor(() => clients.every(client => client.socket.connected), 'fixture sessions');
    const thinking = [false, false];
    const ping = () => clients.forEach((client, index) => client.keepAlive(thinking[index], 'remote'));
    ping();
    heartbeat = setInterval(ping, 2000);

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'zh-CN', colorScheme: 'dark' });
    await context.addInitScript(({ serverUrl, token, secret }) => {
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
    await page.getByText('检查 Web 状态通知', { exact: true }).first().waitFor({ timeout: 45_000 });
    const panel = page.getByTestId('session-completion-notifications');
    const card = index => page.getByTestId(`session-completion-${sessions[index].id}`);
    await waitFor(async () => !(await panel.count()), 'no notifications for initial idle sessions');
    thinking[0] = true;
    ping();
    await page.getByText('运行中', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('运行中', { exact: true }).first().evaluate(element => getComputedStyle(element).color), 'rgb(0, 122, 255)');
    await page.screenshot({ path: path.join(artifacts, 'running.png') });
    pass('Running has a blue, explicitly labelled Web status');
    thinking[0] = false;
    ping();
    await card(0).waitFor();
    await page.waitForTimeout(6000);
    assert.equal(await card(0).count(), 1);
    assert.equal(await page.getByText('已完成', { exact: true }).first().evaluate(element => getComputedStyle(element).color), 'rgb(52, 199, 89)');
    await page.screenshot({ path: path.join(artifacts, 'completed.png') });
    pass('Real socket completion produces a persistent green notification without duplicates');
    await card(0).getByRole('button', { name: '关闭完成通知' }).click();
    await waitFor(async () => !(await card(0).count()), 'dismissed card');
    assert.ok(await page.getByText('已完成', { exact: true }).count());
    pass('Dismiss preserves the green unread completion state in the list');
    thinking[0] = true;
    ping();
    await page.getByText('运行中', { exact: true }).first().waitFor();
    thinking[0] = false;
    ping();
    await card(0).waitFor();
    pass('The next completed turn notifies again');

    thinking[1] = true;
    ping();
    await page.getByText('运行中', { exact: true }).first().waitFor();
    clients[1].updateAgentState(state => ({ ...state, requests: { permission: { tool: 'Bash', arguments: { command: 'echo fixture' } } } }));
    await page.getByText('需要权限', { exact: true }).first().waitFor();
    thinking[1] = false;
    ping();
    await page.waitForTimeout(1200);
    assert.equal(await card(1).count(), 0);
    pass('Pending permission stays orange and does not emit completion');
    clients[1].updateAgentState(state => ({ ...state, requests: {} }));
    await card(1).waitFor();
    assert.equal(await panel.getByText(/已完成 \(2\)/).count(), 1);
    await page.screenshot({ path: path.join(artifacts, 'completion-queue.png') });
    await page.getByText('设置', { exact: true }).last().click();
    await page.getByText('外观', { exact: true }).first().click();
    await page.getByText('分组', { exact: true }).click();
    await page.getByText('按项目分组', { exact: true }).waitFor();
    assert.equal(await panel.getByText(/已完成 \(2\)/).count(), 1);
    await page.goBack();
    await page.goBack();
    await page.getByText('检查 Web 状态通知', { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(artifacts, 'grouped-completion.png') });
    pass('Project grouping shows completion badges and notifications survive settings navigation');
    await card(0).getByRole('button', { name: /点击查看对话/ }).click();
    await page.waitForURL(`**/session/${sessions[0].id}`);
    await waitFor(async () => !(await card(0).count()), 'opened session marked read');
    assert.equal(await card(1).count(), 1);
    await page.screenshot({ path: path.join(artifacts, 'opened-conversation.png') });
    pass('Click opens the exact conversation, clears only its card, and keeps other results visible');
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
    await rm(temporary, { recursive: true, force: true });
    console.log(`Artifacts: ${path.relative(repo, artifacts)}`);
}
