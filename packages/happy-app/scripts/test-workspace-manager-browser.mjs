#!/usr/bin/env node
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fork, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),src=join(repo,'packages/happy-app/sources');
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true,mode:0o700});
if(!existsSync(join(out,'node_modules')))symlinkSync(join(repo,'node_modules'),join(out,'node_modules'));
const path=relative=>join(src,relative);
const virtual={
    'react-native-unistyles':`export const useUnistyles=()=>({theme:{colors:{text:'#20222b',textSecondary:'#626977',textLink:'#6650b7',surface:'#fff',surfaceHigh:'#f2f3f7',divider:'#dfe1e7'}}});`,
    'expo-crypto':`export const randomUUID=()=>crypto.randomUUID();`,
    '@expo/vector-icons':`import React from 'react';export const Ionicons=()=>React.createElement('span',{'aria-hidden':true},'›');`,
    '@react-navigation/native':`import React from 'react';export const useFocusEffect=fn=>React.useEffect(fn,[fn]);`,
    'expo-router':`export const useLocalSearchParams=()=>({});`,
    '@/text':`import {workspacesZh} from ${JSON.stringify(path('text/workspaces.ts'))};export const t=key=>key.split('.').slice(1).reduce((v,k)=>v?.[k],workspacesZh)??key;`,
    '@/modal':`export const Modal={confirm:async()=>false};`,
    '@/hooks/useNavigateToSession':`export const useNavigateToSession=()=>()=>{};`,
    '@/sync/storage':`export const storage={getState:()=>({sessions:{}})};export const useSession=()=>({presence:'online',thinking:false});`,
    '@/sync/sync':`export const sync={ensureSessionReady:async()=>{}};`,
    './DotsConnectionsPanel':`export const DotsConnectionsPanel=()=>null;`,
    './DotDispatchDefaultsFields':`export const DotDispatchDefaultsFields=()=>null;`,
    './useDotDispatchOptions':`export const useDotDispatchOptions=()=>({});`,
    './DotRestartControl':`export const DotRestartControl=()=>null;`,
    './useDotsWorkspace':`export const useDotsWorkspace=()=>({ready:true,pendingCommands:[],pendingFor:()=>false,errorFor:()=>null,refreshing:false,error:null,projection:{snapshot:{dots:[{id:'fixture-dot',name:'验证助理',instruction:'隔离验收环境，无真实消息和记忆',sessionId:'fixture-session',status:'active'}],receipts:{}}},refresh:()=>{},retryArchive:()=>{}});`,
    './DotsWorkspacesPanel':`import React from 'react';import {WorkspaceManagerPanel} from ${JSON.stringify(path('components/dots/WorkspaceManagerPanel.tsx'))};import {workspaceManagerClient} from ${JSON.stringify(path('sync/workspaceManagement.ts'))};const current=()=>true;const client=workspaceManagerClient('fixture-owner',current);export const DotsWorkspacesPanel=({onClose})=>React.createElement(WorkspaceManagerPanel,{client,current,contextKey:'fixture-workspace',onClose});`,
    '@react-native-async-storage/async-storage':`export default {getItem:async key=>localStorage.getItem(key),setItem:async(key,value)=>localStorage.setItem(key,value),removeItem:async key=>localStorage.removeItem(key)};`,
};
await build({entryPoints:[join(repo,'packages/happy-app/scripts/fixtures/workspaceManager.browser.tsx')],outfile:join(out,'fixture.js'),bundle:true,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent',
    plugins:[{name:'isolated-ui-adapters',setup(b){
        b.onResolve({filter:/.*/},args=>Object.hasOwn(virtual,args.path)?{path:args.path,namespace:'fixture'}:undefined);
        b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:virtual[args.path],loader:'js',resolveDir:repo}));
        b.onResolve({filter:/^react-native$/},()=>({path:join(repo,'node_modules/react-native-web/dist/index.js')}));
        b.onResolve({filter:/^@slopus\/happy-wire$/},()=>({path:join(repo,'packages/happy-wire/src/index.ts')}));
        b.onResolve({filter:/^@\//},args=>{const p=path(args.path.slice(2));return {path:['.ts','.tsx','/index.ts'].map(s=>p+s).find(existsSync)};});
    }}]});
