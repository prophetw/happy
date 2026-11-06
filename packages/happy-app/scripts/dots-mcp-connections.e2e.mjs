// Isolated MCP panel fixture: no account, REST service, worker or external network.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(app, '../..');
const artifacts = path.join(repo, '.e2e-artifacts', `dots-mcp-connections-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(artifacts, { recursive: true });
const expectedConfig = { url: 'https://example.com/happy-control/mcp' };
const fixtureToken = 'hsvc1.fixture-connection.fixture-only-token';
const forbiddenSecret = /hsvc1/i;
const redactText = value => value.split(fixtureToken).join('[REDACTED_FIXTURE_TOKEN]');
const redact = value => typeof value === 'string' ? redactText(value) : Array.isArray(value) ? value.map(redact)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) : value;
const mocks = {
    'expo-crypto': `let id=0; export const randomUUID=()=>\`00000000-0000-4000-8000-\${String(++id).padStart(12,'0')}\`;`,
    'react-native-unistyles': `export const useUnistyles=()=>({theme:{colors:{text:'#171717',textSecondary:'#5f6368',surfaceHigh:'#eeeeee',divider:'#d4d4d4'}}});`,
    'fixture-apiSocket': `
        const clone=value=>JSON.parse(JSON.stringify(value));
        let view={revision:1,capabilities:{storedToken:1},connections:[],dots:[{id:'dot-a',name:'Dot A',connectionIDs:[]}]};
        window.__dotsMcpFixture={calls:[],view:()=>clone(view)};
        export const apiSocket={sessionRPC:async(sessionId,method,request)=>{
            window.__dotsMcpFixture.calls.push(clone({sessionId,method,request}));
            if(sessionId!=='workspace'||method!=='testloop-mcp-connections')throw Error('wrong_fixture_scope');
            if(request.action==='list')return {ok:true,data:clone(view)};
            if(request.revision!==view.revision)return {ok:false,error:'mcp_revision_changed'};
            if(request.action==='save'){
                const id=request.connectionID||'happy-control';
                const previous=view.connections.find(item=>item.id===id);
                const tokenConfigured=Object.hasOwn(request,'token')?request.token!==null:Boolean(previous?.tokenConfigured);
                const connection={id,name:request.name,config:clone(request.config),enabled:true,tokenConfigured,credentialSource:tokenConfigured?'stored':'none',checkedAt:'2026-11-05T00:00:00Z',error:null,tools:[{name:'happy_status',description:'Fixture tool'}]};
                view={revision:view.revision+1,capabilities:view.capabilities,connections:[...view.connections.filter(item=>item.id!==id),connection],dots:view.dots};
            }else if(request.action==='bind'){
                view={revision:view.revision+1,capabilities:view.capabilities,connections:view.connections,dots:view.dots.map(dot=>dot.id===request.dotId?{...dot,connectionIDs:clone(request.connectionIDs)}:dot)};
            }else throw Error('unsupported_fixture_mutation');
            return {ok:true,data:clone(view)};
        }};
    `,
};
let browser, server, failure = null;
const checks = [], errors = [], unexpectedRequests = [], evidence = [];
try {
    const bundle = await build({
        stdin: {
            contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {DotsMcpPanel} from './sources/components/dots/DotsMcpPanel';createRoot(document.getElementById('root')).render(<DotsMcpPanel sessionId="workspace" current={()=>true}/>);`,
            resolveDir: app,
            loader: 'tsx',
        },
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
        alias: { 'react-native': 'react-native-web', '@': path.join(app, 'sources') },
        plugins: [{ name: 'fixture-boundaries', setup(b) {
            b.onResolve({ filter: /.*/ }, args => {
                if (args.path === './apiSocket' && args.importer.endsWith('/sources/sync/dotsMcpConnections.ts')) return { path: 'fixture-apiSocket', namespace: 'mock' };
                return args.path in mocks ? { path: args.path, namespace: 'mock' } : undefined;
            });
            b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'tsx', resolveDir: app }));
        } }],
    });
    server = createServer((request, response) => {
        if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(bundle.outputFiles[0].contents);
        } else if (request.url === '/favicon.ico') {
            response.statusCode = 204;
            response.end();
        } else {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:system-ui}#root{width:100%;max-width:960px;min-height:100%;margin:0 auto;padding:16px}</style><div id="root"></div><script src="/bundle.js"></script></html>');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    for (const profile of [{ name: 'desktop', width: 1280, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, locale: 'zh-CN', serviceWorkers: 'block' });
        await context.route('**/*', route => {
            if (new URL(route.request().url()).origin !== origin) {
                unexpectedRequests.push(`${profile.name}:${route.request().url()}`);
                return route.abort();
            }
            return route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(`${profile.name}:page:${error.message}`));
        page.on('console', message => { if (message.type() === 'error') errors.push(`${profile.name}:console:${message.text()}`); });
        await page.goto(origin);
        await page.getByRole('heading', { name: 'MCP 工具', exact: true }).waitFor();
        await page.getByRole('button', { name: '添加 MCP 服务', exact: true }).click();
        await page.getByRole('button', { name: 'Happy Control 配置示例', exact: true }).click();
        assert.equal(await page.getByLabel('MCP 名称', { exact: true }).inputValue(), 'Happy Control');
        assert.deepEqual(JSON.parse(await page.getByLabel('MCP JSON 配置', { exact: true }).inputValue()), expectedConfig);
        const tokenField = page.getByLabel('MCP Token', { exact: true });
        await tokenField.waitFor();
        assert.equal(await tokenField.getAttribute('type'), 'password');
        await tokenField.fill(fixtureToken);
        assert.equal(await tokenField.inputValue() === fixtureToken, true, `${profile.name}: masked field did not receive fixture token`);
        assert.equal(await page.locator('input[type="password"]').count(), 1);
        const presetScreenshot = await page.screenshot({ path: path.join(artifacts, `${profile.name}-preset.png`), fullPage: true });
        assert.equal(presetScreenshot.includes(fixtureToken), false, `${profile.name}: fixture token bytes in masked screenshot`);
        checks.push(`${profile.name}:preset-url-and-masked-token-input`);

        await page.getByRole('button', { name: '检查并保存 MCP', exact: true }).click();
        await page.getByText('Happy Control · 检查通过', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('MCP Token', { exact: true }).count(), 0, `${profile.name}: token field remained after save`);
        const saveCalls = await page.evaluate(() => window.__dotsMcpFixture.calls);
        const save = saveCalls.find(call => call.request.action === 'save');
        assert(save, `${profile.name}: save RPC missing`);
        assert.equal(save.sessionId, 'workspace');
        assert.equal(save.method, 'testloop-mcp-connections');
        assert.equal(save.request.name, 'Happy Control');
        assert.deepEqual(save.request.config, expectedConfig);
        assert.deepEqual(Object.keys(save.request.config).sort(), ['url']);
        assert.equal(save.request.token === fixtureToken, true, `${profile.name}: save RPC did not receive exact fixture token`);

        await page.getByRole('button', { name: '编辑 MCP：Happy Control', exact: true }).click();
        const storedTokenField = page.getByLabel('MCP Token', { exact: true });
        assert.equal(await storedTokenField.inputValue() === '', true, `${profile.name}: stored token was prefilled`);
        assert.equal(await storedTokenField.getAttribute('type'), 'password');
        assert.equal(await storedTokenField.getAttribute('placeholder'), '已保存（留空保留）');
        await page.getByRole('checkbox', { name: '清除已保存 Token', exact: true }).click();
        await page.getByRole('button', { name: '检查并保存 MCP', exact: true }).click();
        await storedTokenField.waitFor({ state: 'detached' });
        const clearedCalls = await page.evaluate(() => window.__dotsMcpFixture.calls);
        const saves = clearedCalls.filter(call => call.request.action === 'save');
        assert.equal(saves.length, 2, `${profile.name}: expected initial and clear save RPCs`);
        assert.equal(saves[1].request.token === null, true, `${profile.name}: clear save RPC did not carry null token`);

        const checkbox = page.getByRole('checkbox', { name: '为 Dot A 启用 MCP Happy Control', exact: true });
        await checkbox.click();
        await page.waitForFunction(() => document.querySelector('[role="checkbox"]')?.getAttribute('aria-checked') === 'true');
        const calls = await page.evaluate(() => window.__dotsMcpFixture.calls);
        const bind = calls.find(call => call.request.action === 'bind');
        assert(bind, `${profile.name}: bind RPC missing`);
        assert.equal(bind.sessionId, 'workspace');
        assert.equal(bind.method, 'testloop-mcp-connections');
        assert.equal(bind.request.dotId, 'dot-a');
        assert.deepEqual(bind.request.connectionIDs, ['happy-control']);
        assert.deepEqual((await page.evaluate(() => window.__dotsMcpFixture.view())).dots[0].connectionIDs, ['happy-control']);
        checks.push(`${profile.name}:save-rpc-token-string-null-clear-and-dot-bind`);

        const dom = await page.evaluate(() => JSON.stringify({
            markup: document.documentElement.outerHTML,
            fields: [...document.querySelectorAll('input,textarea')].map(field => field.value),
        }));
        const storage = await page.evaluate(() => ({
            local: Object.entries(localStorage), session: Object.entries(sessionStorage), cookie: document.cookie,
        }));
        assert.equal(forbiddenSecret.test(dom), false, `${profile.name}: credential-like value in DOM`);
        assert.equal(forbiddenSecret.test(JSON.stringify(storage)), false, `${profile.name}: credential-like value in browser storage`);
        const overflow = await page.evaluate(() => ({
            document: document.documentElement.scrollWidth > innerWidth + 1,
            elements: [...document.querySelectorAll('*')].filter(element => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1);
            }).map(element => `${element.tagName}:${element.getAttribute('aria-label') || element.textContent?.slice(0, 40) || ''}`).slice(0, 10),
        }));
        assert.equal(overflow.document, false, `${profile.name}: document horizontal overflow`);
        assert.deepEqual(overflow.elements, [], `${profile.name}: element horizontal overflow`);
        const boundScreenshot = await page.screenshot({ path: path.join(artifacts, `${profile.name}-bound.png`), fullPage: true });
        assert.equal(boundScreenshot.includes(fixtureToken), false, `${profile.name}: fixture token bytes in bound screenshot`);
        evidence.push({ profile: profile.name, rpc: redact(calls), storage: { local: storage.local.length, session: storage.session.length, cookie: storage.cookie } });
        checks.push(`${profile.name}:token-cleared-no-dom-storage-screenshot-leak-or-horizontal-overflow`);
        await context.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
} catch (error) {
    failure = redactText(error instanceof Error ? error.message : String(error));
    throw new Error(failure);
} finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    const report = redact({ fixtureOnly: true, realLogin: false, realRest: false, realWorker: false, realStoredTokenEncryption: false,
        rpcEvidenceRedacted: true, externalNetwork: false, passed: !failure, failure, checks, errors, unexpectedRequests, evidence, browserClosed: true });
    const serialized = JSON.stringify(report, null, 2);
    assert.equal(forbiddenSecret.test(serialized), false, 'credential-like value in report');
    await writeFile(path.join(artifacts, 'report.json'), serialized + '\n');
    console.log(JSON.stringify(redact({ artifacts, checks: checks.length, errors, unexpectedRequests, failure })));
}
