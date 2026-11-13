// Browser timing of the real shared panel with isolated RPC delay injection.
// Never loads credentials, user data, or a real authorization endpoint.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const mode = baseline ? 'before' : 'after';
const scenariosOnly = process.argv.includes('--scenarios');
const samples = 6;
const artifacts = path.resolve(app, `../../.e2e-artifacts/dots-selection-latency/${mode}`);
await mkdir(artifacts, { recursive: true });
const mocks = {
    'fixture-react-native': `
        import React from 'react';import {Pressable as NativePressable} from 'react-native-web';
        export * from 'react-native-web';
        export const Pressable=({onPress,...props})=><NativePressable {...props} onPress={event=>{
            const start=performance.now();try{return onPress?.(event);}finally{window.__fixture.handlers.push({start,duration:performance.now()-start});}
        }}/>;
    `,
    '@/sync/sync': `export const sync={ensureSessionReady:async()=>{}};`,
    'expo-crypto': `let id=0;export const randomUUID=()=>String(++id);`,
    'react-native-unistyles': `export const useUnistyles=()=>({theme:{colors:{text:'#171717',textSecondary:'#5f6368',surfaceHigh:'#eee',divider:'#ccc'}}});`,
    'fixture-apiSocket': `
        const connection=id=>({id,name:id,enabled:true,config:{url:'https://fixture.invalid/mcp'},checkedAt:null,error:null,tools:[],
            control:{grantID:'fixture',machineID:'fixture',expiresAt:1900000000000,methods:[],projects:Array.from({length:5},(_,i)=>({id:'p'+i,directory:'/fixture/project-'+i}))}});
        let view={revision:1,connections:[connection('first'),connection('second')],dots:[{id:'dot-a',name:'Agent 开发',connectionIDs:['second'],projectBindings:{second:['p0']}}]};
        window.__fixture={calls:[],commits:[],handlers:[],delay:{list:500,bind:5000,'bind-projects':0},fail:null,view:()=>structuredClone(view)};
        export const apiSocket={sessionRPC:async(sessionId,method,request)=>{
            if(sessionId!=='workspace'||method!=='testloop-mcp-connections')throw Error('fixture_scope');
            const f=window.__fixture,call={...structuredClone(request),start:performance.now()};f.calls.push(call);
            await new Promise(resolve=>setTimeout(resolve,f.delay[request.action]||0));
            if(f.fail===request.action){call.end=performance.now();return {ok:false,error:'mcp_scope_denied'};}
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
            call.end=performance.now();if(f.fail==='transport'&&request.action==='bind')throw Error('fixture_lost_ack');return {ok:true,data:structuredClone(view)};
        }};
    `,
};
let browser, server, failure;
const errors=[],unexpectedRequests=[],httpErrors=[],results=[],checks=[],scenarios=[];
try {
    const bundle=await build({
        stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {DotsMcpPanel} from './sources/components/dots/DotsMcpPanel';createRoot(document.getElementById('root')).render(<React.Profiler id="panel" onRender={(id,phase,duration,base,start,commit)=>window.__fixture.commits.push({phase,duration,commit})}><DotsMcpPanel sessionId="workspace" current={()=>true}/></React.Profiler>);`,resolveDir:app,loader:'tsx'},
        bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',
        define:{__DEV__:'false','process.env.NODE_ENV':'"development"'},
        alias:{'react-native':'react-native-web','@':path.join(app,'sources')},
        plugins:[{name:'fixture-boundaries',setup(b){
            b.onLoad({filter:/\/DotsMcpPanel\.tsx$/},async args=>{
                const source=baseline?execFileSync('git',['show','f78361d35:packages/happy-app/sources/components/dots/DotsMcpPanel.tsx'],{cwd:app,encoding:'utf8'}):await readFile(args.path,'utf8');
                return {contents:source.replace("from 'react-native';", "from 'fixture-react-native';"),loader:'tsx',resolveDir:path.join(app,'sources/components/dots')};
            });
            b.onResolve({filter:/.*/},args=>{
                if(args.path==='./apiSocket'&&args.importer.endsWith('/sources/sync/dotsMcpConnections.ts'))return {path:'fixture-apiSocket',namespace:'mock'};
                return args.path in mocks?{path:args.path,namespace:'mock'}:undefined;
            });
            b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'tsx',resolveDir:app}));
        }}],
    });
    server=createServer((req,res)=>{
        if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}
        else if(req.url==='/favicon.ico'){res.statusCode=204;res.end();}
        else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;font-family:system-ui}#root{max-width:900px;margin:auto;padding:16px}</style><div id="root"></div><script src="/bundle.js"></script></html>');}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(20080,'127.0.0.1',resolve);});
    const origin='http://127.0.0.1:20080';
    browser=await chromium.launch({headless:true});
    for(const profile of [{name:'desktop',width:1280,height:1000},{name:'mobile',width:390,height:844}]){
        const context=await browser.newContext({viewport:{width:profile.width,height:profile.height},serviceWorkers:'block'});
        await context.route('**/*',route=>{
            if(new URL(route.request().url()).origin!==origin){unexpectedRequests.push(route.request().url());return route.abort();}
            return route.continue();
        });
        const page=await context.newPage();
        page.on('pageerror',e=>errors.push(e.message));
        page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
        page.on('response',r=>{if(r.status()>=400)httpErrors.push({url:r.url(),status:r.status()});});
        const parent=page.getByRole('checkbox',{name:'为 Agent 开发 启用 MCP first',exact:true});
        for(let index=0;index<(scenariosOnly?0:samples);index++){
            await page.goto(origin);
            await parent.waitFor();
            await page.waitForFunction(()=>window.__fixture.calls[0]?.end);
            await page.evaluate(()=>{
                const f=window.__fixture;f.longtasks=[];
                new PerformanceObserver(list=>f.longtasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:false});
                f.timing={};
                document.addEventListener('click',()=>{
                    const t=f.timing;t.click=performance.now();queueMicrotask(()=>t.handlerMicrotask=performance.now());
                    const scan=()=>{
                        const p=document.querySelector('[aria-label="为 Agent 开发 启用 MCP first"]');
                        const nodes=[...document.querySelectorAll('[aria-label^="为 Agent 开发 启用项目"]')].slice(0,5);
                        for(const [key,ready]of [['parent',p?.getAttribute('aria-checked')==='true'],['all',nodes.length===5&&nodes.every(n=>n.getAttribute('aria-checked')==='true')]]){
                            if(ready&&!t[key+'Commit']){t[key+'Commit']=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>t[key+'Frame']=performance.now()));}
                        }
                    };
                    new MutationObserver(scan).observe(document.getElementById('root'),{subtree:true,childList:true,attributes:true});scan();
                },{capture:true,once:true});
            });
            await parent.click();
            if(!baseline){
                await page.waitForFunction(()=>window.__fixture.timing.allFrame);
                assert.equal(await page.getByText('正在保存选择（勾选为待保存状态）',{exact:true}).count(),1);
                assert.equal(await page.getByText('已保存。',{exact:true}).count(),0);
                assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(c=>c.action!=='list'&&c.end).length),0);
                if(index===0)await page.screenshot({path:path.join(artifacts,`${profile.name}-pending.png`),fullPage:true});
            }
            await page.getByText('已保存。',{exact:true}).waitFor({timeout:20000});
            await page.waitForFunction(()=>window.__fixture.timing.allFrame);
            const record=await page.evaluate(()=>{
                const f=window.__fixture,t=f.timing,c=f.calls.filter(c=>c.action!=='list');
                return {parentMs:t.parentFrame-t.click,allMs:t.allFrame-t.click,parentCommitMs:t.parentCommit-t.click,allCommitMs:t.allCommit-t.click,
                    handlerMs:Math.max(...f.handlers.filter(h=>h.start>=t.click).map(h=>h.duration)),saveMs:Math.max(...c.map(c=>c.end))-t.click,rpc:c.map(c=>({action:c.action,waitMs:c.end-c.start})),
                    listMs:f.calls[0].end-f.calls[0].start,reactCommits:f.commits.filter(c=>c.commit>=t.click),longtasks:f.longtasks.filter(l=>l.start>=t.click),view:f.view()};
            });
            assert.deepEqual(record.rpc.map(c=>c.action),['bind','bind-projects']);
            assert.deepEqual(record.view.dots[0].projectBindings,{second:['p0'],first:['p0','p1','p2','p3','p4']});
            results.push({profile:profile.name,index,...record});
        }
        if(scenariosOnly){
            const fresh=async()=>{await page.goto(origin);await parent.waitFor();await page.waitForFunction(()=>window.__fixture.calls[0]?.end);await page.evaluate(()=>window.__fixture.delay={list:0,bind:0,'bind-projects':0});};
            const saved=()=>page.getByText('已保存。',{exact:true}).waitFor();
            const child=id=>page.getByRole('checkbox',{name:`为 Agent 开发 启用项目 ${id}`,exact:true}).first();
            await fresh();await parent.click();await saved();
            await page.evaluate(()=>{
                window.__fixture.delay['bind-projects']=5000;
                document.addEventListener('click',()=>{
                    const f=window.__fixture;f.childStart=performance.now();
                    const observer=new MutationObserver(()=>{
                        const node=document.querySelector('[aria-label="为 Agent 开发 启用项目 p0"]');
                        if(node?.getAttribute('aria-checked')==='false'){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>f.childFrame=performance.now()));}
                    });observer.observe(document.getElementById('root'),{subtree:true,childList:true,attributes:true});
                },{capture:true,once:true});
            });
            await child('p0').click();await page.waitForFunction(()=>window.__fixture.childFrame);
            if(!baseline)assert.equal(await page.getByText('正在保存选择（勾选为待保存状态）',{exact:true}).count(),1);
            await saved();
            const childTiming=await page.evaluate(()=>({visualMs:window.__fixture.childFrame-window.__fixture.childStart,waitMs:window.__fixture.calls.at(-1).end-window.__fixture.calls.at(-1).start}));
            assert.deepEqual(await page.evaluate(()=>window.__fixture.view().dots[0].projectBindings.first),['p1','p2','p3','p4']);
            scenarios.push({profile:profile.name,childTiming});
            if(!baseline){
                await fresh();await page.evaluate(()=>window.__fixture.delay.bind=1000);
                await parent.click();await parent.click();await saved();
                let data=await page.evaluate(()=>({view:window.__fixture.view(),calls:window.__fixture.calls}));
                assert.deepEqual(data.view.dots[0].connectionIDs,['second']);
                assert.deepEqual(data.calls.filter(c=>c.action!=='list').map(c=>c.action),['bind','bind']);
                assert.deepEqual(data.view.dots[0].projectBindings,{second:['p0']});
                await fresh();await page.evaluate(()=>window.__fixture.delay.bind=1000);
                await parent.click();await child('p0').click();await saved();
                data=await page.evaluate(()=>({view:window.__fixture.view(),calls:window.__fixture.calls}));
                assert.deepEqual(data.view.dots[0].projectBindings.first,['p1','p2','p3','p4']);
                assert.equal(data.calls.filter(c=>c.action==='bind-projects').length,1);
                await fresh();await page.evaluate(()=>{window.__fixture.fail='bind';window.__fixture.delay.bind=200;});
                await parent.click();await page.getByRole('alert').waitFor();
                assert.equal(await parent.getAttribute('aria-checked'),'false');
                assert.equal(await page.getByText('已保存。',{exact:true}).count(),0);
                await fresh();await page.evaluate(()=>window.__fixture.fail='transport');
                await parent.click();await page.getByRole('alert').waitFor();
                assert.equal(await parent.getAttribute('aria-checked'),'false');
                assert.equal(await parent.getAttribute('aria-disabled'),'true');
                await page.evaluate(()=>window.__fixture.fail=null);
                await page.getByRole('button',{name:'刷新 MCP 连接',exact:true}).click();
                await page.waitForFunction(()=>document.querySelector('[aria-label="为 Agent 开发 启用 MCP first"]')?.getAttribute('aria-checked')==='true');
                assert.equal(await child('p0').getAttribute('aria-checked'),'false');
                assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(c=>c.action!=='list').length),1);
                checks.push(`${profile.name}:pending-child-5s,parent-cancel,coalesced-child,rollback,unknown-write-read-reconciliation`);
            }
        } else checks.push(`${profile.name}:six-slow-parent-samples-and-exact-payload`);
        console.log(JSON.stringify({mode,profile:profile.name,samples}));
        await context.close();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[]);assert.deepEqual(unexpectedRequests,[]);
}catch(error){failure=String(error);throw error;}
finally{
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
    const stats=values=>{const s=[...values].sort((a,b)=>a-b);return {p50:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1],max:s.at(-1)};};
    const summary=Object.fromEntries(['desktop','mobile'].map(profile=>[profile,Object.fromEntries(['parentMs','allMs','saveMs','listMs','handlerMs'].map(key=>[key,stats(results.filter(r=>r.profile===profile).map(r=>r[key]))]))]));
    const source=baseline?execFileSync('git',['show','f78361d35:packages/happy-app/sources/components/dots/DotsMcpPanel.tsx'],{cwd:app}):await readFile(path.join(app,'sources/components/dots/DotsMcpPanel.tsx'));
    await writeFile(path.join(artifacts,scenariosOnly?'scenarios-report.json':'report.json'),JSON.stringify({mode,sourceSha256:createHash('sha256').update(source).digest('hex'),fixtureOnly:true,injectedBindDelayMs:5000,samplesPerProfile:samples,passed:!failure,failure,checks,summary,scenarios,errors,httpErrors,unexpectedRequests,results},null,2));
    console.log(JSON.stringify({artifacts,mode,summary,errors,httpErrors,unexpectedRequests,failure}));
}
