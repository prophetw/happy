// pnpm --filter @slopus/happy-wire build && pnpm --filter happy build
// pnpm exec tsx packages/happy-app/scripts/relay-live-switch.e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import sodium from 'libsodium-wrappers';
import { chromium } from 'playwright';
import { deriveKey } from '../../happy-cli/src/utils/deriveKey.ts';

const filename = fileURLToPath(import.meta.url);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
async function waitFor(check, label, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
}

async function fixture() {
    await sodium.ready;
    const { ApiClient, configuration } = await import('../../happy-cli/dist/lib.mjs');
    const secret = new Uint8Array(Buffer.from(process.env.RELAY_FIXTURE_SECRET, 'base64'));
    const contentSeed = await deriveKey(secret, 'Happy EnCoder', ['content']);
    const credential = {
        token: process.env.RELAY_FIXTURE_TOKEN,
        encryption: { type: 'dataKey', publicKey: sodium.crypto_box_seed_keypair(contentSeed).publicKey, machineKey: randomBytes(32) },
    };
    const api = await ApiClient.create(credential);
    const machineId = randomUUID();
    const machine = await api.getOrCreateMachine({ machineId, metadata: {
        host: 'live-relay-fixture', displayName: 'Live relay computer', platform: process.platform,
        happyCliVersion: configuration.currentCliVersion, homeDir: tmpdir(), happyHomeDir: configuration.happyHomeDir, happyLibDir: repo,
        cliAvailability: { claude: true },
    } });
    const daemon = api.machineSyncClient(machine);
    daemon.setRPCHandlers({
        spawnSession: async () => ({ type: 'success', sessionId: session.id }),
        stopSession: () => true, requestShutdown: () => {},
    });
    daemon.connect();
    const session = await api.getOrCreateSession({ tag: randomUUID(), metadata: {
        path: repo, host: 'live-relay-fixture', name: 'Live relay conversation', flavor: 'claude', machineId,
        homeDir: tmpdir(), happyHomeDir: configuration.happyHomeDir, happyLibDir: repo, happyToolsDir: repo,
        version: configuration.currentCliVersion, os: process.platform,
    }, state: null });
    assert.ok(session);
    const client = api.sessionSyncClient(session);
    client.rpcHandlerManager.registerHandler('permission', async request => {
        process.send({ kind: 'permission', request, pid: process.pid, serverUrl: configuration.serverUrl });
        client.updateAgentState(state => ({ ...state, requests: {} }));
        return { success: true };
    });
    client.onUserMessage(message => {
        process.send({ kind: 'user', text: message.content.text, pid: process.pid, serverUrl: configuration.serverUrl });
        client.sendAgentMessage('claude', { type: 'message', message: `fixture-reply:${message.content.text}` });
    });
    const heartbeat = setInterval(() => client.keepAlive(false, 'remote'), 1000);
    let failureDaemon;
    await waitFor(() => daemon.isReady(), 'fixture daemon RPC registration');
    client.updateAgentState(() => ({ controlledByUser: false, requests: {
        'permission-before-switch': { tool: 'Bash', arguments: { command: 'echo relay-permission-fixture' }, createdAt: Date.now() },
    } }));
    client.sendAgentMessage('claude', { type: 'message', message: 'old-history-only' });
    await client.flush();
    process.on('message', async command => {
        if (command === 'enable-failure') {
            const extra = await api.getOrCreateMachine({ machineId: randomUUID(), metadata: { ...machine.metadata, displayName: 'Rollback fixture' } });
            failureDaemon = api.machineSyncClient(extra);
            failureDaemon.setRPCHandlers({ spawnSession: async () => ({ type: 'success', sessionId: session.id }), stopSession: () => true, requestShutdown: () => {} });
            failureDaemon.rpcHandlerManager.registerHandler('relay-switch', async request => {
                if (request.phase === 'commit') {
                    await waitFor(() => configuration.serverUrl === request.serverUrl, 'another participant committed', 5_000);
                    client.updateAgentState(state => ({ ...state, requests: {
                        ...state.requests,
                        'permission-during-rollback': { tool: 'Bash', arguments: { command: 'echo permission-created-during-switch' }, createdAt: Date.now() },
                    } }));
                    await new Promise(resolve => setTimeout(resolve, 500));
                    return { error: 'Injected participant commit failure' };
                }
                return { success: true };
            });
            failureDaemon.connect();
            await waitFor(() => failureDaemon.isReady(), 'failure fixture registration');
            process.send({ kind: 'failure-ready' });
        }
        if (command === 'state') process.send({ kind: 'state', pid: process.pid, serverUrl: configuration.serverUrl });
        if (command === 'stop') {
            clearInterval(heartbeat);
            daemon.shutdown();
            failureDaemon?.shutdown();
            await client.close();
            process.exit(0);
        }
    });
    process.send({ kind: 'ready', pid: process.pid, sessionId: session.id, machineId });
}

