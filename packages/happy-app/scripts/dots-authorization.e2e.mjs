// TESTLOOP_E2E_REPO=/absolute/compiled/testLoop pnpm --dir packages/happy-app exec node scripts/dots-authorization.e2e.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const app = fileURLToPath(new URL('../', import.meta.url));
const host = process.env.TESTLOOP_E2E_REPO;
assert(host, 'Set TESTLOOP_E2E_REPO to an isolated, compiled TestLoop checkout');
const load = path => import(pathToFileURL(resolve(host, path)).href);
const { peer, workspace } = await load('test/fixtures/hosted-happy-mcp.mjs');
const { mutateAssistantStore } = await load('dist/assistant-store.js');
const { attachDotsWorkspaceRPC } = await load('dist/assistant-workspace-rpc.js');
const { encryptHappyMessage, decryptHappyMessage } = await load('dist/happy-message-codec.js');

const artifacts = resolve(app, '../..', '.e2e-artifacts', `dots-authorization-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(artifacts, { recursive: true });
const cleanup = [], errors = [], samples = [], injected = [], t = { after: fn => cleanup.push(fn) };
let browser, server, holdNext, rejectNext, loseNext;
try {
    const remote = await peer(t);
    const fixture = await workspace(t, remote);
    const workspaceData = fixture.state().dots.workspace;
    const name = 'Fixture Happy MCP';
    const initial = await fixture.rpc({ action: 'save', name, config: { url: remote.url }, token: remote.token });
    assert(initial.ok, initial.error);
    const id = initial.data.connections[0].id;
    await fixture.rpc({ action: 'bind', dotId: fixture.dot.id, connectionIDs: [id] });
    await fixture.rpc({ action: 'bind-projects', dotId: fixture.dot.id, connectionID: id, projectIDs: ['project_a'] });
    const seed = (first, last) => mutateAssistantStore(fixture.root, state => {
        const primary = state.mcpConnections.items[0];
        for (let i = first; i <= last; i++) {
            const item = {
                ...structuredClone(primary), id: 'mcp-' + randomUUID(),
                name: `Sandbox ${i} ${'Long Service Name '.repeat(3)}`.trim(),
            };
            if (i === 29) {
                delete item.control;
                delete item.credentialRef;
                item.config = { url: 'https://fixture.example/sandbox-29' };
            }
            state.mcpConnections.items.push(item);
        }
    });
    seed(1, 1);
    const key = randomBytes(32);
    let handler;
    attachDotsWorkspaceRPC({ on: (_, callback) => { handler = callback; }, emit() {} },
        fixture.root, workspaceData.sessionId, key, () => true)();
    const sessions = {
        [workspaceData.sessionId]: { id: workspaceData.sessionId, active: true, presence: 'online',
            metadata: { testloopDots: { schemaVersion: 1, kind: 'workspace', workspaceId: workspaceData.id } } },
    };
    const theme = { colors: { text: '#e8e8ed', textSecondary: '#bdbdc8', textLink: '#aa9bff', surface: '#202023',
        surfaceHigh: '#29292d', surfaceHighest: '#35353b', surfacePressed: '#383840', divider: '#3a3a40',
        textDestructive: '#ffa395', success: '#a4e6ad', radio: { active: '#aa9bff', inactive: '#bdbdc8' } } };
    const mocks = {
        '@react-navigation/native': `import React from 'react';export const useFocusEffect=cb=>React.useEffect(cb,[cb]);export const useIsFocused=()=>true;`,
        'react-native-safe-area-context': `export const useSafeAreaInsets=()=>({top:0,left:0,right:0,bottom:0});`,
        'react-native-unistyles': `const theme=${JSON.stringify(theme)};export const useUnistyles=()=>({theme});export const StyleSheet={create:f=>typeof f==='function'?f(theme):f,hairlineWidth:1};`,
        'expo-crypto': `export const randomUUID=()=>crypto.randomUUID();`,
        '@expo/vector-icons': `export const Ionicons=()=>null;`,
        'expo-router': `export const useLocalSearchParams=()=>Object.fromEntries(new URLSearchParams(location.search));export const useRouter=()=>({push:()=>{}});`,
        '@/auth/AuthContext': `export const useAuth=()=>({isAuthenticated:true,credentials:{token:'fixture-account',secret:'fixture-secret'}});`,
        '@/sync/serverConfig': `export const getServerUrl=()=>location.origin;`,
        '@/sync/storage': `const state={sessions:${JSON.stringify(sessions)}};export const storage={getState:()=>state};export const useSession=id=>state.sessions[id];`,
        '@/sync/sync': `export const sync={getCredentials:()=>({token:'fixture-account',secret:'fixture-secret'}),refreshDotsSessions:async()=>{},ensureSessionReady:async()=>{},encryption:{anonID:'fixture'}};`,
        '@/hooks/useNavigateToSession': `const go=()=>{};export const useNavigateToSession=()=>go;`,
        '@/modal': `export const Modal={confirm:async()=>true,alert:()=>{}};`,
        'react-native-mmkv': `export class MMKV{}`,
        './DotRestartControl': `export const DotRestartControl=()=>null;`,
        './DotDispatchDefaultsFields': `export const DotDispatchDefaultsFields=()=>null;`,
        '@/text': `export const t=key=>key;`,
        './DotsWorkspacesPanel': `export const DotsWorkspacesPanel=()=>null;`,
        './useDotsWorkspace': `const result={projection:{snapshot:{dots:${JSON.stringify([fixture.dot, fixture.other])}},receipts:{}},ready:true,online:true,pendingCommands:[],pendingFor:()=>null,errorFor:()=>null};export const useDotsWorkspace=()=>result;`,
        './apiSocket': `export const apiSocket={sessionRPC:async(session,method,query)=>{
            (window.fixtureCalls ??= []).push(query.action);
            if(query.action==='save') window.fixtureRequests.push(performance.now()-window.fixtureClick);
            const result=await(await fetch('/rpc',{method:'POST',body:JSON.stringify({session,method,query})})).json();
            if(query.action==='save') window.fixtureReply=performance.now()-window.fixtureClick;
            if(result.fixtureLostResponse) throw Error('isolated reply loss');
            return result;
        }};`,
    };
    const bundle = await build({
        stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import Dots from './sources/app/(app)/dots';
            createRoot(document.getElementById('root')).render(<Dots/>);`, resolveDir: app, loader: 'tsx' },
        bundle: true, write: false, platform: 'browser', jsx: 'automatic',
        resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
        define: { __DEV__: 'false', global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
        alias: { 'react-native': 'react-native-web', '@': join(app, 'sources') },
        plugins: [{ name: 'isolated-boundaries', setup(b) {
            b.onResolve({ filter: /.*/ }, a => a.path in mocks ? { path: a.path, namespace: 'mock' } : undefined);
            b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js', resolveDir: app }));
        } }],
    });
    let lastSave;
    server = createServer(async (request, response) => {
        try {
            if (request.url === '/rpc') {
                const chunks = []; for await (const part of request) chunks.push(part);
                const { session, method, query } = JSON.parse(Buffer.concat(chunks));
                assert.equal(session, workspaceData.sessionId); assert.equal(method, 'testloop-mcp-connections');
                const started = performance.now(), before = remote.requests.length;
                const save = query.action === 'save';
                let result;
                if (save && rejectNext) {
                    rejectNext = false; result = { ok: false, error: 'mcp_connection_failed' };
                } else {
                    await handler({ method: `${session}:${method}`, params: encryptHappyMessage(query, key) },
                        reply => { result = decryptHappyMessage(reply, key); });
                }
                if (save) lastSave = { hostAckMs: performance.now() - started, controlMethods: remote.requests.slice(before).map(r => r.rpcMethod) };
                if (save && holdNext) {
                    const gate = holdNext; holdNext = undefined;
                    await Promise.all([gate, new Promise(resolve => setTimeout(resolve, 800))]);
                }
                if (save && loseNext) { loseNext = false; result = { fixtureLostResponse: true }; }
                response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); return;
            }
            if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); return; }
            if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}body{background:#18181b}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/bundle.js"></script></html>');
        } catch (error) { errors.push(error.message); response.writeHead(500); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const open = async page => {
        page.setDefaultTimeout(12000);
        await page.goto(origin + '/dots');
        await page.getByRole('button', { name: '连接与授权', exact: true }).click();
        await page.getByRole('heading', { name: 'MCP 工具', exact: true }).waitFor();
        await page.getByText(/Fixture Happy MCP/).first().waitFor();
    };
    for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 844 }, locale: 'zh-CN' });
        await open(page);
        await page.screenshot({ animations: 'disabled', path: join(artifacts, `${width}-2.png`) });
        await page.close();
    }
    seed(2, 29);
    for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 844 }, locale: 'zh-CN' });
        await page.route('**/*', route => {
            if (new URL(route.request().url()).origin === origin) return route.continue();
            errors.push('unexpected external request'); return route.abort();
        });
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('response', response => { if (response.status() >= 400) errors.push(String(response.status())); });
        await page.addInitScript(() => {
            window.fixtureCalls = []; window.fixtureRequests = [];
            document.addEventListener('click', event => {
                if (!event.target.closest('[aria-label="检查并保存 MCP"]')) return;
                window.fixtureClick = performance.now(); window.fixtureFirst = null; window.fixtureReady = null;
                const watch = (field, condition) => {
                    const observer = new MutationObserver(() => {
                        if (!condition()) return;
                        observer.disconnect();
                        requestAnimationFrame(() => requestAnimationFrame(() => { window[field] = performance.now() - window.fixtureClick; }));
                    });
                    observer.observe(document, { subtree: true, attributes: true, childList: true });
                };
                watch('fixtureFirst', () => document.querySelector('[aria-label="正在保存"],[aria-label="检查并保存 MCP"][aria-disabled="true"]'));
                watch('fixtureReady', () => !document.querySelector('[aria-label="MCP 名称"]'));
            }, true);
        });
        await open(page);
        await page.screenshot({ animations: 'disabled', path: join(artifacts, `${width}-30.png`) });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const search = page.getByLabel('搜索 MCP 连接', { exact: true });
        const reveal = async label => {
            const summary = page.getByRole('button', { name: `查看 MCP：${label}`, exact: true });
            if (await summary.count() && (await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
            await page.getByRole('button', { name: `编辑 MCP：${label}`, exact: true }).click();
        };
        const input = page.getByLabel('MCP 名称', { exact: true });
        const save = page.getByRole('button', { name: '检查并保存 MCP', exact: true });
        let prior = fixture.state().mcpConnections.items.find(item => item.id === id).name;
        for (let index = 0; index <= 5; index++) {
            if (await search.count() && index === 0) await search.fill('fixture happy MCP');
            await reveal(prior);
            const next = `Fixture Happy MCP ${width}-${index}`;
            await input.fill(next);
            const before = await page.evaluate(() => window.fixtureCalls.length);
            await save.click();
            await input.waitFor({ state: 'detached' });
            await page.waitForFunction(() => !!window.fixtureReady);
            const browserTiming = await page.evaluate(() => ({
                firstFrameMs: window.fixtureFirst, clickToRequestMs: window.fixtureRequests.at(-1),
                readyMs: window.fixtureReady, clickToReplyMs: window.fixtureReply,
            }));
            const calls = await page.evaluate(from => window.fixtureCalls.slice(from), before);
            assert.deepEqual(calls, ['save']);
            assert.equal(fixture.state().mcpConnections.items.find(item => item.id === id).name, next);
            if (index) samples.push({ width, ...browserTiming, ...lastSave, calls });
            prior = next;
        }
        await open(page);
        assert(await page.getByText(new RegExp(prior)).first().isVisible());
        if (process.argv.includes('--feedback')) {
            await search.fill('Sandbox 29 Name');
            await page.getByRole('button', { name: /^查看 MCP：Sandbox 29/ }).waitFor();
            assert.equal(await page.getByRole('button', { name: /^查看 MCP：/ }).count(), 1);
            await search.fill('machine_a /fixture/b');
            assert.equal(await page.getByRole('button', { name: /^查看 MCP：/ }).count(), 29);
            await search.fill('fixture.example/sandbox-29');
            assert.equal(await page.getByRole('button', { name: /^查看 MCP：/ }).count(), 1);
            await search.fill('Fixture Happy MCP');
            await reveal(prior);
            let release; holdNext = new Promise(resolve => { release = resolve; });
            await input.fill(`Fixture Happy MCP slow ${width}`);
            await save.scrollIntoViewIfNeeded();
            const before = await page.evaluate(() => window.fixtureCalls.length);
            await save.evaluate(button => { button.click(); button.click(); });
            const saving = page.getByRole('button', { name: '正在保存', exact: true });
            await saving.waitFor(); assert(await saving.isDisabled());
            const live = page.locator('[role="status"][aria-live="polite"]');
            assert.match(await live.filter({ hasText: '正在保存' }).ariaSnapshot(), /正在保存/);
            await page.screenshot({ animations: 'disabled', path: join(artifacts, `${width}-saving.png`) });
            release();
            await live.filter({ hasText: '已保存。' }).waitFor();
            assert.deepEqual(await page.evaluate(from => window.fixtureCalls.slice(from), before), ['save']);
            const saved = `Fixture Happy MCP slow ${width}`;
            await reveal(saved);
            await input.fill(`Fixture Happy MCP retry ${width}`); rejectNext = true; await save.click();
            await live.filter({ hasText: '保存失败' }).waitFor();
            assert.equal(await input.inputValue(), `Fixture Happy MCP retry ${width}`);
            await save.click(); await input.waitFor({ state: 'detached' });
            await reveal(`Fixture Happy MCP retry ${width}`);
            await input.fill(`Fixture Happy MCP lost ${width}`); loseNext = true; await save.click();
            await live.filter({ hasText: '回执待确认' }).waitFor(); assert(await save.isDisabled());
            const lostName = `Fixture Happy MCP lost ${width}`;
            assert.equal(fixture.state().mcpConnections.items.find(item => item.id === id).name, lostName);
            await page.getByRole('button', { name: '刷新 MCP 连接', exact: true }).click();
            await page.getByRole('button', { name: `查看 MCP：${lostName}`, exact: true }).waitFor();
            assert.equal(await input.inputValue(), lostName);
            assert(await save.isDisabled());
            await page.screenshot({ animations: 'disabled', path: join(artifacts, `${width}-unconfirmed.png`) });
            await page.getByRole('button', { name: '取消 MCP 编辑', exact: true }).click();

            const scope = page.getByRole('button', { name: '查看 Dot A 的项目授权', exact: true });
            if (await scope.getAttribute('aria-expanded') !== 'true') await scope.click();
            const project = page.getByRole('checkbox', { name: '为 Dot A 启用项目 project_b', exact: true });
            const rpcBefore = await page.evaluate(() => window.fixtureCalls.length);
            const remoteBefore = remote.requests.length;
            await project.click();
            await live.filter({ hasText: '已保存。' }).waitFor();
            assert.deepEqual(await page.evaluate(from => window.fixtureCalls.slice(from), rpcBefore), ['bind-projects']);
            assert.equal(remote.requests.length, remoteBefore);
            assert(fixture.state().mcpConnections.projectBindings[fixture.dot.id][id].includes('project_b'));
            await open(page);
            await page.getByRole('button', { name: `查看 MCP：${lostName}`, exact: true }).click();
            await scope.click();
            assert.equal(await project.getAttribute('aria-checked'), 'true');
            await project.click();
            await live.filter({ hasText: '已保存。' }).waitFor();
            await page.getByRole('button', { name: '添加 MCP 服务', exact: true }).click();
            const added = `Fixture added ${width}`;
            await input.fill(added);
            await page.getByLabel('MCP JSON 配置', { exact: true }).fill(JSON.stringify({ url: remote.url }));
            await page.getByLabel('MCP Token', { exact: true }).fill(remote.token);
            await save.click();
            await input.waitFor({ state: 'detached' });
            const addedSummary = page.getByRole('button', { name: `查看 MCP：${added}`, exact: true });
            await addedSummary.click();
            await page.getByRole('button', { name: `停用 MCP：${added}`, exact: true }).click();
            await page.getByRole('button', { name: `启用 MCP：${added}`, exact: true }).waitFor();
            await page.getByRole('button', { name: `删除 MCP：${added}`, exact: true }).click();
            await addedSummary.waitFor({ state: 'detached' });
            injected.push({ width, holdAfterHostAckMs: 800, duplicateClickWrites: 1,
                states: ['saving', 'saved', 'failed', 'unconfirmed'], checks: ['project-bind-reload-revoke', 'add-disable-delete'] });
        }
        await page.close();
    }
    assert.deepEqual(errors, []);
} catch (error) {
    errors.push(error.message);
    throw error;
} finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const close of cleanup.reverse()) await close();
    await writeFile(join(artifacts, 'report.json'), JSON.stringify({ samples, injected, errors }, null, 2) + '\n');
    console.log(artifacts);
}
