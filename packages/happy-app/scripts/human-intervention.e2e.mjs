// With Expo Web running: pnpm exec node packages/happy-app/scripts/human-intervention.e2e.mjs
// Uses current CLI source, an isolated Relay/account and real encrypted chat messages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nacl from 'tweetnacl';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const artifacts = path.join(repo, '.e2e-artifacts', `human-intervention-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const temporary = await mkdtemp(path.join(tmpdir(), 'happy-intervention-'));
const webOrigin = process.env.HAPPY_INTERVENTION_WEB_ORIGIN ?? 'http://127.0.0.1:8989';
await mkdir(artifacts, { recursive: true });
const children = [];
const clients = [];
const mcpClients = [];
const mcpServers = [];
const failures = [];
const checks = [];
const expectedFaults = [];
const cleanupWarnings = [];
let browser;
let page;
let machineClient;
let heartbeat;

async function waitFor(check, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
}
async function start(args, env, name) {
    const log = await open(path.join(artifacts, name), 'w');
    const child = spawn(process.execPath, args, {
        cwd: path.join(repo, 'packages/happy-server'), env, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
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
    console.log('Starting isolated human intervention fixture...');
    const migration = await start(['--import', 'tsx', 'sources/standalone.ts', 'migrate'], env, 'migrate.log');
    assert.equal((await once(migration, 'exit'))[0], 0, 'Temporary database migration');
    await start(['--import', 'tsx', 'sources/standalone.ts', 'serve'], env, 'server.log');
    await waitFor(async () => { try { return (await fetch(`${serverUrl}/health`)).ok; } catch { return false; } }, 'temporary Relay');

    const secret = new Uint8Array(randomBytes(32));
    const keypair = nacl.sign.keyPair.fromSeed(secret);
    const challenge = new Uint8Array(randomBytes(32));
    const auth = await fetch(`${serverUrl}/v1/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            publicKey: Buffer.from(keypair.publicKey).toString('base64'), challenge: Buffer.from(challenge).toString('base64'),
            signature: Buffer.from(nacl.sign.detached(challenge, keypair.secretKey)).toString('base64'),
        }),
    });
    assert.equal(auth.status, 200);
    const { token } = await auth.json();
    process.env.HAPPY_HOME_DIR = path.join(temporary, 'cli');
    process.env.HAPPY_SERVER_URL = serverUrl;
    // Bundle only the fixture entry; leave installed dependencies external and do not replace CLI dist.
    const entry = path.join(artifacts, 'cli-fixture.mjs');
    await build({
        stdin: { contents: `export { ApiClient } from './packages/happy-cli/src/api/api.ts';\nexport { startHappyServer } from './packages/happy-cli/src/claude/utils/startHappyServer.ts';`, resolveDir: repo },
        bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: entry,
        alias: {
            '@slopus/happy-wire': path.join(repo, 'packages/happy-wire/src/index.ts'),
            '@slopus/happy-wire/serverUrl': path.join(repo, 'packages/happy-wire/src/serverUrl.ts'),
        },
        tsconfig: path.join(repo, 'packages/happy-cli/tsconfig.json'), logLevel: 'silent',
    });
    const { ApiClient, startHappyServer } = await import(pathToFileURL(entry).href);
    const api = await ApiClient.create({ token, encryption: { type: 'legacy', secret } });
    const machine = await api.getOrCreateMachine({ machineId: randomUUID(), metadata: {
        host: 'human-intervention-fixture', platform: process.platform, displayName: '强提醒验收电脑',
        homeDir: temporary, happyHomeDir: path.join(temporary, 'cli'),
    } });
    machineClient = api.machineSyncClient(machine);
    machineClient.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorMessage: 'Fixture only' }), stopSession: () => true, requestShutdown() {} });
    machineClient.connect();
    await waitFor(() => machineClient.isReady(), 'fixture machine');

    const sessions = [];
    const tags = [];
    const messages = [[], []];
    const aborts = [0, 0];
    const pushEvents = [];
    for (const [index, title] of ['人工介入 Web 验收', '另一个等待处理的任务'].entries()) {
        const tag = randomUUID();
        tags.push(tag);
        const session = await api.getOrCreateSession({ tag, metadata: {
            path: temporary, host: 'human-intervention-fixture', machineId: machine.id, flavor: 'claude',
            summary: { text: title, updatedAt: Date.now() },
        }, state: { controlledByUser: false, requests: {} } });
        assert.ok(session);
        sessions.push(session);
        const client = api.sessionSyncClient(session);
        clients.push(client);
        client.onUserMessage(message => messages[index].push(message));
        client.rpcHandlerManager.registerHandler('abort', () => { aborts[index]++; return { aborted: true }; });
        const server = await startHappyServer(client, { sendSessionNotification(params) {
            pushEvents.push(params);
            api.push().sendSessionNotification(params);
        } });
        mcpServers.push(server);
        const mcp = new Client({ name: 'web-intervention-fixture', version: '1.0.0' });
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)));
        mcpClients.push(mcp);
    }
    await waitFor(() => clients.every(client => client.socket.connected), 'fixture sessions');
    let alive = true;
    const ping = () => clients.forEach((client, index) => { if (index !== 0 || alive) client.keepAlive(false, 'remote'); });
    ping();
    heartbeat = setInterval(ping, 2000);
    const ask = async (kind, instructions, index = 0) => {
        const response = await mcpClients[index].callTool({ name: 'request_human_intervention', arguments: { kind, instructions } });
        assert.notEqual(response.isError, true, JSON.stringify(response.content));
        return JSON.parse(response.content.find(item => item.type === 'text').text);
    };

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
    await page.goto(webOrigin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.getByText('人工介入 Web 验收', { exact: true }).first().waitFor({ timeout: 60_000 });
    const dialog = page.getByTestId('human-intervention-dialog');
    assert.equal(await dialog.count(), 0);
    const instructions = '请在执行电脑的终端中输入 sudo 密码。完成后返回 Happy，自行输入回复。';
    const first = await ask('sudo', instructions);
    await dialog.waitFor();
    assert.ok(await dialog.getByText('human-intervention-fixture', { exact: false }).isVisible());
    assert.equal(await page.getByTestId('human-intervention-instructions').innerText(), instructions);
    await page.screenshot({ path: path.join(artifacts, 'desktop-dialog.png'), animations: 'disabled' });
    await writeFile(path.join(artifacts, 'initial-dom.txt'), await page.locator('body').innerText());
    console.log(`Initial browser view: ${path.relative(repo, artifacts)}`);
    if (process.env.HAPPY_INTERVENTION_PAUSE === '1') {
        console.log('Paused for visual inspection; create continue in the artifact directory to resume.');
        await waitFor(async () => { try { await access(path.join(artifacts, 'continue')); return true; } catch { return false; } }, 'visual inspection completed', 180_000);
    }
    await page.waitForTimeout(4200);
    await page.keyboard.press('Escape');
    assert.ok(await dialog.isVisible());
    pass('Real MCP report opens a persistent desktop dialog with the correct computer and instructions');

    assert.equal((await ask('sudo', instructions)).requestId, first.requestId);
    assert.equal(pushEvents.length, 1);
    assert.equal(await dialog.count(), 1);
    pass('Repeated reports reuse one request and do not duplicate notifications');

    await page.getByTestId('human-intervention-later').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(await page.getByTestId('human-intervention-reminder').isVisible());
    assert.equal(clients[0].getAgentState().humanIntervention.id, first.requestId);
    assert.equal(messages[0].length, 0);
    await page.getByTestId('human-intervention-reminder').click();
    await dialog.waitFor();
    await page.getByTestId('human-intervention-open').click();
    await page.waitForURL(`**/session/${sessions[0].id}`);
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(clients[0].getAgentState().humanIntervention.id, first.requestId);
    assert.equal(messages[0].length, 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dialog.waitFor();
    pass('Deferring and opening the conversation preserve the blocker; refresh restores the dialog');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(artifacts, 'mobile-web-dialog.png'), animations: 'disabled' });
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844);
    assert.ok(await page.getByTestId('human-intervention-open').isVisible());
    assert.ok(await page.getByTestId('human-intervention-later').isVisible());
    assert.equal(await page.getByTestId('human-intervention-resolve').count(), 0);
    assert.equal(await page.getByTestId('human-intervention-cancel').count(), 0);
    pass('The mobile dialog offers only reply navigation and deferral');

    const openReply = async (index = 0) => {
        await page.getByTestId('human-intervention-open').click();
        await page.waitForURL(`**/session/${sessions[index].id}`);
        await dialog.waitFor({ state: 'hidden' });
        await page.getByTestId('human-intervention-reply-context').waitFor();
        return page.locator('textarea').last();
    };
    const sendReply = async (text, index = 0) => {
        const count = messages[index].length;
        const id = clients[index].getAgentState().humanIntervention.id;
        const input = page.locator('textarea').last();
        await input.fill(text);
        assert.equal(messages[index].length, count, 'Typing must not send');
        await input.press('Enter');
        await waitFor(() => clients[index].getAgentState().humanIntervention === null && messages[index].length === count + 1, 'authored reply delivered');
        assert.equal(messages[index][count].content.text, text);
        assert.equal(messages[index][count].meta.humanInterventionId, id);
        assert.equal(clients[index].getAgentState().completedHumanIntervention.status, 'replied');
        assert.equal(aborts[index], 0, 'Reminder replies never invoke abort');
        await page.getByTestId('human-intervention-reply-context').waitFor({ state: 'hidden' });
    };

    const input = await openReply();
    assert.equal(messages[0].length, 0);
    assert.equal(await input.inputValue(), '', 'Opening must not prefill a message');
    const draft = '我还没处理，先保留这条草稿。';
    await input.fill(draft);
    await page.getByTestId('human-intervention-reminder').click();
    await dialog.waitFor();
    await page.getByTestId('human-intervention-later').click();
    assert.equal(await input.inputValue(), draft);
    assert.equal(messages[0].length, 0);
    await sendReply('本地已经处理，请先检查实际结果再继续。');
    pass('Opening and closing preserve the draft; only the exact authored reply is delivered');

    await ask('uac', '请在执行电脑上确认 Windows UAC 授权弹窗。');
    await dialog.waitFor();
    await openReply();
    await sendReply('没有处理，取消这一步，先检查其他问题。');
    pass('Cancellation is expressed by the user’s own message, without a generated follow-up or automatic abort');

    await ask('manual', '请在电脑上完成本地确认，然后自行回复。');
    await dialog.waitFor();
    await openReply();
    const updateState = clients[0].updateAgentState.bind(clients[0]);
    let releaseAcknowledgement;
    let acknowledgementStarted = false;
    const acknowledgementGate = new Promise(resolve => { releaseAcknowledgement = resolve; });
    clients[0].updateAgentState = async updater => {
        acknowledgementStarted = true;
        await acknowledgementGate;
        return updateState(updater);
    };
    const countBeforeDelay = messages[0].length;
    const delayedText = '暂时没完成，只反馈当前情况。';
    await input.fill(delayedText);
    await input.press('Enter');
    await waitFor(() => acknowledgementStarted, 'CLI receives reply');
    assert.ok(clients[0].getAgentState().humanIntervention);
    assert.equal(messages[0].length, countBeforeDelay);
    releaseAcknowledgement();
    await waitFor(() => messages[0].length === countBeforeDelay + 1 && clients[0].getAgentState().humanIntervention === null, 'durable acknowledgement');
    clients[0].updateAgentState = updateState;
    assert.equal(messages[0].at(-1).content.text, delayedText);
    pass('The reminder remains pending until the CLI durably acknowledges the authored reply');

    await ask('sudo', '请在电脑终端处理密码提示。');
    await dialog.waitFor();
    alive = false;
    clients[0].sendSessionDeath();
    await dialog.getByText('此会话已离线。可以先写回复，重新连接后才会送达。', { exact: true }).waitFor();
    clients[0].socket.disconnect();
    await openReply();
    const offlineCount = messages[0].length;
    const offlineText = '先取消，我稍后自己决定下一步。';
    await input.fill(offlineText);
    await input.press('Enter');
    assert.ok(clients[0].getAgentState().humanIntervention);
    assert.equal(messages[0].length, offlineCount);
    // Re-register the same session to lift the server's session-end guard.
    const restarted = await api.getOrCreateSession({ tag: tags[0], metadata: sessions[0].metadata, state: clients[0].getAgentState() });
    assert.equal(restarted.id, sessions[0].id);
    alive = true;
    clients[0].socket.connect();
    await waitFor(() => clients[0].socket.connected, 'session reconnected');
    ping();
    await waitFor(() => messages[0].length === offlineCount + 1 && clients[0].getAgentState().humanIntervention === null, 'offline reply delivered once');
    assert.equal(messages[0].at(-1).content.text, offlineText);
    pass('Offline replies preserve the reminder until reconnection and deliver the user’s text once');

    await ask('manual', '这是第一个待处理任务。');
    await dialog.waitFor();
    await ask('manual', '这是另一个会话的待处理任务。', 1);
    await page.getByTestId('human-intervention-open').click();
    await page.waitForURL(`**/session/${sessions[0].id}`);
    await dialog.getByText('另一个等待处理的任务', { exact: true }).waitFor();
    await page.getByTestId('human-intervention-later').click();
    await sendReply('先处理第一个会话。');
    assert.ok(clients[1].getAgentState().humanIntervention);
    await page.getByTestId('human-intervention-reminder').click();
    await dialog.waitFor();
    await openReply(1);
    await sendReply('第二个会话先取消。', 1);
    assert.deepEqual(aborts, [0, 0]);
    await page.screenshot({ path: path.join(artifacts, 'all-replied.png'), animations: 'disabled' });
    pass('Each authored reply acknowledges only its own session and never triggers an automatic abort');

    assert.deepEqual(failures, [], 'Browser page, console, network and HTTP errors');
    pass('No page errors, console errors, unexpected HTTP errors or failed requests');
} catch (error) {
    failures.push(error.stack ?? String(error));
    if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    console.error(error.message);
    process.exitCode = 1;
} finally {
    clearInterval(heartbeat);
    await browser?.close();
    await Promise.all(mcpClients.map(client => client.close()));
    mcpServers.forEach(server => server.stop());
    await Promise.all(clients.map(client => client.close()));
    machineClient?.shutdown();
    for (const child of children.reverse()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
        try {
            process.kill(-child.pid, 'SIGTERM');
            await exited;
        } catch (error) {
            cleanupWarnings.push(`Fixture process cleanup: ${error.message}`);
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }
    }
    // Keep cleanup diagnostics separate from the exercised user flow, and never
    // silently ignore a server error that happened before shutdown.
    const serverLog = await readFile(path.join(artifacts, 'server.log'), 'utf8').catch(() => '');
    const shutdownAt = serverLog.indexOf('Received SIGTERM signal');
    const runtimeLog = shutdownAt < 0 ? serverLog : serverLog.slice(0, shutdownAt);
    if (/Error in |Invalid `|Exception|FAILED|uncaught/i.test(runtimeLog)) {
        failures.push('Unexpected Relay runtime error; see server.log');
        process.exitCode = 1;
    }
    if (shutdownAt >= 0 && serverLog.slice(shutdownAt).includes('Response from the Engine was empty')) {
        cleanupWarnings.push('Existing Relay shutdown race: session-timeout queries PGlite after concurrent database shutdown (only after SIGTERM).');
    }
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: failures.length ? 'FAILED' : cleanupWarnings.length ? 'PASS_WITH_WARNINGS' : 'PASS', checks, failures, expectedFaults, cleanupWarnings }, null, 2));
    cleanupWarnings.forEach(warning => console.log(`Cleanup warning: ${warning}`));
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    console.log(`Artifacts: ${path.relative(repo, artifacts)}`);
}