await build({entryPoints:[join(repo,'packages/happy-agent/src/automation/rest/fixtures/workspaceOwnerBrowserHarness.ts')],outfile:join(out,'harness.mjs'),bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent',
    plugins:[{name:'current-wire',setup(b){
        b.onResolve({filter:/^@slopus\/happy-wire$/},()=>({path:join(repo,'packages/happy-wire/src/index.ts')}));
        b.onResolve({filter:/^@slopus\/happy-wire\/serverUrl$/},()=>({path:join(repo,'packages/happy-wire/src/serverUrl.ts')}));
    }}]});
const child=fork(join(out,'harness.mjs'),[out],{stdio:['ignore','pipe','pipe','ipc']});let log='';child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
const ready=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('exit',code=>reject(Error(`Fixture exited ${code}: ${log}`)));});
const browser=await chromium.launch({headless:true}),evidence={isolated:true,root:ready.root,scenarios:[],consoleErrors:[],pageErrors:[],httpErrors:[],payloads:[]};
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
let phase='normal';page.on('console',msg=>{if(msg.type()==='error'&&!(phase==='unknown'&&msg.text().includes('net::ERR_FAILED')))evidence.consoleErrors.push(msg.text());});page.on('pageerror',e=>evidence.pageErrors.push(e.message));page.on('response',r=>{if(r.status()>=400)evidence.httpErrors.push({url:r.url(),status:r.status()});});
page.on('request',r=>{if(r.url().endsWith('/write'))evidence.payloads.push(JSON.parse(r.postData()??'{}'));});
const button=name=>page.getByRole('button',{name,exact:true});
const open=async()=>{await page.goto('http://127.0.0.1:20082/');await button('工作区').click();await page.getByText('Fixture Project',{exact:true}).waitFor();await page.getByText('正在核对权限与工作区…',{exact:true}).waitFor({state:'hidden'});};
const find=async name=>{const id=ready.workspaces[name].id,card=page.getByTestId(`workspace-${id}`);if(!await card.count()){await button('加载更多').click();await card.waitFor();}await card.getByRole('button',{name:'详情与证据',exact:true}).click();await button('返回列表').waitFor();await page.getByText(ready.workspaces[name].cwd,{exact:true}).first().waitFor();await page.getByText('正在检查目录、成果与占用…',{exact:true}).waitFor({state:'hidden'});};
const resolveNoChange=async()=>{await button('核验无代码改动').click();await button('确认核验并记录证据').click();await page.getByText('成果证据已记录',{exact:true}).waitFor();await button('生成回收计划').waitFor();};
const finalize = process.env.HAPPY_WORKSPACE_FINALIZE_FIXTURE === '1';
try {
    if (finalize) {
        const accept = async () => {
            await button('收尾已集成工作').click();
            await page.getByRole('textbox',{name:'业务验收证据'}).fill('Isolated business acceptance evidence');
            await button('归档证据并在核验通过后释放').click();
        };
        await open(); await find('ready');
        await page.getByText('等待 Workspace Owner 确认业务验收。',{exact:false}).first().waitFor();
        await accept(); await page.getByText('目录已回收',{exact:true}).first().waitFor();
        assert.equal(existsSync(ready.workspaces.ready.cwd),false);
        const request=evidence.payloads.find(v=>v.action==='finalize-integrated');
        await button('核对原请求回执').click();
        await page.getByText('重建与恢复资料',{exact:true}).waitFor();
        assert.equal(evidence.payloads.filter(p=>p.operationID===request.operationID).length,1);
        await page.screenshot({path:join(out,'finalize-ready.png'),fullPage:true});
        evidence.scenarios.push('authenticated acceptance -> archive -> real worktree removal -> original receipt');
        await button('返回列表').click(); await find('dirty'); await accept();
        await page.getByText('操作被拒绝或失败',{exact:true}).waitFor();
        assert.equal(readFileSync(join(ready.workspaces.dirty.cwd,'keep.txt'),'utf8'),'must retain\n');
        await page.screenshot({path:join(out,'finalize-retained.png'),fullPage:true});
        await button('返回列表').click(); await find('live'); await accept();
        await page.getByText('操作被拒绝或失败',{exact:true}).waitFor();
        await page.getByText('活跃或空闲会话、进程仍占用目录。',{exact:false}).first().waitFor();
        assert.ok(existsSync(ready.workspaces.live.cwd));
        evidence.scenarios.push('dirty and occupied worktrees retained with reason');
        evidence.actualFixtureRemoved=1;evidence.realUserDirectoriesRemoved=0;
    } else {
    await page.goto('http://127.0.0.1:20082/');await page.screenshot({path:join(out,'entry-desktop.png'),fullPage:true});
    await button('工作区').click();await page.getByText('Fixture Project',{exact:true}).waitFor();await page.getByText('正在核对权限与工作区…',{exact:true}).waitFor({state:'hidden'});
    await page.screenshot({path:join(out,'list-desktop.png'),fullPage:true});
    await find('dirty');await page.getByText('存在暂存、未暂存或未跟踪内容，需要先保全。',{exact:false}).first().waitFor();
    await button('生成回收计划').click();await page.getByText('此计划仍被保护条件阻挡，确认不能跳过这些检查。',{exact:true}).waitFor();assert.ok(await button('确认并回收').isDisabled());await page.screenshot({path:join(out,'dirty-protected.png'),fullPage:true});
    await button('返回列表').click();await find('live');await page.getByText('活跃或空闲会话、进程仍占用目录。',{exact:false}).first().waitFor();assert.ok(existsSync(ready.workspaces.live.cwd));
    evidence.scenarios.push('dirty and live-session protected');
    await button('返回列表').click();await find('ready');await resolveNoChange();await button('生成回收计划').click();await page.getByText('确认本次具体回收计划',{exact:true}).waitFor();
    assert.ok(await button('确认并回收').isDisabled());await page.screenshot({path:join(out,'plan-desktop.png'),fullPage:true});
    await page.getByRole('checkbox',{name:'我确认回收上方列出的这个目录'}).click();await button('确认并回收').dblclick();
    await page.getByText('目录已回收',{exact:true}).first().waitFor();assert.equal(existsSync(ready.workspaces.ready.cwd),false);
    await page.getByText('重建与恢复资料',{exact:true}).waitFor();
    assert.equal(await page.getByText('Git 或文件系统检查未能完成，目录继续保留。').count(),0);
    await page.screenshot({path:join(out,'receipt-desktop.png'),fullPage:true});
    evidence.scenarios.push('real Git plan -> explicit confirmed apply -> persistent removed receipt');
    await button('返回列表').click();await find('unknown-reply');await button('核验无代码改动').click();await button('确认核验并记录证据').click();await page.getByText('成果证据已记录',{exact:true}).first().waitFor();await button('生成回收计划').click();await page.getByRole('checkbox',{name:'我确认回收上方列出的这个目录'}).click();
    phase='unknown';await page.route('**/api/workspace-owner/v1/write',async route=>{const payload=route.request().postDataJSON();if(payload.action==='apply'){await route.fetch();await route.abort('failed');}else await route.continue();});
    await button('确认并回收').click();await page.getByText('操作结果尚不明确，请核对原请求，不要换编号重复提交。',{exact:true}).waitFor();
    const unknownPayload=evidence.payloads.filter(p=>p.action==='apply').at(-1);assert.ok(unknownPayload.operationID);assert.equal(existsSync(ready.workspaces['unknown-reply'].cwd),false);
    await page.unroute('**/api/workspace-owner/v1/write');await open();await page.getByText('操作结果尚不明确，请核对原请求，不要换编号重复提交。',{exact:true}).waitFor();
    await button('核对原请求回执').click();await page.getByText('目录已回收',{exact:true}).first().waitFor();phase='normal';
    assert.equal(evidence.payloads.filter(p=>p.action==='apply'&&p.operationID===unknownPayload.operationID).length,1);
    evidence.scenarios.push('POST completed + response lost -> refresh restores stable ID -> query original receipt, no resend');
    await button('回收记录').click();await page.getByTestId(`workspace-${ready.workspaces.ready.id}`).waitFor();await page.screenshot({path:join(out,'history-desktop.png'),fullPage:true});
    const result=await page.evaluate(async({id})=>{const response=await fetch('/api/workspace-owner/v1/read',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fixture-owner'},body:JSON.stringify({action:'result',machineID:'fixture-machine',projectID:'fixture-project',workspaceID:id})});return (await response.json()).data;},{id:ready.workspaces.ready.id});
    assert.ok(result.rebuild);execFileSync(result.rebuild.command,result.rebuild.args,{stdio:'pipe'});assert.equal(readFileSync(join(result.rebuild.args.at(-2),'base.txt'),'utf8'),'synthetic code\n');evidence.scenarios.push('retained ref and reconstruction instructions rebuild real fixture checkout');
    await page.setViewportSize({width:390,height:844});await open();await page.screenshot({path:join(out,'list-mobile.png'),fullPage:true});await find('legacy');await page.getByText('历史目录的托管归属尚未核实。',{exact:false}).first().waitFor();assert.ok(await button('核对并纳管此登记目录').isEnabled());await page.screenshot({path:join(out,'detail-mobile.png'),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));evidence.scenarios.push('390px mobile entry/list/detail with no horizontal overflow; legacy not auto-adopted');
    await button('核对并纳管此登记目录').click();await button('确认核验并记录证据').click();await page.getByText('目录托管身份已核实',{exact:true}).waitFor();
    await button('核验无代码改动').waitFor();await button('核验无代码改动').click();await button('确认核验并记录证据').click();await page.getByText('成果证据已记录',{exact:true}).waitFor();
    await button('生成回收计划').click();await page.getByRole('checkbox',{name:'我确认回收上方列出的这个目录'}).click();await page.screenshot({path:join(out,'plan-mobile.png'),fullPage:true});
    await button('确认并回收').click();await page.getByText('目录已回收',{exact:true}).first().waitFor();assert.equal(existsSync(ready.workspaces.legacy.cwd),false);
    await page.getByText('重建与恢复资料',{exact:true}).waitFor();await page.screenshot({path:join(out,'receipt-mobile.png'),fullPage:true});
    evidence.scenarios.push('mobile explicit adoption -> server result verification -> plan/confirm -> real removal and receipt/recovery data');
    evidence.actualFixtureRemoved=3;evidence.realUserDirectoriesRemoved=0;
    }
    assert.deepEqual(evidence.consoleErrors,[]);assert.deepEqual(evidence.pageErrors,[]);assert.deepEqual(evidence.httpErrors,[]);
    evidence.passed=true;
} catch(error) {evidence.failure=String(error);await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;
} finally {await browser.close();child.send('stop');await new Promise(r=>child.once('exit',r));writeFileSync(join(out,'browser.json'),JSON.stringify(evidence,null,2),{mode:0o600});writeFileSync(join(out,'harness.log'),log,{mode:0o600});}
console.log(JSON.stringify({passed:evidence.passed,scenarios:evidence.scenarios,screenshots:finalize?2:10,actualFixtureRemoved:evidence.actualFixtureRemoved}));
