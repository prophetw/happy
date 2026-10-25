// Reuse a production export: HAPPY_SUBPATH_EXPORT_DIR=/tmp/web-export pnpm exec node packages/happy-app/scripts/web-subpath.e2e.mjs
// HAPPY_SUBPATH_PAUSE=1 pauses after the initial screenshot until artifacts/continue exists.
// HAPPY_SUBPATH_EXTENDED=1 also checks the picker, offline recovery and QR login.
// Extended checks require HAPPY_QR_DECODER_MODULE to point to an installed jsqr module.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import nacl from 'tweetnacl';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const appRequire = createRequire(new URL('../package.json', import.meta.url));
const extended = process.env.HAPPY_SUBPATH_EXTENDED === '1';
let decodeQR;
if (extended) {
    assert(process.env.HAPPY_QR_DECODER_MODULE, 'Set HAPPY_QR_DECODER_MODULE to the jsqr module path');
    decodeQR = appRequire(path.resolve(process.env.HAPPY_QR_DECODER_MODULE));
}
assert(process.env.HAPPY_SUBPATH_EXPORT_DIR, 'Set HAPPY_SUBPATH_EXPORT_DIR to an export built with HAPPY_WEB_BASE_PATH=/happy');
const exportDir = path.resolve(process.env.HAPPY_SUBPATH_EXPORT_DIR);
assert((await readFile(path.join(exportDir, 'index.html'), 'utf8')).includes('/happy/_expo/'), 'Expected a /happy export');
const artifacts = path.join(repo, '.e2e-artifacts', `web-subpath-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const temporary = await mkdtemp(path.join(tmpdir(), 'happy-web-subpath-e2e-'));
await mkdir(artifacts, { recursive: true });
const children = [];
const failures = [];
const checks = [];
const warnings = [];
const cancelledRequests = [];
const responses = [];
const webSockets = [];
const browserEvents = [];
const expectedFaultEvents = [];
const gatewayBrowserSockets = new Set();
let phase = 'setup';
let browser, page, diagnosticPage, gateway, proxy, sessionClient, machineClient, heartbeat, inspectFixture;
const isOfflineFault = text => ['network-offline', 'network-recovery'].includes(phase)
    && /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED)/.test(text);

async function waitFor(check, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
}
async function allocatePort() {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function start(args, env, name) {
    const log = await open(path.join(artifacts, name), 'w');
    const child = spawn(process.execPath, args, {
        cwd: path.join(repo, 'packages/happy-server'), env, detached: true,
        stdio: ['ignore', log.fd, log.fd],
    });
    child.fixtureName = name;
    children.push(child);
    await log.close();
    return child;
}
function pass(label) { checks.push(label); console.log(`PASS: ${label}`); }
const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json',
};

try {
    const backendPort = await allocatePort();
    const webPort = await allocatePort();
    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const webOrigin = `http://127.0.0.1:${webPort}`;
    const serverUrl = `${webOrigin}/home-relay`;
    const env = {
        ...process.env, NODE_ENV: 'development', DB_PROVIDER: 'pglite', DATA_DIR: temporary,
        PGLITE_DIR: path.join(temporary, 'pglite'), HANDY_MASTER_SECRET: randomBytes(32).toString('hex'),
        HOST: '127.0.0.1', PORT: String(backendPort), PUBLIC_URL: serverUrl, REDIS_URL: '', S3_HOST: '',
        HAPPY_ALLOWED_ACCOUNT_IDS: '*', METRICS_ENABLED: 'false', GITHUB_CLIENT_ID: '', GITHUB_APP_ID: '',
    };
    console.log(`Artifacts: ${path.relative(repo, artifacts)}`);
    const migration = await start(['--import', 'tsx', 'sources/standalone.ts', 'migrate'], env, 'migrate.log');
    assert.equal((await once(migration, 'exit'))[0], 0, 'Temporary database migration');
    await start(['--import', 'tsx', 'sources/standalone.ts', 'serve'], env, 'server.log');
    await waitFor(async () => { try { return (await fetch(`${backendOrigin}/health`)).ok; } catch { return false; } }, 'local Relay');

    const cliRequire = createRequire(new URL('../../happy-cli/package.json', import.meta.url));
    proxy = cliRequire('http-proxy').createProxyServer({ target: backendOrigin, ws: true });
    proxy.on('error', error => failures.push(`Proxy: ${error.message}`));
    gateway = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, webOrigin);
            if (url.pathname.startsWith('/home-relay/')) {
                request.url = request.url.slice('/home-relay'.length);
                proxy.web(request, response);
                return;
            }
            if (url.pathname === '/happy') {
                response.writeHead(308, { Location: `/happy/${url.search}` });
                response.end();
                return;
            }
            if (!url.pathname.startsWith('/happy/')) {
                response.writeHead(404); response.end(); return;
            }
            let file = path.resolve(exportDir, decodeURIComponent(url.pathname.slice('/happy/'.length)));
            if (file !== exportDir && !file.startsWith(exportDir + path.sep)) {
                response.writeHead(403); response.end(); return;
            }
            let fileStat = await stat(file).catch(error => {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
                throw error;
            });
            if (!fileStat?.isFile()) {
                if (url.pathname.startsWith('/happy/_expo/') || url.pathname.startsWith('/happy/assets/') || path.extname(url.pathname)) {
                    response.writeHead(404); response.end(); return;
                }
                file = path.join(exportDir, 'index.html');
                fileStat = await stat(file);
            }
            response.writeHead(200, {
                'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
                'Content-Length': fileStat.size,
                ...(path.extname(file) === '.html' ? { 'Cache-Control': 'no-cache' } : {}),
            });
            if (request.method === 'HEAD') response.end();
            else createReadStream(file).on('error', error => response.destroy(error)).pipe(response);
        } catch (error) {
            failures.push(`Gateway: ${error.message}`);
            if (!response.headersSent) response.writeHead(500);
            response.end();
        }
    });
    gateway.on('upgrade', (request, socket, head) => {
        if (!request.url.startsWith('/home-relay/')) { socket.destroy(); return; }
        if (request.headers['user-agent']?.includes('Chrome')) {
            gatewayBrowserSockets.add(socket);
            socket.on('close', () => gatewayBrowserSockets.delete(socket));
        }
        request.url = request.url.slice('/home-relay'.length);
        proxy.ws(request, socket, head);
    });
    await new Promise(resolve => gateway.listen(webPort, '127.0.0.1', resolve));

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
    const entry = path.join(artifacts, 'cli-fixture.mjs');
    await build({
        stdin: { contents: `export { ApiClient } from './packages/happy-cli/src/api/api.ts';
export { decrypt, decodeBase64 } from './packages/happy-cli/src/api/encryption.ts';
export { normalizeRawMessage } from './packages/happy-app/sources/sync/typesRaw.ts';`, resolveDir: repo },
        bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: entry,
        alias: {
            '@slopus/happy-wire': path.join(repo, 'packages/happy-wire/src/index.ts'),
            '@slopus/happy-wire/serverUrl': path.join(repo, 'packages/happy-wire/src/serverUrl.ts'),
        },
        tsconfig: path.join(repo, 'packages/happy-cli/tsconfig.json'), logLevel: 'silent',
    });
    const { ApiClient, decrypt, decodeBase64, normalizeRawMessage } = await import(pathToFileURL(entry).href);
    const api = await ApiClient.create({ token, encryption: { type: 'legacy', secret } });
    const machine = await api.getOrCreateMachine({ machineId: randomUUID(), metadata: {
        host: 'subpath-fixture', platform: process.platform, displayName: 'Subpath test computer',
        homeDir: temporary, happyHomeDir: path.join(temporary, 'cli'),
    } });
    machineClient = api.machineSyncClient(machine);
    machineClient.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorMessage: 'Fixture only' }), stopSession: () => true, requestShutdown() {} });
    machineClient.connect();
    await waitFor(() => machineClient.isReady(), 'fixture machine');
    const sessionTitle = 'Subpath browser acceptance';
    const session = await api.getOrCreateSession({ tag: randomUUID(), metadata: {
        path: temporary, host: 'subpath-fixture', machineId: machine.id, flavor: 'claude',
        slashCommands: ['maintain'], skills: ['fixture-skill'],
        summary: { text: sessionTitle, updatedAt: Date.now() },
    }, state: { controlledByUser: false, requests: {} } });
    assert(session);
    inspectFixture = async () => {
        const response = await fetch(`${serverUrl}/v3/sessions/${session.id}/messages`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await response.json();
        return {
            sessionId: session.id,
            browserUrl: page?.url(),
            messages: (data.messages ?? []).map(message => {
                const encrypted = typeof message.content === 'string' ? message.content : message.content.c;
                const raw = decrypt(secret, 'legacy', decodeBase64(encrypted));
                return { seq: message.seq, raw, normalized: normalizeRawMessage(message.id, message.localId, message.createdAt, raw) };
            }),
        };
    };
    sessionClient = api.sessionSyncClient(session);
    const received = [];
    const files = [];
    sessionClient.onUserMessage(message => received.push(message));
    sessionClient.onFileEvent(message => files.push(message));
    await waitFor(() => sessionClient.socket.connected, 'fixture session');
    const ping = () => sessionClient.keepAlive(false, 'remote');
    ping();
    heartbeat = setInterval(ping, 2000);

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
    await context.addInitScript(({ serverUrl, token, secret }) => {
        if (location.protocol === 'about:') return;
        window.__HAPPY_CONFIG__ = { serverUrl, disableAnalytics: true };
        if (!localStorage.getItem('auth_credentials')) localStorage.setItem('auth_credentials', JSON.stringify({ token, secret }));
        const prefix = 'mmkv.default' + String.fromCharCode(92, 92);
        localStorage.setItem(prefix + 'settings', JSON.stringify({ settings: { preferredLanguage: 'en', sessionListGrouping: 'project' }, version: null }));
    }, { serverUrl, token, secret: Buffer.from(secret).toString('base64') });
    const routeLocalOnly = route => {
        const url = new URL(route.request().url());
        if (url.origin !== webOrigin) {
            failures.push(`Unexpected external request: ${url.origin}${url.pathname}`);
            return route.abort();
        }
        return route.continue();
    };
    await context.route('**/*', routeLocalOnly);
    page = await context.newPage();
    diagnosticPage = page;
    function observePage(observedPage, label) {
        observedPage.on('framenavigated', frame => {
            if (frame === observedPage.mainFrame()) browserEvents.push({ at: Date.now(), phase, page: label, kind: 'navigation', pathname: new URL(frame.url()).pathname });
        });
        observedPage.on('pageerror', error => failures.push(`Page[${label}]: ${error.message}`));
        observedPage.on('console', message => {
            if (message.type() === 'error') {
                if (isOfflineFault(message.text())) expectedFaultEvents.push({ at: Date.now(), phase, page: label, kind: 'console', message: message.text() });
                else failures.push(`Console[${label}]: ${message.text()}`);
            }
            else if (message.type() === 'warning') {
                warnings.push(message.text());
                if (message.text().includes('Failed to fetch')) browserEvents.push({ at: Date.now(), phase, kind: 'fetch-warning', message: message.text().split('\n')[0] });
            }
        });
        observedPage.on('response', response => {
            const url = new URL(response.url());
            responses.push({ page: label, pathname: url.pathname, status: response.status(), type: response.request().resourceType() });
            if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${url.pathname}`);
        });
        observedPage.on('requestfailed', request => {
            const requestLabel = `${new URL(request.url()).pathname}: ${request.failure()?.errorText}`;
            if (request.failure()?.errorText === 'net::ERR_ABORTED') {
                cancelledRequests.push(requestLabel);
                browserEvents.push({ at: Date.now(), phase, page: label, kind: 'cancelled-request', pathname: new URL(request.url()).pathname });
            }
            else if (isOfflineFault(requestLabel)) expectedFaultEvents.push({ at: Date.now(), phase, page: label, kind: 'request', message: requestLabel });
            else failures.push(`Request: ${requestLabel}`);
        });
        observedPage.on('websocket', socket => {
            const url = new URL(socket.url());
            if (url.host !== new URL(webOrigin).host) failures.push(`Unexpected external WebSocket: ${url.host}${url.pathname}`);
            const record = { page: label, pathname: url.pathname, connected: false, closed: false };
            webSockets.push(record);
            socket.on('framereceived', frame => { if (String(frame.payload).startsWith('40{')) record.connected = true; });
            socket.on('close', () => { record.closed = true; });
        });
    }
    observePage(page, 'main');
    phase = 'desktop-home';
    await page.goto(`${webOrigin}/happy/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByText(sessionTitle, { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(artifacts, 'desktop-home.png'), animations: 'disabled' });
    await writeFile(path.join(artifacts, 'initial-dom.txt'), await page.locator('body').ariaSnapshot());
    if (process.env.HAPPY_SUBPATH_PAUSE === '1') {
        console.log('Paused for visual inspection; create continue in the artifact directory to resume.');
        await waitFor(async () => { try { await access(path.join(artifacts, 'continue')); return true; } catch { return false; } }, 'visual inspection', 180_000);
    }
    await waitFor(() => webSockets.some(socket => socket.pathname === '/home-relay/v1/updates/' && socket.connected), 'prefixed browser Socket.IO connection');
    assert.equal(await page.evaluate(() => new URL(document.querySelector('link[rel="icon"]').href).pathname), '/happy/favicon.ico');
    pass('Production export loads an authenticated desktop page and Socket.IO through /home-relay');

    phase = 'settings-navigation';
    await page.getByText('Settings', { exact: true }).last().click();
    await page.waitForURL(`${webOrigin}/happy/settings`);
    assert.equal((await page.reload({ waitUntil: 'domcontentloaded' })).status(), 200);
    await page.getByText('Account', { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(artifacts, 'settings-refreshed.png'), animations: 'disabled' });
    pass('Client navigation and a direct settings-page refresh retain /happy');

    phase = 'session-navigation';
    await page.goto(`${webOrigin}/happy/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(sessionTitle, { exact: true }).first().click();
    await page.waitForURL(`${webOrigin}/happy/session/${session.id}`);
    const input = page.locator('textarea').first();
    await input.waitFor();
    const prompt = 'Browser message through the Happy Web gateway';
    await input.fill(prompt);
    await input.press('Enter');
    await waitFor(() => received.some(message => message.content.text === prompt), 'CLI receives encrypted browser message');
    const reply = 'Subpath encrypted reply received';
    sessionClient.sendSessionProtocolMessage({ id: randomUUID(), time: Date.now(), role: 'agent', turn: randomUUID(), ev: { t: 'text', text: reply } });
    await page.getByText(reply, { exact: true }).waitFor();
    phase = 'session-refresh';
    assert.equal((await page.reload({ waitUntil: 'domcontentloaded' })).status(), 200);
    await page.getByText(reply, { exact: true }).waitFor();
    await page.getByText(prompt, { exact: true }).first().waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(artifacts, 'session-refreshed.png'), animations: 'disabled' });
    pass('Web and CLI exchange real encrypted messages; direct session refresh restores both messages');

    const slashPrompt = 'Browser message through /happy and /home-relay';
    await page.locator('textarea').first().fill(slashPrompt);
    await page.locator('textarea').first().press('Enter');
    await waitFor(() => received.some(message => message.content.text === slashPrompt), 'CLI receives message containing paths');
    await page.getByText(slashPrompt, { exact: true }).first().waitFor();
    phase = 'slash-message-refresh';
    assert.equal((await page.reload({ waitUntil: 'domcontentloaded' })).status(), 200);
    await page.getByText(reply, { exact: true }).waitFor();
    await page.getByText(slashPrompt, { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(artifacts, 'path-message-refreshed.png'), animations: 'disabled' });
    pass('User messages containing URL paths are visible on send and after refresh');

    phase = 'registered-commands';
    const commandCases = [
        { name: 'compact', text: '/compact builtin fixture', args: 'builtin fixture' },
        { name: 'maintain', text: 'Please /maintain inspect this fixture', args: 'Please inspect this fixture' },
        { name: 'fixture-skill', text: 'Inspect fixture skill /fixture-skill', args: 'Inspect fixture skill' },
    ];
    for (const command of commandCases) {
        // Finish the token so Enter sends instead of accepting autocomplete.
        await page.locator('textarea').first().fill(`${command.text} `);
        await page.locator('textarea').first().press('Enter');
        await waitFor(() => received.some(message => message.content.text.trim() === command.text), `CLI receives ${command.name}`);
        sessionClient.sendSessionProtocolMessage({
            id: randomUUID(), time: Date.now(), role: 'user',
            ev: { t: 'text', text: `<command-message>${command.name}</command-message><command-name>/${command.name}</command-name><command-args>${command.args}</command-args>` },
        });
        await page.getByText(`/${command.name}`, { exact: true }).waitFor();
    }
    assert.equal((await page.reload({ waitUntil: 'domcontentloaded' })).status(), 200);
    for (const command of commandCases) {
        await page.getByText(`/${command.name}`, { exact: true }).waitFor();
        await page.getByText(command.args, { exact: true }).waitFor();
        assert.equal(await page.getByText(command.text, { exact: true }).count(), 0, `Duplicate raw echo: ${command.name}`);
    }
    await page.getByText(slashPrompt, { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(artifacts, 'registered-commands-refreshed.png'), animations: 'disabled' });
    pass('Built-in commands, metadata slash commands and skills retain SDK chips without duplicate echoes');

    phase = 'attachments-and-assets';
    const attachment = await page.evaluate(async ({ serverUrl, sessionId }) => {
        const { token } = JSON.parse(localStorage.getItem('auth_credentials'));
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const payload = new Uint8Array([0, 1, 2, 127, 128, 255]);
        const requestUpload = await fetch(`${serverUrl}/v1/sessions/${sessionId}/attachments/request-upload`, {
            method: 'POST', headers, body: JSON.stringify({ filename: 'subpath-fixture.bin', size: payload.length }),
        });
        if (!requestUpload.ok) throw new Error(`Attachment request-upload: ${requestUpload.status}`);
        const upload = await requestUpload.json();
        const uploaded = await fetch(upload.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: payload });
        if (!uploaded.ok) throw new Error(`Attachment upload: ${uploaded.status}`);
        const requestDownload = await fetch(`${serverUrl}/v1/sessions/${sessionId}/attachments/request-download`, {
            method: 'POST', headers, body: JSON.stringify({ ref: upload.ref }),
        });
        if (!requestDownload.ok) throw new Error(`Attachment request-download: ${requestDownload.status}`);
        const download = await requestDownload.json();
        const downloaded = await fetch(download.downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!downloaded.ok) throw new Error(`Attachment download: ${downloaded.status}`);
        return { uploadPath: new URL(upload.uploadUrl).pathname, downloadPath: new URL(download.downloadUrl).pathname, bytes: [...new Uint8Array(await downloaded.arrayBuffer())] };
    }, { serverUrl, sessionId: session.id });
    assert(attachment.uploadPath.startsWith('/home-relay/v1/'));
    assert(attachment.downloadPath.startsWith('/home-relay/v1/'));
    assert.deepEqual(attachment.bytes, [0, 1, 2, 127, 128, 255]);
    pass('Browser attachment API uploads/downloads preserve the Relay prefix and binary bytes');

    await page.evaluate(async () => {
        const response = await fetch('/happy/canvaskit.wasm');
        if (response.headers.get('content-type') !== 'application/wasm') throw new Error('Wrong WASM content type');
        await WebAssembly.compile(await response.arrayBuffer());
    });
    assert(responses.some(item => item.type === 'font' && item.pathname.startsWith('/happy/assets/') && item.status === 200));
    assert(responses.some(item => item.type === 'image' && item.pathname.startsWith('/happy/assets/') && item.status === 200));
    pass('Real browser fonts/images use /happy/assets and the WASM payload compiles');

    sessionClient.updateAgentState(state => ({ ...state, requests: { permission: { tool: 'Bash', arguments: { command: 'echo fixture' } } } }));
    await page.waitForFunction(() => new URL(document.querySelector('link[rel="icon"]').href).pathname === '/happy/favicon-active.ico');
    sessionClient.updateAgentState(state => ({ ...state, requests: {} }));
    await page.waitForFunction(() => new URL(document.querySelector('link[rel="icon"]').href).pathname === '/happy/favicon.ico');
    pass('Normal and attention favicons retain /happy');

    phase = 'mobile-navigation';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${webOrigin}/happy/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(sessionTitle, { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(artifacts, 'mobile-home.png'), animations: 'disabled' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    pass('Mobile Web viewport renders without horizontal page overflow');

    if (extended) {
        phase = 'image-picker';
        await page.setViewportSize({ width: 1365, height: 900 });
        await page.goto(`${webOrigin}/happy/session/${session.id}`, { waitUntil: 'domcontentloaded' });
        await page.locator('textarea').first().waitFor();
        const glyphs = appRequire('@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json');
        const imageBytes = await readFile(path.join(repo, 'packages/happy-app/sources/assets/images/zen-icon.png'));
        const imageName = 'subpath-picker-fixture.png';
        const imageDataUri = `data:image/png;base64,${imageBytes.toString('base64')}`;
        const imageIsLoaded = () => page.evaluate(expected => Array.from(document.images)
            .some(image => image.src === expected && image.naturalWidth > 0), imageDataUri);
        const previewIsLoaded = () => page.evaluate(() => Array.from(document.images)
            .some(image => image.src.startsWith('blob:') && image.naturalWidth > 0));
        const chooseImage = async () => {
            const chooserEvent = page.waitForEvent('filechooser');
            await page.getByText(String.fromCodePoint(glyphs['image-outline']), { exact: true }).last().click();
            const chooser = await chooserEvent;
            assert.match(await chooser.element().getAttribute('accept'), /image\/\*/);
            await chooser.setFiles({ name: imageName, mimeType: 'image/png', buffer: imageBytes });
            await waitFor(previewIsLoaded, 'selected image preview');
        };
        const filesBefore = files.length;
        await chooseImage();
        await page.screenshot({ path: path.join(artifacts, 'image-picker-preview.png'), animations: 'disabled' });
        await page.getByText(String.fromCodePoint(glyphs.close), { exact: true }).last().click();
        await waitFor(async () => !await previewIsLoaded(), 'remove selected image');
        assert.equal(files.length, filesBefore, 'Removing a preview must not send a file event');
        await chooseImage();
        pass('Real file chooser selects an image, renders its preview and removes it without sending');

        const photoPrompt = 'Photo selected from the Web picker';
        await page.locator('textarea').first().fill(photoPrompt);
        await page.locator('textarea').first().press('Enter');
        await waitFor(() => received.some(message => message.content.text === photoPrompt)
            && files.length === filesBefore + 1, 'picker image and text reach CLI');
        const fileEvent = files.at(-1).content.data.ev;
        assert.equal(fileEvent.name, imageName);
        assert.equal(fileEvent.size, imageBytes.length);
        assert(fileEvent.image.width > 0 && fileEvent.image.height > 0);
        const downloadedImage = await sessionClient.downloadAndDecryptAttachment(fileEvent.ref);
        assert(downloadedImage);
        assert.deepEqual(Buffer.from(downloadedImage), imageBytes);
        await page.getByText(imageName, { exact: true }).waitFor();
        await waitFor(imageIsLoaded, 'decrypted image bubble');
        const downloadsBeforeRefresh = responses.filter(item => item.pathname.endsWith('/attachments/request-download')).length;
        assert.equal((await page.reload({ waitUntil: 'domcontentloaded' })).status(), 200);
        await page.getByText(imageName, { exact: true }).waitFor();
        await waitFor(imageIsLoaded, 'image bubble restored after refresh');
        assert(responses.filter(item => item.pathname.endsWith('/attachments/request-download')).length > downloadsBeforeRefresh);
        await page.screenshot({ path: path.join(artifacts, 'image-attachment-refreshed.png'), animations: 'disabled' });
        pass('Picker image uploads encrypted, decrypts byte-for-byte in CLI and reappears after a browser refresh');

        phase = 'network-observer';
        const observer = await context.newPage();
        observePage(observer, 'connection-status');
        await observer.setViewportSize({ width: 390, height: 844 });
        await observer.goto(`${webOrigin}/happy/`, { waitUntil: 'domcontentloaded' });
        await observer.getByText(sessionTitle, { exact: true }).first().waitFor();
        const statusSlot = observer.getByTestId('home-header-subtitle-slot');
        await statusSlot.waitFor({ state: 'attached' });
        await waitFor(async () => !(await statusSlot.textContent()).trim(), 'healthy connection has no warning subtitle');
        const sessionUrlBeforeOffline = page.url();
        const socketsBeforeOffline = webSockets.length;
        assert(gatewayBrowserSockets.size >= 2, 'Both browser pages have real gateway WebSockets');
        phase = 'network-offline';
        await context.setOffline(true);
        assert(await page.evaluate(() => !navigator.onLine), 'Browser reports its offline state');
        for (const socket of gatewayBrowserSockets) socket.destroy();
        await statusSlot.getByText(/^(disconnected|connecting|error)$/).waitFor();
        await observer.screenshot({ path: path.join(artifacts, 'network-offline.png'), animations: 'disabled' });
        const offlineReply = 'Reply persisted while the browser was offline';
        sessionClient.sendSessionProtocolMessage({ id: randomUUID(), time: Date.now(), role: 'agent', turn: randomUUID(), ev: { t: 'text', text: offlineReply } });
        await sessionClient.flush();
        assert.equal(await page.getByText(offlineReply, { exact: true }).count(), 0);
        pass('Intentional browser outage closes transports, shows an offline status and leaves CLI connected');

        phase = 'network-recovery';
        await context.setOffline(false);
        await waitFor(() => webSockets.slice(socketsBeforeOffline)
            .some(socket => socket.page === 'main' && socket.connected && !socket.closed), 'browser automatically reconnects through /home-relay');
        await page.getByText(offlineReply, { exact: true }).waitFor();
        await waitFor(async () => !(await statusSlot.textContent()).trim(), 'connection warning clears');
        assert.equal(page.url(), sessionUrlBeforeOffline);
        assert(await page.evaluate(expected => {
            const current = JSON.parse(localStorage.getItem('auth_credentials'));
            return current.token === expected.token && current.secret === expected.secret;
        }, { token, secret: Buffer.from(secret).toString('base64') }));
        const reconnectPrompt = 'Browser message after automatic reconnect';
        await page.locator('textarea').first().fill(reconnectPrompt);
        await page.locator('textarea').first().press('Enter');
        await waitFor(() => received.some(message => message.content.text === reconnectPrompt), 'message after automatic reconnect');
        assert.equal(received.filter(message => message.content.text === reconnectPrompt).length, 1);
        await page.getByText(reconnectPrompt, { exact: true }).first().waitFor();
        await page.getByText(reconnectPrompt, { exact: true }).first().scrollIntoViewIfNeeded();
        phase = 'network-recovered';
        await page.screenshot({ path: path.join(artifacts, 'network-recovered.png'), animations: 'disabled' });
        await observer.close();
        pass('Automatic reconnect catches up missed messages without reload or logout and sends the next message once');

        phase = 'qr-login';
        const qrContext = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
        await qrContext.addInitScript(({ serverUrl }) => {
            if (location.protocol === 'about:') return;
            window.__HAPPY_CONFIG__ = { serverUrl, disableAnalytics: true };
            const prefix = 'mmkv.default' + String.fromCharCode(92, 92);
            localStorage.setItem(prefix + 'settings', JSON.stringify({ settings: { preferredLanguage: 'en' }, version: null }));
        }, { serverUrl });
        await qrContext.route('**/*', routeLocalOnly);
        const qrPage = await qrContext.newPage();
        diagnosticPage = qrPage;
        observePage(qrPage, 'qr-login');
        await qrPage.goto(`${webOrigin}/happy/`, { waitUntil: 'domcontentloaded' });
        assert.equal(await qrPage.evaluate(() => localStorage.getItem('auth_credentials')), null);
        await qrPage.getByRole('button', { name: 'Login with mobile app', exact: true }).click();
        await qrPage.waitForURL(`${webOrigin}/happy/restore`);
        const qrImage = qrPage.locator('svg[width="260"][height="260"]');
        await qrImage.waitFor();
        const qrPixels = appRequire('pngjs').PNG.sync.read(await qrImage.screenshot());
        const decoded = decodeQR(new Uint8ClampedArray(qrPixels.data), qrPixels.width, qrPixels.height);
        assert(decoded, 'Decode the actually rendered QR pixels');
        assert(decoded.data.startsWith('happy:///account?'));
        const pendingPublicKey = new Uint8Array(Buffer.from(decoded.data.slice('happy:///account?'.length), 'base64url'));
        assert.equal(pendingPublicKey.length, 32);
        await qrPage.screenshot({ path: path.join(artifacts, 'qr-login-pending.png'), animations: 'disabled' });
        pass('A fresh browser opens /happy/restore and its rendered QR decodes to a real account-link request');

        // Simulate the native phone's approval; no credentials are injected into qrPage.
        const ephemeral = nacl.box.keyPair();
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const sealedSecret = nacl.box(secret, nonce, pendingPublicKey, ephemeral.secretKey);
        const approval = await fetch(`${serverUrl}/v1/auth/account/response`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicKey: Buffer.from(pendingPublicKey).toString('base64'), response: Buffer.concat([ephemeral.publicKey, nonce, sealedSecret]).toString('base64') }),
        });
        assert.equal(approval.status, 200);
        await qrPage.waitForURL(`${webOrigin}/happy/`);
        await qrPage.getByText(sessionTitle, { exact: true }).first().waitFor();
        assert(await qrPage.evaluate(expected => {
            const credentials = JSON.parse(localStorage.getItem('auth_credentials'));
            const canonical = value => value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
            return Boolean(credentials?.token) && canonical(credentials.secret) === canonical(expected);
        }, Buffer.from(secret).toString('base64')));
        assert.equal((await qrPage.reload({ waitUntil: 'domcontentloaded' })).status(), 200);
        await qrPage.getByText(sessionTitle, { exact: true }).first().waitFor();
        await qrPage.getByText(sessionTitle, { exact: true }).first().click();
        await qrPage.waitForURL(`${webOrigin}/happy/session/${session.id}`);
        const restoredPrompt = 'Message from the QR-restored Web account';
        await qrPage.locator('textarea').first().fill(restoredPrompt);
        await qrPage.locator('textarea').first().press('Enter');
        await waitFor(() => received.some(message => message.content.text === restoredPrompt), 'QR-restored account sends an encrypted message');
        const restoredReply = 'Reply to the QR-restored account';
        sessionClient.sendSessionProtocolMessage({ id: randomUUID(), time: Date.now(), role: 'agent', turn: randomUUID(), ev: { t: 'text', text: restoredReply } });
        await qrPage.getByText(restoredReply, { exact: true }).waitFor();
        await qrPage.getByText(restoredReply, { exact: true }).scrollIntoViewIfNeeded();
        await qrPage.screenshot({ path: path.join(artifacts, 'qr-account-restored.png'), animations: 'disabled' });
        await qrContext.close();
        diagnosticPage = page;
        pass('Simulated phone approval restores the same account, persists login after refresh and exchanges encrypted messages');
    }

    phase = 'final-checks';
    const redirect = await fetch(`${webOrigin}/happy?test=1`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/happy/?test=1');
    assert.equal((await fetch(`${webOrigin}/happy/_expo/missing.js`)).status, 404);
    assert.deepEqual(failures, [], 'Unexpected browser, network and HTTP errors');
    pass('No page/console errors, unexpected HTTP failures, external requests or prefix escapes');
} catch (error) {
    failures.push(error.stack ?? String(error));
    if (diagnosticPage) {
        await diagnosticPage.screenshot({ path: path.join(artifacts, 'failure.png'), animations: 'disabled' }).catch(() => {});
        await writeFile(path.join(artifacts, 'failure-dom.txt'), await diagnosticPage.locator('body').ariaSnapshot()).catch(() => {});
    }
    if (inspectFixture) await writeFile(path.join(artifacts, 'messages-diagnostic.json'), JSON.stringify(await inspectFixture(), null, 2));
    console.error(error.message);
    process.exitCode = 1;
} finally {
    phase = 'cleanup';
    clearInterval(heartbeat);
    await browser?.close();
    await sessionClient?.close();
    machineClient?.shutdown();
    gateway?.closeAllConnections();
    if (gateway?.listening) await new Promise(resolve => gateway.close(resolve));
    proxy?.close();
    for (const child of children.reverse()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
        try { process.kill(-child.pid, 'SIGTERM'); await exited; }
        catch (error) {
            warnings.push(`Fixture cleanup (${child.fixtureName}): ${error.message}`);
            if (child.exitCode === null && child.signalCode === null) {
                const killed = once(child, 'exit', { signal: AbortSignal.timeout(5_000) });
                try {
                    process.kill(-child.pid, 'SIGKILL');
                    await killed;
                    warnings.push(`Fixture cleanup (${child.fixtureName}): shutdown exceeded 10s; SIGKILL exit confirmed.`);
                } catch (killError) {
                    failures.push(`Fixture cleanup (${child.fixtureName}) could not confirm exit: ${killError.message}`);
                }
            }
        }
    }
    const serverLog = await readFile(path.join(artifacts, 'server.log'), 'utf8').catch(() => '');
    const shutdownAt = serverLog.indexOf('Received SIGTERM signal');
    const runtimeLog = shutdownAt < 0 ? serverLog : serverLog.slice(0, shutdownAt);
    if (/Error in |Invalid `|Exception|FAILED|uncaught/i.test(runtimeLog)) {
        failures.push('Unexpected Relay runtime error; inspect server.log');
        process.exitCode = 1;
    }
    if (shutdownAt >= 0 && /Response from the Engine was empty/.test(serverLog.slice(shutdownAt))) {
        warnings.push('Relay shutdown race after SIGTERM: timeout worker queried PGlite after database shutdown.');
    }
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({
        status: failures.length ? 'FAILED' : warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS', exportDir, checks, failures, warnings: [...new Set(warnings)],
        extended, expectedFaultEvents, cancelledRequests, browserEvents, webSockets, responses,
    }, null, 2));
    if (failures.length) process.exitCode = 1;
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    console.log(`Artifacts: ${path.relative(repo, artifacts)}`);
}
