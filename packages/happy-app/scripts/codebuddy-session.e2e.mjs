// Start Expo Web locally, then run this script with HAPPY_CODEBUDDY_WEB_ORIGIN.
// Requires the built Happy CLI and the local PGlite / Playwright dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import nacl from 'tweetnacl';

const webOrigin = process.env.HAPPY_CODEBUDDY_WEB_ORIGIN ?? 'http://127.0.0.1:8989';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'happy-codebuddy-e2e-'));
const artifacts = join(repo, '.e2e-artifacts', 'codebuddy-' + Date.now());
const cli = join(repo, 'packages/happy-cli/dist/index.mjs');
const happyHome = join(root, 'cli');
const bin = join(root, 'bin');
const checkout = join(root, 'codebuddy-checkout');
const trace = join(root, 'acp.jsonl');
const processes = [];
const errors = [];
let browser, page, controlPort;
await Promise.all([artifacts, happyHome, bin, checkout].map(path => mkdir(path, { recursive: true })));

async function start(args, env, name, cwd = repo) {
    const log = await open(join(artifacts, name + '.log'), 'w');
    const processHandle = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    processes.push(processHandle);
    await log.close();
    return processHandle;
}

async function waitFor(check, label, timeout = 30_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for ' + label);
}

async function control(route, body = {}) {
    const response = await fetch('http://127.0.0.1:' + controlPort + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.ok(response.ok, route + ' returned ' + response.status);
    return response.json();
}

const observed = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

try {
    await copyFile(new URL('./fixtures/codebuddy-acp.cjs', import.meta.url), join(bin, 'codebuddy'));
    await chmod(join(bin, 'codebuddy'), 0o755);
    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    const serverUrl = 'http://127.0.0.1:' + port;
    const relayEnv = {
        ...process.env, NODE_ENV: 'development', DB_PROVIDER: 'pglite', DATA_DIR: root, PGLITE_DIR: join(root, 'db'),
        HANDY_MASTER_SECRET: randomBytes(32).toString('hex'), HOST: '127.0.0.1', PORT: String(port),
        PUBLIC_URL: serverUrl, REDIS_URL: '', S3_HOST: '', HAPPY_ALLOWED_ACCOUNT_IDS: '*', METRICS_ENABLED: 'false',
        GITHUB_CLIENT_ID: '', GITHUB_APP_ID: '',
    };
    const serverCwd = join(repo, 'packages/happy-server');
    const migrate = await start(['--import', 'tsx', 'sources/standalone.ts', 'migrate'], relayEnv, 'migrate', serverCwd);
    assert.equal((await once(migrate, 'exit'))[0], 0);
    await start(['--import', 'tsx', 'sources/standalone.ts', 'serve'], relayEnv, 'relay', serverCwd);
    await waitFor(async () => (await fetch(serverUrl + '/health').catch(() => null))?.ok, 'relay health');

    const secret = new Uint8Array(randomBytes(32));
    const account = nacl.sign.keyPair.fromSeed(secret);
    const challenge = new Uint8Array(randomBytes(32));
    const b64 = bytes => Buffer.from(bytes).toString('base64');
    const auth = await fetch(serverUrl + '/v1/auth', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: b64(account.publicKey), challenge: b64(challenge),
            signature: b64(nacl.sign.detached(challenge, account.secretKey)) }),
    });
    assert.equal(auth.status, 200);
    const { token } = await auth.json();
    const headers = { authorization: 'Bearer ' + token };
    const machineId = randomUUID();
    await writeFile(join(happyHome, 'access.key'), JSON.stringify({ token, secret: b64(secret) }), { mode: 0o600 });
    await writeFile(join(happyHome, 'settings.json'), JSON.stringify({
        machineId, schemaVersion: 2, onboardingCompleted: true, machineIdConfirmedByServer: true,
    }));
    const cliEnv = { ...process.env, HAPPY_HOME_DIR: happyHome, HAPPY_SERVER_URL: serverUrl,
        HAPPY_DISABLE_CAFFEINATE: '1', HAPPY_CODEBUDDY_FIXTURE_LOG: trace, PATH: bin + delimiter + process.env.PATH };
    await start([cli, 'daemon', 'start-sync'], cliEnv, 'daemon');
    await waitFor(async () => {
        const value = await readFile(join(happyHome, 'daemon.state.json'), 'utf8').catch(() => null);
        if (!value) return false;
        controlPort = JSON.parse(value).httpPort;
        const status = await control('/status');
        return status.connected && status.machineId === machineId;
    }, 'selected daemon');

    function decrypt(content) {
        const data = new Uint8Array(Buffer.from(content, 'base64'));
        const size = nacl.secretbox.nonceLength;
        const plaintext = nacl.secretbox.open(data.slice(size), data.slice(0, size), secret);
        assert.ok(plaintext, 'encrypted relay record is readable with the fixture account');
        return JSON.parse(Buffer.from(plaintext).toString('utf8'));
    }
    // Seed a discoverable checkout on the actual daemon for the UI path picker.
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = serverUrl;
    const { ApiClient } = await import('../../happy-cli/dist/lib.mjs');
    const api = await ApiClient.create({ token, encryption: { type: 'legacy', secret } });
    assert.ok(await api.getOrCreateSession({
        tag: randomUUID(), metadata: { machineId, path: checkout, host: 'fixture', flavor: 'claude',
            homeDir: root, summary: { text: 'CodeBuddy test checkout', updatedAt: Date.now() } },
        state: { controlledByUser: false },
    }));

    browser = await chromium.launch({ ...(process.env.HAPPY_CODEBUDDY_CHROMIUM ? { executablePath: process.env.HAPPY_CODEBUDDY_CHROMIUM } : {}), args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'en-US' });
    await context.addInitScript(({ serverUrl, token, secret }) => {
        window.__HAPPY_CONFIG__ = { serverUrl, disableAnalytics: true };
        localStorage.setItem('auth_credentials', JSON.stringify({ token, secret }));
    }, { serverUrl, token, secret: b64(secret) });
    page = await context.newPage();
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('response', res => { if (res.status() >= 400) errors.push(res.status() + ' ' + new URL(res.url()).pathname); });
    await page.goto(webOrigin + '/new', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const search = page.getByRole('combobox');
    await search.fill('codebuddy-checkout', { timeout: 60_000 });
    await page.getByTestId('project-search-result').filter({ hasText: 'codebuddy-checkout' }).click();
    await page.getByRole('button', { name: /^Agent:/ }).click();
    await page.getByText('CodeBuddy', { exact: true }).click();
    await page.getByPlaceholder('What would you like to work on?').fill('ACP_FIRST');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForURL('**/session/*', { timeout: 60_000 });
    const sessionId = new URL(page.url()).pathname.split('/').pop();
    const rowsResponse = await fetch(serverUrl + '/v1/sessions', { headers });
    const rows = (await rowsResponse.json()).sessions;
    const metadata = decrypt(rows.find(row => row.id === sessionId).metadata);
    assert.equal(metadata.machineId, machineId);
    assert.equal(metadata.path, checkout);
    assert.equal(metadata.flavor, 'codebuddy');
    assert.equal(metadata.currentModelCode, 'fixture-model');

    async function events() {
        const response = await fetch(serverUrl + '/v3/sessions/' + sessionId + '/messages?after_seq=0&limit=100', { headers });
        assert.equal(response.status, 200);
        return (await response.json()).messages.map(item => decrypt(item.content.c))
            .filter(item => item.role === 'session').map(item => item.content.ev);
    }
    const statuses = async () => (await events()).filter(ev => ev.t === 'turn-end').map(ev => ev.status);
    const checkStatuses = async (expected) => {
        await waitFor(async () => (await statuses()).length >= expected.length, 'native turn results');
        assert.deepEqual(await statuses(), expected);
    };

    await page.getByText('Streaming fixture', { exact: true }).waitFor();
    assert.deepEqual(await statuses(), []);
    const first = await observed();
    assert.deepEqual(first.find(ev => ev.event === 'start').args, ['--acp', '--permission-mode', 'default']);
    assert.equal(first.find(ev => ev.event === 'new').requestedCwd, checkout);
    assert.ok(first.find(ev => ev.event === 'prompt').text.startsWith('ACP_FIRST'));
    assert.ok(first.every(ev => ev.cwd === checkout));
    await writeFile(trace + '.finish', '');
    await checkStatuses(['completed']);
    await page.getByText('Streaming fixture reply', { exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, 'streamed-reply.png') });

    const composer = page.getByPlaceholder('Type a message ...');
    async function send(text) {
        await composer.fill(text);
        await composer.press('Enter');
    }
    await send('ACP_FAIL');
    await checkStatuses(['completed', 'failed']);
    await page.getByText(/CodeBuddy authentication is required/).first().waitFor();
    await send('ACP_CANCEL');
    await page.getByText('Fixture waiting for cancellation', { exact: true }).waitFor();
    await composer.press('Escape');
    await checkStatuses(['completed', 'failed', 'cancelled']);
    assert.ok((await observed()).some(ev => ev.event === 'cancel'));
    await send('ACP_NEXT');
    await checkStatuses(['completed', 'failed', 'cancelled', 'completed']);
    await page.getByText('Fixture reply 4', { exact: true }).waitFor();
    await send('ACP_PERMISSION');
    await page.getByText('Yes', { exact: true }).click();
    await checkStatuses(['completed', 'failed', 'cancelled', 'completed', 'completed']);
    assert.deepEqual((await observed()).find(ev => ev.event === 'permission').outcome, {
        outcome: 'selected', optionId: 'allow-id',
    });

    assert.equal((await control('/stop-session', { sessionId })).success, true);
    await waitFor(async () => !(await control('/list')).children.some(child => child.happySessionId === sessionId), 'session process exit');
    await page.getByText('Resume Session', { exact: true }).click({ timeout: 30_000 });
    await waitFor(async () => (await observed()).some(ev => ev.event === 'load'), 'native session load');
    await send('ACP_RESUMED');
    await checkStatuses(['completed', 'failed', 'cancelled', 'completed', 'completed', 'completed']);
    await page.getByText('Fixture reply 6', { exact: true }).waitFor();
    assert.equal(await page.getByText('Replayed provider history', { exact: true }).count(), 0);
    const prompts = (await observed()).filter(ev => ev.event === 'prompt');
    assert.equal(new Set(prompts.map(ev => ev.sessionId)).size, 1);
    assert.deepEqual(prompts.map(ev => ev.count), [1, 2, 3, 4, 5, 6]);
    assert.ok(page.url().endsWith('/session/' + sessionId));
    assert.deepEqual(errors, []);
    console.log('PASS: selected daemon and checkout, streaming, native completion and failure, cancel, permission, follow-up and restart resume');
} catch (error) {
    await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
    if (page) await writeFile(join(artifacts, 'failure.txt'), JSON.stringify({
        errors, url: page.url(), observations: await observed().catch(() => []),
        text: await page.locator('body').innerText().catch(() => ''),
    }, null, 2));
    const cliLogs = join(happyHome, 'logs');
    for (const name of await readdir(cliLogs).catch(() => [])) {
        await copyFile(join(cliLogs, name), join(artifacts, name));
    }
    throw error;
} finally {
    await browser?.close();
    if (controlPort) {
        const children = (await control('/list').catch(() => ({}))).children ?? [];
        await Promise.all(children.map(child => control('/stop-session', {
            sessionId: child.happySessionId ?? 'PID-' + child.pid,
        }).catch(() => {})));
    }
    for (const child of processes.reverse()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 4_000);
        await exited;
        clearTimeout(kill);
    }
    await rm(root, { recursive: true, force: true });
    console.log('Artifacts: ' + artifacts);
}
