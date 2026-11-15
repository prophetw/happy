// Isolated real shared component, mock RPC only; no login or real grants.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.resolve(app, '../../.e2e-artifacts/dots-parent-selection');
await mkdir(artifacts, { recursive: true });
const mocks = {
    '@/sync/sync': `export const sync={ensureSessionReady:async()=>{}};`,
    'expo-crypto': `let id=0;export const randomUUID=()=>String(++id);`,
    'react-native-unistyles': `export const useUnistyles=()=>({theme:{colors:{text:'#171717',textSecondary:'#5f6368',surfaceHigh:'#eee',divider:'#ccc'}}});`,
    'fixture-apiSocket': `
        const connection=id=>({id,name:id,enabled:true,config:{url:'https://fixture.invalid/mcp'},checkedAt:null,error:null,tools:[],
            control:{grantID:'fixture',machineID:'fixture',expiresAt:1900000000000,methods:[],projects:[{id:'a',directory:'/fixture/a'},{id:'b',directory:'/fixture/b'}]}});
        let view={revision:1,connections:[connection('first'),connection('second')],dots:[{id:'dot-a',name:'Agent 开发',connectionIDs:['second'],projectBindings:{second:['a']}}]};
        window.__fixture={calls:[],view:()=>structuredClone(view),add:()=>view.connections[0].control.projects.push({id:'future',directory:'/fixture/future'})};
        export const apiSocket={sessionRPC:async(sessionId,method,request)=>{
            window.__fixture.calls.push(structuredClone(request));
            if(sessionId!=='workspace'||method!=='testloop-mcp-connections')throw Error('fixture_scope');
            if(request.action!=='list'){
                if(request.revision!==view.revision)throw Error('fixture_revision');
                const dot=view.dots[0];
                if(request.action==='bind'){
                    dot.connectionIDs=request.connectionIDs;
                    for(const id of Object.keys(dot.projectBindings))if(!dot.connectionIDs.includes(id))delete dot.projectBindings[id];
                }else if(request.action==='bind-projects'){
                    if(!dot.connectionIDs.includes(request.connectionID))throw Error('fixture_binding');
                    dot.projectBindings[request.connectionID]=request.projectIDs;
                }else throw Error('fixture_action');
                view.revision++;
            }
            return {ok:true,data:structuredClone(view)};
        }};
    `,
};
let browser, server, failure;
const errors=[],unexpectedRequests=[],httpErrors=[],checks=[],evidence=[];
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
    await new Promise(resolve => server.listen(Number(process.env.DOTS_FIXTURE_PORT ?? '20080'), '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    for (const profile of [{name:'desktop',width:1280,height:1000},{name:'mobile',width:390,height:844}]) {
        const context=await browser.newContext({viewport:{width:profile.width,height:profile.height},serviceWorkers:'block'});
        await context.route('**/*',route=>{
            if(new URL(route.request().url()).origin!==origin){unexpectedRequests.push(route.request().url());return route.abort();}
            return route.continue();
        });
        const page=await context.newPage();
        page.on('pageerror',e=>errors.push(e.message));
        page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
        page.on('response',r=>{if(r.status()>=400)httpErrors.push({url:r.url(),status:r.status()});});
        await page.goto(origin);
        const parent=page.getByRole('checkbox',{name:'为 Agent 开发 启用 MCP first',exact:true});
        await parent.waitFor();
        const child=id=>page.getByRole('checkbox',{name:`为 Agent 开发 启用项目 ${id}`,exact:true}).first();
        const wait=async predicate=>page.waitForFunction(predicate);
        await parent.click();
        await wait(()=>window.__fixture.view().dots[0].projectBindings.first?.length===2);
        assert.equal(await child('a').getAttribute('aria-checked'),'true');
        assert.equal(await child('b').getAttribute('aria-checked'),'true');
        await page.screenshot({path:path.join(artifacts,`${profile.name}-all-selected.png`),fullPage:true});
        await child('a').click();
        await wait(()=>JSON.stringify(window.__fixture.view().dots[0].projectBindings.first)==='["b"]');
        await page.evaluate(()=>window.__fixture.add());
        await page.getByRole('button',{name:'刷新 MCP 连接',exact:true}).click();
        await child('future').waitFor();
        assert.equal(await child('a').getAttribute('aria-checked'),'false');
        assert.equal(await child('future').getAttribute('aria-checked'),'false');
        assert.equal(await parent.getAttribute('aria-checked'),'true');
        let data=await page.evaluate(()=>({view:window.__fixture.view(),calls:window.__fixture.calls}));
        assert.deepEqual(data.view.dots[0].projectBindings,{second:['a'],first:['b']});
        assert.deepEqual(data.calls.filter(c=>c.action==='bind-projects').map(c=>c.projectIDs),[['a','b'],['b']]);
        await page.screenshot({path:path.join(artifacts,`${profile.name}-partial-after-refresh.png`),fullPage:true});
        await child('b').click();
        await wait(()=>window.__fixture.view().dots[0].projectBindings.first?.length===0);
        assert.equal(await parent.getAttribute('aria-checked'),'true');
        await parent.click();
        await wait(()=>!window.__fixture.view().dots[0].connectionIDs.includes('first'));
        data=await page.evaluate(()=>({view:window.__fixture.view(),calls:window.__fixture.calls}));
        assert.deepEqual(data.view.dots[0].projectBindings,{second:['a']});
        evidence.push({profile:profile.name,...data});
        checks.push(`${profile.name}:parent-selects-all,child-deselect-payload,refresh-no-expansion,read-only-empty,parent-clear,group-isolation`);
        await context.close();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(unexpectedRequests,[]);assert.deepEqual(httpErrors,[]);
} catch(error) { failure=String(error);throw error; }
finally {
    if(browser)await browser.close();
    if(server)await new Promise(resolve=>server.close(resolve));
    await writeFile(path.join(artifacts,'report.json'),JSON.stringify({fixtureOnly:true,passed:!failure,failure,checks,errors,httpErrors,unexpectedRequests,evidence},null,2));
    console.log(JSON.stringify({artifacts,checks,errors,httpErrors,unexpectedRequests,failure}));
}