async function main() {
    const runId = `relay-live-switch-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const artifacts = path.join(repo, '.e2e-artifacts', runId);
    const temporary = await mkdtemp(path.join(tmpdir(), 'happy-relay-switch-'));
    await mkdir(artifacts, { recursive: true });
    const children = [];
    const failures = [];
    const checks = [];
    let browser;
    let page;
    let fixtureProcess;
    async function port() {
        const server = createServer();
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const allocated = server.address().port;
        await new Promise(resolve => server.close(resolve));
        return allocated;
    }
    async function start(args, cwd, env, name, ipc = false) {
        const log = await open(path.join(artifacts, name), 'w');
        const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd, ...(ipc ? ['ipc'] : [])] });
        children.push(child);
        await log.close();
        return child;
    }
    async function exit(child) {
        if (child.exitCode !== null) return child.exitCode;
        return new Promise(resolve => child.once('exit', resolve));
    }
    try {
        const serverCwd = path.join(repo, 'packages/happy-server');
        const urls = [];
        const env = {
            ...process.env, NODE_ENV: 'development', APP_ENV: 'development', HOST: '127.0.0.1',
            DB_PROVIDER: 'pglite', REDIS_URL: '', S3_HOST: '', HAPPY_ALLOWED_ACCOUNT_IDS: '*', METRICS_ENABLED: 'false',
            GITHUB_CLIENT_ID: '', GITHUB_APP_ID: '', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_HARNESS_MODE: '',
            EXPO_PUBLIC_DEV_TOKEN: '', EXPO_PUBLIC_DEV_SECRET: '', EXPO_PUBLIC_LOG_SERVER_URL: '', BROWSER: 'none', CI: '1',
        };
        console.log('Starting two isolated relays...');
        for (const name of ['a', 'b']) {
            const serverPort = await port();
            const url = `http://127.0.0.1:${serverPort}`;
            urls.push(url);
            const data = path.join(temporary, name);
            const serverEnv = { ...env, PORT: String(serverPort), DATA_DIR: data, PGLITE_DIR: path.join(data, 'pglite'), PUBLIC_URL: url, HANDY_MASTER_SECRET: randomBytes(32).toString('hex') };
            const migrate = await start(['--import', 'tsx', 'sources/standalone.ts', 'migrate'], serverCwd, serverEnv, `${name}-migrate.log`);
            assert.equal(await exit(migrate), 0, `${name} migration`);
            await start(['--import', 'tsx', 'sources/standalone.ts', 'serve'], serverCwd, serverEnv, `${name}-server.log`);
            await waitFor(async () => { try { return (await fetch(`${url}/health`)).ok; } catch { return false; } }, `${name} health`);
        }
        const [oldUrl, newUrl] = urls;
        const secret = randomBytes(32);
        const key = nacl.sign.keyPair.fromSeed(secret);
        const challenge = randomBytes(32);
        const authResponse = await fetch(`${oldUrl}/v1/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            publicKey: Buffer.from(key.publicKey).toString('base64'), challenge: challenge.toString('base64'),
            signature: Buffer.from(nacl.sign.detached(challenge, key.secretKey)).toString('base64'),
        }) });
        assert.equal(authResponse.status, 200);
        const { token } = await authResponse.json();
        const messages = [];
        fixtureProcess = await start(['--import', 'tsx', filename, '--fixture'], repo, {
            ...env, HAPPY_HOME_DIR: path.join(temporary, 'cli'), HAPPY_SERVER_URL: oldUrl,
            RELAY_FIXTURE_TOKEN: token, RELAY_FIXTURE_SECRET: secret.toString('base64'),
        }, 'cli-fixture.log', true);
        fixtureProcess.on('message', message => messages.push(message));
        await waitFor(() => {
            if (fixtureProcess.exitCode !== null) throw new Error('CLI fixture exited; inspect cli-fixture.log');
            return messages.some(message => message.kind === 'ready');
        }, 'CLI fixture');
        const ready = messages.find(message => message.kind === 'ready');

        const webPort = await port();
        const webOrigin = `http://localhost:${webPort}`;
        const expo = fileURLToPath(import.meta.resolve('expo/bin/cli'));
        await start([expo, 'start', '--web', '--host', 'localhost', '--port', String(webPort)], path.join(repo, 'packages/happy-app'), { ...env, EXPO_PUBLIC_HAPPY_SERVER_URL: oldUrl }, 'web.log');
        await waitFor(async () => { try { return (await fetch(webOrigin)).ok; } catch { return false; } }, 'Expo web');
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
        await context.addInitScript(({ token, secret }) => {
            window.__HAPPY_CONFIG__ = { disableAnalytics: true };
            if (!localStorage.getItem('auth_credentials')) localStorage.setItem('auth_credentials', JSON.stringify({ token, secret }));
        }, { token, secret: secret.toString('base64url') });
        page = await context.newPage();
        page.on('pageerror', error => failures.push(`Page: ${error.message}`));
        page.on('console', message => { if (message.type() === 'error') failures.push(`Console: ${message.text()}`); });
        page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });
        page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') failures.push(`Request: ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`); });
        await page.goto(`${webOrigin}/session/${ready.sessionId}`, { timeout: 120_000, waitUntil: 'domcontentloaded' });
        await page.getByText('old-history-only', { exact: true }).waitFor({ timeout: 120_000 });
        const composer = page.getByRole('textbox');
        await composer.fill('message-before-switch');
        await composer.press('Enter');
        await page.getByText('fixture-reply:message-before-switch', { exact: true }).waitFor();
        await composer.fill('draft-survives-relay-switch');
        await page.screenshot({ path: path.join(artifacts, 'before-switch.png') });
        await page.goto(`${webOrigin}/settings`);
        await page.getByText('Server Configuration', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(artifacts, 'settings-server-entry.png') });
        await page.getByText('Server Configuration', { exact: true }).click({ timeout: 10_000 });
        await page.waitForURL('**/server');
        checks.push('Standalone Settings exposes server configuration while using the default relay');
        await page.getByRole('textbox').fill(newUrl);
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.getByText('Continue', { exact: true }).click();
        await waitFor(async () => {
            try {
                const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('auth_credentials') || 'null'));
                return saved?.token && saved.token !== token && saved.secret === secret.toString('base64url');
            } catch { return false; }
        }, 'App retained the account key and obtained a new token');
        await page.getByRole('textbox').waitFor();
        assert.equal(await page.getByRole('textbox').inputValue(), newUrl);
        fixtureProcess.send('state');
        await waitFor(() => messages.some(message => message.kind === 'state' && message.serverUrl === newUrl), 'CLI followed the new relay');
        assert.equal(messages.find(message => message.kind === 'state').pid, ready.pid);
        const persisted = JSON.parse(await readFile(path.join(temporary, 'cli', 'access.key'), 'utf8'));
        assert.equal(persisted.serverUrl, newUrl);
        assert.ok(persisted.encryption.publicKey);
        const probe = await start(['--input-type=module', '-e',
            "import { configuration } from './packages/happy-cli/dist/lib.mjs'; process.stdout.write(configuration.serverUrl);"],
        repo, { ...env, HAPPY_HOME_DIR: path.join(temporary, 'cli'), HAPPY_SERVER_URL: oldUrl }, 'next-cli-url.log');
        assert.equal(await exit(probe), 0);
        assert.equal(await readFile(path.join(artifacts, 'next-cli-url.log'), 'utf8'), newUrl);
        checks.push('App and CLI switch with the same account key, paired machine and process PID');
        await page.goto(`${webOrigin}/session/${ready.sessionId}`);
        await page.getByRole('textbox').waitFor();
        assert.equal(await page.getByRole('textbox').inputValue(), 'draft-survives-relay-switch');
        assert.equal(await page.getByText('old-history-only', { exact: true }).count(), 0);
        checks.push('Draft survives and old transcript is not migrated');
        await page.getByRole('textbox').fill('message-after-switch');
        await page.getByRole('textbox').press('Enter');
        await waitFor(() => messages.some(message => message.kind === 'user' && message.text === 'message-after-switch' && message.serverUrl === newUrl), 'CLI receives a new prompt');
        await page.getByText('fixture-reply:message-after-switch', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(artifacts, 'permission-after-switch.png') });
        checks.push('The same live session sends and receives encrypted messages on the new relay');
        await page.getByText('Yes', { exact: true }).click();
        await waitFor(() => messages.some(message => message.kind === 'permission' && message.request.id === 'permission-before-switch' && message.serverUrl === newUrl), 'permission response after switch');
        checks.push('An outstanding permission request remains actionable after switching');
        await page.screenshot({ path: path.join(artifacts, 'after-switch.png') });

        await page.goto(`${webOrigin}/server`);
        const relayBToken = await page.evaluate(() => JSON.parse(localStorage.getItem('auth_credentials')).token);
        await page.getByRole('textbox').fill(oldUrl);
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.getByText('Continue', { exact: true }).click();
        await waitFor(async () => {
            try { return await page.evaluate(previous => JSON.parse(localStorage.getItem('auth_credentials') || 'null')?.token !== previous, relayBToken); }
            catch { return false; }
        }, 'App finishes authenticating back on the original relay');
        await waitFor(async () => {
            try { return await page.getByRole('textbox').inputValue() === oldUrl; } catch { return false; }
        }, 'switch back to the original relay');
        await page.goto(`${webOrigin}/session/${ready.sessionId}`);
        await page.getByRole('textbox').fill('back-on-original-relay');
        await page.getByRole('textbox').press('Enter');
        await waitFor(() => messages.some(message => message.kind === 'user' && message.text === 'back-on-original-relay' && message.serverUrl === oldUrl), 'prompt after switching back');
        await page.getByText('fixture-reply:back-on-original-relay', { exact: true }).waitFor();
        assert.equal(messages.filter(message => message.kind === 'user' && message.text === 'message-before-switch').length, 1);
        assert.equal(messages.filter(message => message.kind === 'user' && message.text === 'message-after-switch').length, 1);
        checks.push('Switching back keeps the same session and does not replay old prompts');
        await page.screenshot({ path: path.join(artifacts, 'switched-back.png') });

        fixtureProcess.send('enable-failure');
        await waitFor(() => messages.some(message => message.kind === 'failure-ready'), 'rollback fixture');
        await page.goto(`${webOrigin}/server`);
        await page.getByRole('textbox').fill(newUrl);
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.getByText('Continue', { exact: true }).click();
        await page.getByText(/Injected participant commit failure/).waitFor({ timeout: 60_000 });
        fixtureProcess.send('state');
        await waitFor(() => messages.filter(message => message.kind === 'state').at(-1)?.serverUrl === oldUrl, 'CLI rolled back');
        await page.goto(`${webOrigin}/session/${ready.sessionId}`);
        await page.getByText('echo permission-created-during-switch', { exact: true }).waitFor();
        await page.getByText('Yes', { exact: true }).click();
        await waitFor(() => messages.some(message => message.kind === 'permission' && message.request.id === 'permission-during-rollback' && message.serverUrl === oldUrl), 'new permission remains actionable after rollback');
        checks.push('A participant failure restores the old relay, including permissions created during the attempted switch');
        await page.screenshot({ path: path.join(artifacts, 'rollback-confirmed.png') });
        assert.deepEqual(failures, [], 'Unexpected browser, console or HTTP failures');
        console.log(JSON.stringify({ status: 'PASS', artifacts, checks }, null, 2));
    } catch (error) {
        failures.push(error.stack || String(error));
        if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
        if (page) await writeFile(path.join(artifacts, 'failure-page.txt'), await page.locator('body').ariaSnapshot()).catch(() => {});
        console.error(JSON.stringify({ status: 'FAIL', artifacts, checks, failures }, null, 2));
        process.exitCode = 1;
    } finally {
        await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ checks, failures }, null, 2));
        await browser?.close();
        if (fixtureProcess?.connected) fixtureProcess.send('stop');
        for (const child of children.reverse()) {
            if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
        }
        await rm(temporary, { recursive: true, force: true });
    }
}

if (process.argv.includes('--fixture')) await fixture();
else await main();
