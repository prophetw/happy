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
const native = process.env.HAPPY_CODEBUDDY_NATIVE === '1';
const nativeCommand = "printf 'HAPPY_NATIVE_OUT\\n'; printf 'HAPPY_NATIVE_ERR\\n' >&2";
const nativeDescription = 'Happy native Bash probe';
const nativePrompt = `Call Bash exactly once with this read-only command and the description "${nativeDescription}".\n${nativeCommand}\nThen report briefly. Do not run other shell commands.`;
const fixtureCommand = `printf '%s\\n' 'FIXTURE_LONG_COMMAND${'1234567890'.repeat(8)}'\nprintf '%s\\n' 'second line'`;
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
    if (!native) {
        await copyFile(new URL('./fixtures/codebuddy-acp.cjs', import.meta.url), join(bin, 'codebuddy'));
        await chmod(join(bin, 'codebuddy'), 0o755);
    }
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
    if (native) {
        await waitFor(async () => {
            const response = await fetch(serverUrl + '/v1/machines', { headers });
            assert.ok(response.ok);
            const machine = (await response.json()).find(machine => machine.id === machineId);
            return machine?.metadata && decrypt(machine.metadata).codebuddyOptions?.models.length > 0;
        }, 'native CodeBuddy catalog');
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
    if (!native) {
        await page.getByText('Always Ask', { exact: true }).click();
        await page.getByText('Bypass Permissions', { exact: true }).click();
        await page.getByText('Default model', { exact: true }).click();
        await page.getByText('Fixture model', { exact: true }).click();
    }
    await page.getByPlaceholder('What would you like to work on?').fill(native ? nativePrompt : 'ACP_FIRST');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForURL('**/session/*', { timeout: 60_000 });
    const sessionId = new URL(page.url()).pathname.split('/').pop();
    const rowsResponse = await fetch(serverUrl + '/v1/sessions', { headers });
    const rows = (await rowsResponse.json()).sessions;
    const metadata = decrypt(rows.find(row => row.id === sessionId).metadata);
    assert.equal(metadata.machineId, machineId);
    assert.equal(metadata.path, checkout);
    assert.equal(metadata.flavor, 'codebuddy');
    if (!native) {
        assert.equal(metadata.currentModelCode, 'fixture-model');
        assert.equal(metadata.currentOperatingModeCode, 'bypassPermissions');
    }

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

    const line = command => page.locator('[tabindex="0"]').getByText(command, { exact: true });
    async function openTool(command) {
        await line(command).click({ timeout: 15_000 });
        await page.waitForURL('**/session/*/message/*');
    }
    async function openActivity(text) {
        await page.locator('[tabindex="0"]').filter({ hasText: text }).first().click({ timeout: 15_000 });
        await page.waitForURL('**/session/*/message/*');
    }
    const terminal = text => page.getByTestId('terminal-syntax-ready').filter({ hasText: text });
    async function assertNarrow() {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }

    async function verifyNativeTool() {
        async function agentState() {
            const active = await fetch(serverUrl + '/v1/sessions', { headers });
            assert.ok(active.ok);
            const row = (await active.json()).sessions.find(row => row.id === sessionId);
            return decrypt(row.agentState);
        }
        const approval = page.getByText('Yes', { exact: true });
        await approval.waitFor({ timeout: 90_000 });
        const requests = Object.entries((await agentState()).requests);
        assert.equal(requests.length, 1, 'approve only the requested read-only Bash call');
        const [call, request] = requests[0];
        assert.equal(request.tool, 'Bash');
        assert.equal(request.arguments.command, nativeCommand);
        assert.equal(request.arguments.description, nativeDescription);
        await line(nativeCommand).waitFor({ timeout: 15_000 });
        await approval.click();
        // The model can still ask permission for the separate automatic-title tool.
        // Verify the execution event for this Bash call even while the turn is open.
        await waitFor(async () => (await events()).some(ev => ev.call === call && ev.t === 'tool-call-end'), 'native Bash completion');
        const recorded = (await events()).filter(ev => ev.call === call);
        assert.equal(recorded.filter(ev => ev.t === 'tool-call-start').length, 1);
        assert.deepEqual(recorded.filter(ev => ev.t === 'tool-call-end').map(ev => ev.isError), [false]);
        assert.ok(recorded.some(ev => ev.args?.command === nativeCommand));
        const output = recorded.find(ev => ev.terminal?.output)?.terminal;
        assert.match(output?.output ?? '', /HAPPY_NATIVE_OUT[\r\n]+HAPPY_NATIVE_ERR/);
        assert.equal(output.exitCode, 0);
        assert.equal(output.stdout, undefined);
        assert.equal(output.stderr, undefined);
        await waitFor(async () => (await agentState()).completedRequests?.[call]?.status === 'approved', 'persisted Bash approval');

        // Reload the actual conversation to verify reconstruction from relay records.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(webOrigin + '/session/' + sessionId, { waitUntil: 'domcontentloaded' });
        const workGroup = page.getByText(/^Worked /).first();
        await line(nativeCommand).or(workGroup).first().waitFor({ timeout: 30_000 });
        if (!(await line(nativeCommand).isVisible())) await workGroup.click();
        await line(nativeCommand).waitFor();
        const bashRow = line(nativeCommand).locator('xpath=ancestor::*[@tabindex="0"][1]/..');
        await bashRow.getByText('Yes', { exact: true }).locator('xpath=ancestor::*[@aria-disabled="true"][1]').waitFor();
        await assertNarrow();
        await page.screenshot({ path: join(artifacts, 'native-bash-row.png') });
        await openTool(nativeCommand);
        await page.getByText('Input Parameters', { exact: true }).waitFor();
        await page.getByText(/"description": "Happy native Bash probe"/).waitFor();
        const renderedOutput = terminal(/Stdout: HAPPY_NATIVE_OUT/);
        await renderedOutput.waitFor();
        assert.match(await renderedOutput.textContent(), /HAPPY_NATIVE_OUT[\r\n]+HAPPY_NATIVE_ERR/);
        await page.getByText('Exit code 0', { exact: true }).waitFor();
        await assertNarrow();
        await page.screenshot({ path: join(artifacts, 'native-bash-detail.png') });
        const afterClick = (await events()).filter(ev => ev.args?.command === nativeCommand);
        assert.deepEqual([...new Set(afterClick.map(ev => ev.call))], [call], 'opening the detail never calls the tool again');
    }

    async function verifyFixture() {

        await page.getByText('Streaming fixture', { exact: true }).waitFor();
        assert.deepEqual(await statuses(), []);
        const traceBeforeFirstReply = await observed();
        const probeEvents = traceBeforeFirstReply.filter(ev => ev.probe);
        assert.ok(probeEvents.some(ev => ev.event === 'new'));
        assert.ok(probeEvents.every(ev => ev.event !== 'prompt' && ev.event !== 'configure'));
        const first = traceBeforeFirstReply.filter(ev => !ev.probe);
        assert.deepEqual(first.find(ev => ev.event === 'start').args, ['--acp', '--permission-mode', 'default']);
        assert.equal(first.find(ev => ev.event === 'new').requestedCwd, checkout);
        const firstPrompt = first.find(ev => ev.event === 'prompt');
        assert.ok(firstPrompt.text.startsWith('ACP_FIRST'));
        assert.equal(firstPrompt.model, 'fixture-model');
        assert.equal(firstPrompt.mode, 'bypassPermissions');
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

        await page.setViewportSize({ width: 390, height: 844 });
        await send('ACP_PARTIAL');
        await checkStatuses(['completed', 'failed', 'cancelled', 'completed', 'completed', 'completed', 'partial']);
        await page.getByText('Partial content preserved', { exact: true }).waitFor();
        const latest = page.getByRole('button', { name: '滚动到最新消息' });
        if (await latest.isVisible()) await latest.click();
        await page.getByText(/CodeBuddy partially completed the turn \(PARTIAL_SUCCESS\)/).first().waitFor();
        assert.match(await page.locator('body').innerText(), /two reads finished; one tool failed; token=\[REDACTED\]/);
        assert.ok(!(await page.locator('body').innerText()).includes('two reads finished; one tool failed; token=fixture123'));
        assert.equal((await observed()).filter(ev => ev.event === 'prompt' && ev.text.includes('ACP_PARTIAL')).length, 1);
        await assertNarrow();
        await page.screenshot({ path: join(artifacts, 'fixture-partial.png') });

        await send('ACP_TOOLS');
        await openTool('false');
        await terminal('FIXTURE_FAILURE_OUTPUT').waitFor();
        await page.getByText('stderr', { exact: true }).waitFor();
        await page.getByText('Exit code 7', { exact: true }).waitFor();
        assert.equal(await terminal('FIXTURE_FIRST_OUTPUT').count(), 0);
        await assertNarrow();
        await page.screenshot({ path: join(artifacts, 'fixture-bash-failure.png') });

        await page.goBack();
        await line(fixtureCommand).waitFor();
        assert.equal(await line(fixtureCommand).evaluate(node => {
            const style = getComputedStyle(node);
            return style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth;
        }), true, 'the long command truncates to one line at 390px');
        await assertNarrow();
        await page.screenshot({ path: join(artifacts, 'fixture-bash-row.png') });
        await openTool(fixtureCommand);
        const command = terminal('FIXTURE_LONG_COMMAND');
        await command.waitFor();
        assert.equal(await command.textContent(), fixtureCommand);
        assert.equal(await command.evaluate(node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const right = node.getBoundingClientRect().right;
            return [...range.getClientRects()].every(rect => rect.right <= right + 1);
        }), true, 'the full command is legible inside the terminal at 390px');
        await page.getByText(new RegExp('"cwd":')).first().waitFor();
        assert.ok((await page.getByText(new RegExp('"cwd":')).first().textContent()).includes(checkout));
        await terminal('FIXTURE_FIRST_OUTPUT').waitFor();
        assert.equal(await terminal('FIXTURE_FAILURE_OUTPUT').count(), 0);
        assert.equal(await terminal('argument JSON fragment').count(), 0);
        assert.equal(await terminal('FIXTURE_LATE_OUTPUT').count(), 0);
        await writeFile(trace + '.tools-finish', '');
        await checkStatuses(['completed', 'failed', 'cancelled', 'completed', 'completed', 'completed', 'partial', 'completed']);
        await writeFile(trace + '.tools-late', '');
        const output = terminal('FIXTURE_LATE_OUTPUT');
        await output.waitFor();
        assert.equal(await output.textContent(), 'FIXTURE_FIRST_OUTPUT\nFIXTURE_LATE_OUTPUT\n');
        await page.getByText('Exit code 0', { exact: true }).waitFor();
        await assertNarrow();
        await page.screenshot({ path: join(artifacts, 'fixture-bash-detail.png') });
        const toolEvents = (await events()).filter(ev => ev.call?.startsWith('fixture-bash-'));
        assert.deepEqual(toolEvents.filter(ev => ev.t === 'tool-call-start').map(ev => ev.call), ['fixture-bash-a', 'fixture-bash-b']);
        assert.ok(toolEvents.some(ev => ev.call === 'fixture-bash-b' && ev.t === 'tool-call-end' && ev.isError === true));
        await waitFor(async () => (await events()).filter(ev => ev.t === 'tool-call-update' && ev.call === 'fixture-bash-a'
            && ev.terminal?.stdout?.includes('FIXTURE_LATE_OUTPUT')).length === 2, 'duplicate late output records');

        const eventSnapshot = await events();
        const traceSnapshot = await observed();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await terminal('FIXTURE_LATE_OUTPUT').waitFor();
        await page.getByText('Exit code 0', { exact: true }).waitFor();
        await assertNarrow();
        await page.screenshot({ path: join(artifacts, 'fixture-bash-refresh.png') });

        await page.goBack();
        await openActivity('README.md');
        await page.getByText('FIXTURE_READ_OUTPUT', { exact: false }).first().waitFor();
        await page.getByText(/"file_path"/).first().waitFor();
        await assertNarrow();
        await page.goBack();

        await openActivity('fixture-query');
        await page.getByText('FIXTURE_GREP_OUTPUT', { exact: false }).first().waitFor();
        await page.getByText(/"include": "\*\.ts"/).first().waitFor();
        await assertNarrow();
        await page.goBack();

        await openActivity('src/example.ts');
        await page.getByText('before fixture', { exact: false }).filter({ visible: true }).first().waitFor();
        await page.getByText('after fixture', { exact: false }).filter({ visible: true }).first().waitFor();
        await assertNarrow();
        await page.screenshot({ path: join(artifacts, 'fixture-edit-detail.png') });
        await page.goBack();

        await openActivity('mcp-query');
        await page.getByText('FIXTURE_MCP_OUTPUT', { exact: false }).first().waitFor();
        await page.getByText(/"scope": "workspace"/).first().waitFor();
        await assertNarrow();
        await page.goBack();

        await openActivity('preview');
        await page.getByText(/FIXTURE_CUSTOM_FAILURE token=\[REDACTED\]/).first().waitFor();
        assert.ok(!(await page.locator('body').innerText()).includes('FIXTURE_CUSTOM_FAILURE token=fixture123'));
        await assertNarrow();
        await page.screenshot({ path: join(artifacts, 'fixture-custom-failure.png') });

        assert.deepEqual(await events(), eventSnapshot, 'refresh and detail navigation must not append tool or turn events');
        assert.deepEqual(await observed(), traceSnapshot, 'refresh and detail navigation must not execute prompts or tools');
        assert.deepEqual(traceSnapshot.filter(ev => ev.event === 'prompt').map(ev => ev.count), [1, 2, 3, 4, 5, 6, 7, 8]);
    }

    if (native) await verifyNativeTool();
    else await verifyFixture();
    assert.deepEqual(errors, []);
    console.log(native
        ? 'PASS: native CodeBuddy Bash approval, persisted call ID, merged output, exit code and read-only narrow detail'
        : 'PASS: ACP lifecycle, partial outcome, concurrent Bash, non-Bash details, narrow layout and side-effect-free refresh');
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
