// Run from the repo root after exporting Expo web and generating Prisma.
// TSX_TSCONFIG_PATH=packages/happy-cli/tsconfig.json node --import tsx packages/happy-app/scripts/hosted-dot-chat.e2e.mjs <web-export>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
assert(process.argv[2], 'Pass the path to a local Expo web export');
const web = resolve(process.argv[2]);
await readFile(join(web, 'index.html'));
const temporary = await mkdtemp(join(tmpdir(), 'happy-dot-chat-'));
const evidence = join(root, '.e2e-artifacts', `dot-chat-${Date.now()}`);
await mkdir(evidence, { recursive: true });
console.log(`Fixture evidence: ${evidence}`);
const baseEnv = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8' };
const children = [];
const controller = new AbortController();
const browserErrors = [];
const badResponses = [];
const modelCalls = [];
const modelErrors = [];
let chromiumBrowser, running, releaseHeldResponse;

const digest = text => ({
    sha256: createHash('sha256').update(text).digest('hex'),
    utf8Bytes: Buffer.byteLength(text), utf16Units: text.length,
    head: text.slice(0, 24), tail: text.slice(-24),
});
const textCase = (name, text) => `[DOT-TEST:${name}]\n${text}\n[END:${name}]`;
const identify = text => /^\[DOT-TEST:([a-z-]+)\]/.exec(text)?.[1];
const syntheticLine = '今天整理旧照片和读书笔记，明天去公园散步。';
const model = createServer(async (req, res) => {
    try {
        if (req.url !== '/v1/responses' || req.method !== 'POST') {
            res.writeHead(404).end(); return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        const userInputs = body.input.filter(item => item.role === 'user')
            .flatMap(item => item.content.filter(part => part.type === 'input_text').map(part => part.text));
        const latest = userInputs.findLast(text => identify(text));
        const tag = identify(latest ?? '');
        assert(tag, 'Model request carried a synthetic input');
        modelCalls.push({ tag, ...digest(latest) });
        if (tag === 'context-limit') {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                error: { message: 'The input exceeds the context window', type: 'invalid_request_error', code: 'context_length_exceeded' },
            }));
            return;
        }
        const id = `response_${modelCalls.length}`;
        const response = { id, object: 'response', status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 8, total_tokens: 108 } };
        const item = { id: `message_${modelCalls.length}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
        const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        send('response.created', { response: { ...response, status: 'in_progress' } });
        if (tag === 'hold-for-steer') await new Promise(done => { releaseHeldResponse = done; });
        send('response.output_item.added', { output_index: 0, item });
        const text = `fixture received ${tag}`;
        send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
        const complete = { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        send('response.output_item.done', { output_index: 0, item: complete });
        send('response.completed', { response: { ...response, output: [complete] } });
        res.end();
    } catch (error) {
        modelErrors.push(error.message);
        if (!res.headersSent) res.writeHead(500);
        res.end();
    }
});

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}
async function waitFor(check, label, timeout = 45_000) {
    const deadline = Date.now() + timeout;
    do {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
}
async function relayProcess(mode, env) {
    const log = await open(join(evidence, `relay-${mode}.log`), 'w');
    try {
        const child = spawn(process.execPath, ['--import', 'tsx', 'sources/standalone.ts', mode], {
            cwd: join(root, 'packages/happy-server'), env, stdio: ['ignore', log.fd, log.fd],
        });
        children.push(child);
        return child;
    } finally {
        await log.close();
    }
}

try {
    const modelPort = await listen(model);
    const portFinder = createServer();
    const relayPort = await listen(portFinder);
    await new Promise(done => portFinder.close(done));
    const serverUrl = `http://127.0.0.1:${relayPort}`;
    const env = {
        ...baseEnv, NODE_ENV: 'development', DB_PROVIDER: 'pglite', PGLITE_DIR: join(temporary, 'db'),
        DATA_DIR: temporary, HANDY_MASTER_SECRET: randomBytes(32).toString('hex'),
        HOST: '127.0.0.1', PORT: String(relayPort), PUBLIC_URL: serverUrl,
        HAPPY_STATIC_DIR: web, HAPPY_INJECT_HTML_CONFIG: JSON.stringify({ serverUrl, disableAnalytics: true }),
        HAPPY_ALLOWED_ACCOUNT_IDS: '*', METRICS_ENABLED: 'false',
    };
    assert.equal((await once(await relayProcess('migrate', env), 'exit'))[0], 0, 'Temporary Prisma migrations');
    const relay = await relayProcess('serve', env);
    await waitFor(async () => {
        assert.equal(relay.exitCode, null, 'Isolated Relay exited');
        try { return (await fetch(`${serverUrl}/health`)).ok; } catch { return false; }
    }, 'isolated Relay');

    process.env.HAPPY_HOME_DIR = join(temporary, 'happy');
    process.env.HAPPY_SERVER_URL = serverUrl;
    const { ApiClient } = await import('../../happy-cli/src/api/api.ts');
    const { authChallenge, decodeBase64, decrypt, encodeBase64, encrypt, libsodiumPublicKeyFromSecretKey } = await import('../../happy-cli/src/api/encryption.ts');
    const { deriveKey } = await import('../../happy-cli/src/utils/deriveKey.ts');
    const { runHostedDot } = await import('../../happy-cli/src/codex/hostedDotMain.ts');
    const secret = new Uint8Array(randomBytes(32));
    const auth = authChallenge(secret);
    const login = await fetch(`${serverUrl}/v1/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(Object.entries(auth).map(([name, value]) => [name, encodeBase64(value)]))),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const api = await ApiClient.create({ token, encryption: { type: 'dataKey',
        publicKey: libsodiumPublicKeyFromSecretKey(await deriveKey(secret, 'Happy EnCoder', ['content'])), machineKey: randomBytes(32),
    } }, { serverUrl });
    const workspaceId = randomUUID(), dotId = randomUUID(), tag = `testloop-dot:${workspaceId}:${dotId}`;
    const workspace = await api.getOrCreateSession({
        tag: `testloop-dots:${workspaceId}`,
        metadata: { path: temporary, host: 'fixture', summary: { text: 'Dot fixture workspace', updatedAt: Date.now() },
            testloopDots: { schemaVersion: 1, kind: 'workspace', workspaceId } },
        state: { controlledByUser: false, requests: {} },
    });
    const dot = await api.getOrCreateSession({
        tag,
        metadata: { path: temporary, host: 'fixture', flavor: 'codex', summary: { text: '长消息验收 Dot', updatedAt: Date.now() },
            testloopDots: { schemaVersion: 1, kind: 'dot', workspaceId, workspaceSessionId: workspace.id, dotId } },
        state: { controlledByUser: false, requests: {} },
    });
    assert(dot);
    const happyHome = process.env.HAPPY_HOME_DIR;
    await mkdir(happyHome, { recursive: true, mode: 0o700 });
    await writeFile(join(happyHome, 'access.key'), JSON.stringify({ token, serverUrl }), { mode: 0o600 });
    await writeFile(join(happyHome, 'sessions.json'), JSON.stringify({ sessions: {
        [dot.id]: { encryptionVariant: 'dataKey', encryptionKey: encodeBase64(dot.encryptionKey) },
    } }), { mode: 0o600 });
    const config = {
        version: 1, dotId, sessionId: dot.id, happyHome, serverUrl, directory: join(temporary, 'runtime'),
        codexHome: join(temporary, 'codex'), executable: 'codex', args: [],
        model: 'gpt-6.2-sol', effort: 'high', provider: 'fixture', instruction: 'Isolated conversation test.',
        providerConfig: { 'model_providers.fixture.name': 'Fixture', 'model_providers.fixture.base_url': `http://127.0.0.1:${modelPort}/v1`,
            'model_providers.fixture.wire_api': 'responses', 'model_providers.fixture.requires_openai_auth': false },
    };
    await mkdir(config.directory, { mode: 0o700 });
    await writeFile(join(config.directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const state = () => readFile(join(config.directory, 'state.json'), 'utf8').then(JSON.parse);
    let hostedError;
    running = runHostedDot(config, controller.signal).catch(error => { hostedError = error; });
    await waitFor(async () => {
        if (hostedError) throw hostedError;
        return (await state().catch(() => null))?.status === 'ready';
    }, 'Hosted Dot runtime');

    const messagesPath = `/v3/sessions/${dot.id}/messages`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    async function postFixture(localId, message) {
        const response = await fetch(serverUrl + messagesPath, { method: 'POST', headers, body: JSON.stringify({
            messages: [{ localId, content: encodeBase64(encrypt(dot.encryptionKey, 'dataKey', message)) }],
        }) });
        assert.equal(response.status, 200);
    }
    const getMessages = async (query = '') => {
        const response = await fetch(`${serverUrl}${messagesPath}${query}`, { headers });
        assert.equal(response.status, 200);
        return response.json();
    };
    await postFixture('legacy:input-rejected:347', {
        role: 'session', content: { type: 'session', data: { id: 'input-rejected:347', time: Date.now(), role: 'agent',
            ev: { t: 'service', text: '这条消息超过12000字符，请拆分后发送。' } } },
    });

    chromiumBrowser = await chromium.launch({ headless: true });
    const context = await chromiumBrowser.newContext({ locale: 'zh-CN', viewport: { width: 870, height: 920 } });
    await context.addInitScript(({ secret, token }) => {
        localStorage.setItem('auth_credentials', JSON.stringify({ secret, token }));
        const prefix = 'mmkv.default' + String.fromCharCode(92, 92);
        localStorage.setItem(prefix + 'settings', JSON.stringify({ settings: { preferredLanguage: 'zh-Hans', agentInputEnterToSend: true }, version: null }));
    }, { secret: encodeBase64(secret), token });
    // The test has only temporary credentials. Block external browser requests.
    await context.route('**/*', route => new URL(route.request().url()).origin === serverUrl ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', entry => {
        const isExpectedProxyError = entry.location().url === serverUrl + messagesPath
            && /^Failed to load resource:.*status of 413\b/.test(entry.text());
        if (entry.type() === 'error' && !isExpectedProxyError) browserErrors.push(entry.text().slice(0, 300));
    });
    page.on('response', response => {
        if (response.status() >= 400 && new URL(response.url()).origin === serverUrl) {
            badResponses.push({ status: response.status(), path: new URL(response.url()).pathname });
        }
    });
    await page.goto(`${serverUrl}/session/${dot.id}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('testloop-dot-header').waitFor();
    const composer = page.locator('textarea:visible');
    const legacy = page.getByText(/12,000 个 UTF-16 码元/);
    await legacy.waitFor();
    async function visibleNotice(locator, label, timeout = 15_000) {
        await locator.waitFor({ timeout });
        await waitFor(() => locator.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            if (bounds.top < 0 || bounds.bottom > innerHeight) return false;
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                if (getComputedStyle(parent).overflowY === 'visible') continue;
                const clip = parent.getBoundingClientRect();
                if (bounds.top < clip.top || bounds.bottom > clip.bottom) return false;
            }
            return true;
        }), label, timeout);
        assert.equal(await locator.count(), 1);
    }
    async function send(text, steer = false) {
        await composer.fill(text);
        assert.equal(await composer.inputValue(), text, 'Composer value is complete');
        if (steer) await page.getByRole('button', { name: '立即发送' }).click();
        else await composer.press('Enter');
    }
    async function verifyModel(tag, text, steer = false) {
        await send(text, steer);
        await waitFor(() => modelCalls.some(call => call.tag === tag), `${tag} reaches Responses API`);
        assert.deepEqual(modelCalls.find(call => call.tag === tag), { tag, ...digest(text) });
        await page.getByText(`fixture received ${tag}`, { exact: true }).waitFor({ timeout: 45_000 });
        console.log(`PASS ${tag} ${JSON.stringify(digest(text))}`);
    }

    const exactOverLegacy = textCase('over-old', '');
    await verifyModel('over-old', textCase('over-old', 'a'.repeat(12001 - exactOverLegacy.length)));
    await verifyModel('han', textCase('han', `${syntheticLine}\n`.repeat(2500)));
    await verifyModel('ascii', textCase('ascii', '  This is ASCII with "quotes", \\ and tabs\t.\n'.repeat(1160)));
    await verifyModel('emoji', textCase('emoji', '日记🏳️‍🌈🙂👩🏽‍💻\n'.repeat(4000)));

    const holdText = textCase('hold-for-steer', 'Hold the fixture response until the steer is accepted.');
    await send(holdText);
    await waitFor(() => releaseHeldResponse, 'first model request on active turn');
    const steerText = textCase('steer', `${syntheticLine}🏳️‍🌈\n`.repeat(1800));
    await send(steerText, true);
    await waitFor(async () => (await state()).inputs.some(row => row.delivery === 'steer' && row.status === 'accepted'
        && digest(row.text).sha256 === digest(steerText).sha256), 'Hosted Dot accepted long steer');
    releaseHeldResponse();
    await waitFor(() => modelCalls.some(call => call.tag === 'steer'), 'steered text reaches Responses API');
    assert.deepEqual(modelCalls.find(call => call.tag === 'steer'), { tag: 'steer', ...digest(steerText) });
    await page.getByText('fixture received steer', { exact: true }).waitFor({ timeout: 45_000 });
    console.log(`PASS steer ${JSON.stringify(digest(steerText))}`);

    const nativeMax = textCase('native-max', 'a'.repeat(1048576 - textCase('native-max', '').length));
    await verifyModel('native-max', nativeMax);
    const tooLongTemplate = textCase('native-limit', '');
    const tooLong = textCase('native-limit', '🙂'.repeat(1048577 - tooLongTemplate.length));
    await send(tooLong);
    const native = page.getByText(/1,048,576 个 Unicode 码点/);
    await visibleNotice(native, 'native limit notice in the foreground', 45_000);
    assert(!modelCalls.some(call => call.tag === 'native-limit'));
    await page.screenshot({ path: join(evidence, 'native-limit.png') });
    const browserSocket = page.waitForEvent('websocket');
    await context.setOffline(true);
    await context.setOffline(false);
    await browserSocket;
    await visibleNotice(native, 'native limit notice after reconnect');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await visibleNotice(native, 'native limit notice after reload', 45_000);
    console.log('PASS native limit receipt, socket reconnect, refresh and deduplication');

    const contextText = textCase('context-limit', syntheticLine.repeat(400));
    await send(contextText);
    const contextFailure = page.getByText(/超出了模型的上下文容量/);
    await visibleNotice(contextFailure, 'model context notice in the foreground', 45_000);
    assert.deepEqual(modelCalls.find(call => call.tag === 'context-limit'), { tag: 'context-limit', ...digest(contextText) });
    await page.screenshot({ path: join(evidence, 'context-limit.png') });
    assert.equal(await contextFailure.count(), 1);

    const proxyText = textCase('proxy-limit', 'a'.repeat(60000));
    await page.route(serverUrl + messagesPath, route => {
        if (route.request().method() === 'POST' && route.request().postDataBuffer().length > 32 * 1024) {
            return route.fulfill({ status: 413, body: 'Fixture reverse proxy refused the request' });
        }
        return route.continue();
    });
    await send(proxyText);
    const proxyFailure = page.getByText(/Relay 拒收了这条消息/);
    await visibleNotice(proxyFailure, 'proxy rejection in the foreground');
    assert.equal(await composer.inputValue(), proxyText);
    await waitFor(async () => (await getMessages('?before_seq=2147483647')).messages.some(row => row.localId?.startsWith('relay-rejected:')), 'durable Relay rejection');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await visibleNotice(proxyFailure, 'proxy rejection after reload');
    assert.equal(await composer.inputValue(), proxyText);
    assert.equal(await contextFailure.count(), 1);
    assert(!modelCalls.some(call => call.tag === 'proxy-limit'));
    console.log('PASS proxy 413, original draft retained and one compact alert survives reload');

    const latest = (await getMessages('?before_seq=2147483647')).messages;
    const storedErrors = latest.flatMap(row => {
        const envelope = decrypt(dot.encryptionKey, 'dataKey', decodeBase64(row.content.c))?.content;
        return envelope?.ev?.kind === 'input-error' ? [{ id: envelope.id, ...envelope.ev }] : [];
    });
    assert.deepEqual(storedErrors.map(error => error.id.split(':')[0]), ['input-rejected', 'input-rejected']);
    assert(storedErrors.every(event => event.text.length < 160));
    assert.deepEqual(badResponses, [{ status: 413, path: messagesPath }]);
    assert.deepEqual(modelErrors, []);
    assert.deepEqual(browserErrors, []);
    if (hostedError) throw hostedError;

    await chromiumBrowser.close();
    const budgetPath = `/v3/sessions/${workspace.id}/messages`;
    const fullPageRows = ['fixture-page-one', 'fixture-page-two'].map(localId => ({
        localId, content: encodeBase64(encrypt(workspace.encryptionKey, 'dataKey', 'a'.repeat(3 * 1024 * 1024))),
    }));
    const putPage = await fetch(serverUrl + budgetPath, { method: 'POST', headers, body: JSON.stringify({ messages: fullPageRows }) });
    assert.equal(putPage.status, 200);
    for (const cursor of ['after_seq=0', 'before_seq=3']) {
        const index = cursor.startsWith('before') ? 1 : 0;
        const result = await fetch(`${serverUrl}${budgetPath}?${cursor}`, { headers });
        assert.equal(result.status, 200);
        const { messages, hasMore } = await result.json();
        assert.equal(hasMore, true);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].localId, fullPageRows[index].localId);
        assert.equal(messages[0].content.c.length, fullPageRows[index].content.length);
    }
    console.log('PASS Relay byte-budget pagination in both directions');
    await writeFile(join(evidence, 'model-digests.json'), JSON.stringify(modelCalls, null, 2));
    console.log(`PASS isolated Relay, real Codex app-server, loopback model fixture and browser. Evidence: ${evidence}`);
} catch (error) {
    console.error(JSON.stringify({ modelCalls, modelErrors, browserErrors, badResponses }, null, 2));
    throw error;
} finally {
    releaseHeldResponse?.();
    controller.abort();
    await chromiumBrowser?.close();
    await running;
    model.closeAllConnections();
    model.close();
    for (const child of children.reverse()) {
        if (child.exitCode === null && child.signalCode === null) {
            const stopped = once(child, 'exit');
            child.kill('SIGTERM');
            await stopped;
        }
    }
    await rm(temporary, { recursive: true, force: true });
}
