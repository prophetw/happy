// With Expo Web already running on :8989:
// pnpm exec node packages/happy-app/scripts/recent-projects.e2e.mjs
// Uses an isolated PGlite relay, account, daemon fixtures and Chromium context.
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
const artifacts = path.join(repo, '.e2e-artifacts', `recent-projects-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const temporary = await mkdtemp(path.join(tmpdir(), 'happy-recent-projects-'));
const webOrigin = process.env.HAPPY_RECENT_PROJECTS_WEB_ORIGIN ?? 'http://127.0.0.1:8989';
const mobilePreview = process.env.HAPPY_RECENT_PROJECTS_MOBILE_PREVIEW === '1';
await mkdir(artifacts, { recursive: true });
const children = [];
const clients = [];
const daemons = [];
const checks = [];
const failures = [];
const spawns = [];
let browser;
let page;
let heartbeat;
async function waitFor(check, label, timeout = 45_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
}
function pass(label) { checks.push(label); console.log(`PASS: ${label}`); }
async function start(args, env, name) {
    const log = await open(path.join(artifacts, name), 'w');
    const child = spawn(process.execPath, args, { cwd: path.join(repo, 'packages/happy-server'), env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    children.push(child);
    await log.close();
    return child;
}
async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
        const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
    });
}
try {
    const allocator = createServer();
    await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
    const serverUrl = `http://127.0.0.1:${allocator.address().port}`;
    await new Promise(resolve => allocator.close(resolve));
    const env = {
        ...process.env, NODE_ENV: 'development', DB_PROVIDER: 'pglite', DATA_DIR: temporary,
        PGLITE_DIR: path.join(temporary, 'pglite'), HANDY_MASTER_SECRET: randomBytes(32).toString('hex'),
        HOST: '127.0.0.1', PORT: new URL(serverUrl).port, PUBLIC_URL: serverUrl, REDIS_URL: '', S3_HOST: '',
        HAPPY_ALLOWED_ACCOUNT_IDS: '*', METRICS_ENABLED: 'false', GITHUB_CLIENT_ID: '', GITHUB_APP_ID: '',
    };
    console.log('Starting isolated recent-project fixture...');
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
    const { ApiClient, configuration } = await import('../../happy-cli/dist/lib.mjs');
    const api = await ApiClient.create({ token, encryption: { type: 'legacy', secret } });
    const machines = [];
    async function createSession(machine, directory, title, extra = {}, connect = true) {
        const session = await api.getOrCreateSession({ tag: randomUUID(), metadata: {
            path: directory, host: machine.metadata.host, homeDir: machine.metadata.homeDir,
            machineId: machine.id, flavor: 'claude', summary: { text: title, updatedAt: Date.now() }, ...extra,
        }, state: { controlledByUser: false, requests: {} } });
        assert.ok(session);
        if (connect) clients.push(api.sessionSyncClient(session));
        return session;
    }
    for (const [name, platform] of [['Web Linux', 'linux'], ['Web Windows', 'win32'], ['Web Offline', 'linux']]) {
        const machine = await api.getOrCreateMachine({ machineId: randomUUID(), metadata: {
            host: name, displayName: name, platform, happyCliVersion: configuration.currentCliVersion,
            homeDir: platform === 'win32' ? 'C:\\Users\\tester' : '/home/tester',
            happyHomeDir: path.join(temporary, 'cli'),
            cliAvailability: { claude: true, codex: false, gemini: false, openclaw: false, detectedAt: Date.now() },
        } });
        machines.push(machine);
        if (name === 'Web Offline') continue;
        const daemon = api.machineSyncClient(machine);
        daemon.setRPCHandlers({
            spawnSession: async ({ directory }) => {
                const session = await createSession(machine, directory, 'Created from project search');
                spawns.push({ machineId: machine.id, directory, sessionId: session.id });
                return { type: 'success', sessionId: session.id };
            },
            stopSession: () => true, requestShutdown() {},
        });
        daemon.rpcHandlerManager.registerHandler('bash', async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }));
        daemon.rpcHandlerManager.registerHandler('listDirectory', async () => ({ success: true, entries: [] }));
        daemon.connect();
        daemons.push(daemon);
    }
    await waitFor(() => daemons.every(daemon => daemon.isReady()), 'fixture daemons');
    const initial = [];
    for (const [index, directory] of ['/code/happy', 'D:\\code\\happy', '/offline/happy'].entries()) {
        initial.push(await createSession(machines[index], directory, `Existing happy on ${machines[index].metadata.host}`));
    }
    for (const copy of ['copy-one', 'copy-two', 'copy-three']) {
        initial.push(await createSession(machines[0], `/${copy}/happy`, `Existing happy in ${copy}`));
    }
    const archived = await createSession(machines[0], '/code/archived-project', 'Project to archive');
    const archivedClient = clients.at(-1);
    await waitFor(() => clients.every(client => client.socket.connected), 'fixture session connections');
    heartbeat = setInterval(() => clients.forEach(client => client.keepAlive(false, 'remote')), 2000);
    clients.forEach(client => client.keepAlive(false, 'remote'));

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', colorScheme: 'dark' });
    await context.addInitScript(({ serverUrl, token, secret }) => {
        if (!location.protocol.startsWith('http')) return;
        window.__HAPPY_CONFIG__ = { serverUrl, disableAnalytics: true };
        localStorage.setItem('auth_credentials', JSON.stringify({ token, secret }));
        const key = 'mmkv.default' + String.fromCharCode(92) + 'settings';
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { preferredLanguage: 'zh-Hans', sessionListGrouping: 'project' }, version: null }));
    }, { serverUrl, token, secret: Buffer.from(secret).toString('base64') });
    page = await context.newPage();
    page.on('pageerror', error => failures.push(`Page: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') failures.push(`Console: ${message.text()}`); });
    page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });
    page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') failures.push(`Request: ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`); });
    await page.goto(`${webOrigin}/new`, { waitUntil: 'domcontentloaded' });
    const search = page.getByRole('combobox');
    await search.waitFor({ timeout: 60_000 });
    await search.fill('happy');
    const rows = page.getByTestId('project-search-result');
    await waitFor(async () => await rows.count() === 6, 'all six projects across three machines in search');
    for (const name of ['Web Linux', 'Web Windows', 'Web Offline']) {
        assert.equal(await rows.filter({ hasText: name }).count(), name === 'Web Linux' ? 4 : 1, `${name} has named results`);
    }
    await page.screenshot({ path: path.join(artifacts, 'cross-machine-search.png') });
    await writeFile(path.join(artifacts, 'initial-page.txt'), await page.locator('body').innerText());
    pass('Searching happy shows distinct Linux, Windows and offline-machine projects');

    const lowerRow = rows.nth(4);
    const hitTest = await lowerRow.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        const ancestors = node => {
            const result = [];
            for (; node instanceof HTMLElement && result.length < 7; node = node.parentElement) {
                const css = getComputedStyle(node);
                const bounds = node.getBoundingClientRect();
                result.push({ role: node.getAttribute('role'), testId: node.getAttribute('data-testid'), position: css.position,
                    zIndex: css.zIndex, flex: css.flex, pointerEvents: css.pointerEvents,
                    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } });
            }
            return result;
        };
        return { matches: element.contains(hit), point: { x, y }, hit: ancestors(hit), expected: ancestors(element) };
    });
    await writeFile(path.join(artifacts, 'lower-row-hit-test.json'), JSON.stringify(hitTest, null, 2));
    assert.equal(hitTest.matches, true, 'The fifth visible project receives the mouse hit instead of content below the dropdown');
    await lowerRow.hover({ timeout: 3000 });
    assert.equal(await lowerRow.evaluate(element => getComputedStyle(element).cursor), 'pointer');
    const selectedPath = (await lowerRow.getAttribute('aria-label')).split(', ').at(-1);
    await page.screenshot({ path: path.join(artifacts, 'lower-row-hover.png') });
    await lowerRow.click({ timeout: 3000 });
    assert.equal(await rows.count(), 0, 'Clicking the fifth row selects it and closes the dropdown');
    assert.equal(await page.evaluate(() => {
        const key = 'mmkv.default' + String.fromCharCode(92) + 'new-session-draft-v1';
        return JSON.parse(localStorage.getItem(key)).selectedPath;
    }), selectedPath, 'The fifth row applies its actual directory to the draft');
    pass('The fifth project below the configuration card receives hover and mouse selection');

    const composer = page.getByPlaceholder('What would you like to work on?');
    await composer.fill('keep this task');
    await search.fill('happy');
    await rows.filter({ hasText: 'Web Offline' }).click();
    assert.equal(await composer.inputValue(), 'keep this task');
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    pass('Offline project remains selectable, preserves the task text and cannot start');

    await search.fill('D:\\code\\happy');
    await waitFor(async () => await rows.count() === 1, 'Windows path match');
    await search.press('Enter');
    assert.equal(await composer.inputValue(), 'keep this task');
    assert.equal(await rows.count(), 0);
    await composer.fill('');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await waitFor(() => spawns.length === 1, 'session spawn');
    await page.waitForURL(`**/session/${spawns[0].sessionId}`, { timeout: 45_000 });
    assert.equal(spawns[0].machineId, machines[1].id);
    assert.equal(spawns[0].directory, 'D:\\code\\happy');
    pass('Keyboard selection creates a real session on the selected Windows machine and directory');

    archivedClient.updateMetadata(metadata => ({ ...metadata, lifecycleState: 'archived' }));
    await waitFor(() => archivedClient.getMetadata()?.lifecycleState === 'archived', 'archive metadata acknowledgement');
    await page.goto(`${webOrigin}/new`, { waitUntil: 'domcontentloaded' });
    await search.waitFor();
    await search.fill('archived-project');
    await waitFor(async () => await rows.count() === 1, 'archived project retained');
    pass('Archiving the final chat retains the project in search');

    if (mobilePreview) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${webOrigin}/dev/project-search`, { waitUntil: 'domcontentloaded' });
        const mobileSearch = page.getByRole('textbox', { name: '搜索项目或目录', exact: true });
        await mobileSearch.waitFor();
        await mobileSearch.fill('happy');
        const mobileRows = page.getByTestId('directory-project-result');
        await waitFor(async () => await mobileRows.count() === 6, 'all projects in shared iOS sheet content');
        await page.screenshot({ path: path.join(artifacts, 'ios-project-search-preview.png') });
        await mobileRows.filter({ hasText: 'Web Linux' }).first().click();
        const selected = page.getByTestId('selected-project-preview');
        await waitFor(async () => (await selected.innerText()).includes('Web Linux'), 'mobile picker applies the chosen machine');
        await page.getByRole('button', { name: '所有机器', exact: true }).click();
        await mobileSearch.fill('D:\\code\\happy');
        await waitFor(async () => await mobileRows.count() === 1, 'Windows path in shared mobile picker');
        await mobileRows.click();
        await waitFor(async () => (await selected.innerText()).includes('D:\\code\\happy') && (await selected.innerText()).includes('Web Windows'), 'mobile picker switches computer and directory together');
        await page.screenshot({ path: path.join(artifacts, 'ios-project-selected-preview.png') });
        pass('At phone width, shared iOS sheet content searches all machines and applies the actual computer and path');
        await page.getByRole('button', { name: '所有机器', exact: true }).click();
        await page.getByRole('button', { name: '输入自定义路径', exact: true }).click();
        await page.getByRole('textbox', { name: '输入自定义路径', exact: true }).fill('D:\\not-applied');
        await page.getByRole('button', { name: '取消', exact: true }).last().click();
        assert.ok((await selected.innerText()).includes('D:\\code\\happy'), 'Canceling manual entry preserves the selected path');
        await page.getByRole('button', { name: '所有机器', exact: true }).click();
        await page.getByRole('button', { name: '输入自定义路径', exact: true }).click();
        await page.getByRole('textbox', { name: '输入自定义路径', exact: true }).fill('D:\\manual\\project');
        await page.getByRole('button', { name: '使用此目录', exact: true }).click();
        await waitFor(async () => (await selected.innerText()).includes('D:\\manual\\project'), 'manual path applied from the same sheet');
        pass('The shared iOS picker cancels unconfirmed manual paths and applies confirmed paths without opening a second modal');
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(`${webOrigin}/new`, { waitUntil: 'domcontentloaded' });
    }

    // Reproduce the real 150-session list limit without polluting project history with the filler.
    clearInterval(heartbeat);
    await Promise.all(clients.map(client => client.close()));
    clients.length = 0;
    for (let index = 0; index < 150; index++) {
        await createSession(machines[0], '/noise', `Hidden list-limit fixture ${index}`, { isSideChat: true }, false);
    }
    const snapshotResponse = await fetch(`${serverUrl}/v1/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.sessions.length, 150);
    const oldIds = new Set([...initial.map(session => session.id), archived.id]);
    assert.equal(snapshot.sessions.some(session => oldIds.has(session.id)), false, 'Original project sessions are outside the 150-record response');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await search.waitFor();
    await search.fill('happy');
    await waitFor(async () => await rows.count() === 6, 'saved projects after reload beyond the session limit');
    await page.screenshot({ path: path.join(artifacts, 'history-after-reload.png') });
    await search.fill('archived-project');
    await waitFor(async () => await rows.count() === 1, 'archived project after reload');
    pass('After reload, saved projects survive even when all their chats are outside the latest 150 sessions');
    assert.deepEqual(failures, [], 'Browser, console, HTTP and request errors');
    pass('No page errors, console errors, unexpected HTTP errors or failed requests');
} catch (error) {
    failures.push(error.stack ?? String(error));
    if (page) {
        await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
        await writeFile(path.join(artifacts, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {});
    }
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
} finally {
    clearInterval(heartbeat);
    await browser?.close();
    await Promise.all(clients.map(client => client.close()));
    daemons.forEach(daemon => daemon.shutdown());
    for (const child of children.reverse()) await stop(child);
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: failures.length ? 'FAILED' : 'PASS', mobilePreview, checks, spawns, failures }, null, 2));
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    console.log(`Artifacts: ${path.relative(repo, artifacts)}`);
}
