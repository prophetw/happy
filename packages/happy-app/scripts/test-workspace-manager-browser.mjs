#!/usr/bin/env node
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fork, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { once } from 'node:events';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),src=join(repo,'packages/happy-app/sources');
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true,mode:0o700});
if(!existsSync(join(out,'node_modules')))symlinkSync(join(repo,'node_modules'),join(out,'node_modules'));
const path=relative=>join(src,relative);
const virtual={
    'react-native-unistyles':`export const useUnistyles=()=>({rt:{themeName:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'},theme:{colors:{text:'#20222b',textSecondary:'#626977',textLink:'#6650b7',surface:'#fff',surfaceHigh:'#f2f3f7',divider:'#dfe1e7'}}});`,
    'expo-crypto':`export const randomUUID=()=>crypto.randomUUID();`,
    '@expo/vector-icons':`import React from 'react';export const Ionicons=()=>React.createElement('span',{'aria-hidden':true},'›');`,
    '@react-navigation/native':`import React from 'react';export const useFocusEffect=fn=>React.useEffect(fn,[fn]);`,
    'expo-router':`export const useLocalSearchParams=()=>({});`,
    '@/text':`import {workspacesZh} from ${JSON.stringify(path('text/workspaces.ts'))};export const t=key=>key.split('.').slice(1).reduce((v,k)=>v?.[k],workspacesZh)??key;`,
    '@/modal':`export const Modal={confirm:async()=>false};`,
    '@/hooks/useNavigateToSession':`export const useNavigateToSession=()=>()=>{};`,
    '@/sync/storage':`export const storage={getState:()=>({sessions:{}})};export const useSession=()=>({presence:'online',thinking:false});`,
    '@/sync/sync':`export const sync={ensureSessionReady:async()=>{},getCredentials:()=>({token:'fixture-owner',secret:'fixture-secret'})};`,
    '@/auth/AuthContext':`export const useAuth=()=>({credentials:{token:'fixture-owner',secret:'fixture-secret'},isAuthenticated:true});`,
    '@/sync/serverConfig':`export const getServerUrl=()=>window.location.origin;`,
    '@/sync/apiSocket':`export const apiSocket={machineRPC:()=>{throw Error('Web fixture uses same-origin transport')}};`,
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
if (process.env.HAPPY_WORKSPACE_ONE_CLICK_FIXTURE==='1') {
    await build({entryPoints:[join(repo,'packages/happy-agent/src/automation/rest/workspaceIdleProof.ts')],
        outfile:join(out,'idle-close.mjs'),bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent',
        plugins:[{name:'idle-wire',setup(b){
            b.onResolve({filter:/^@slopus\/happy-wire$/},()=>({path:join(repo,'packages/happy-wire/src/index.ts')}));
            b.onResolve({filter:/^@slopus\/happy-wire\/serverUrl$/},()=>({path:join(repo,'packages/happy-wire/src/serverUrl.ts')}));
        }}]});
}
let child, log = "";
const start = async root => {
    child=fork(join(out,'harness.mjs'),[out],{stdio:['ignore','pipe','pipe','ipc'],
        env:{...process.env,...(root?{HAPPY_WORKSPACE_RESTART_ROOT:root}:{})}});
    log='';
    child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
    return new Promise((resolve,reject)=>{child.once('message',resolve);child.once('exit',code=>reject(Error(`Fixture exited ${code}: ${log}`)));});
};
const ready=await start();
const browser=await chromium.launch({headless:true}),evidence={isolated:true,root:ready.root,scenarios:[],consoleErrors:[],pageErrors:[],httpErrors:[],payloads:[]};
const context=await browser.newContext({viewport:{width:1440,height:1000}});
context.setDefaultTimeout(22_000);
let page=await context.newPage();
let phase='normal';
if (process.env.HAPPY_WORKSPACE_ONE_CLICK_FIXTURE!=='1') {
    await context.route('**/api/workspace-owner/v1/read',async route=>{
        const response=await route.fetch();
        const packet=await response.json();
        if (packet?.data?.item) delete packet.data.item.canRequestReclaim;
        for(const row of packet?.data?.items??[])delete row.canRequestReclaim;
        await route.fulfill({response,json:packet});
    });
}
const observePage=()=>{page.on('console',msg=>{if(msg.type()==='error'&&!(phase==='unknown'&&msg.text().includes('net::ERR_FAILED')))evidence.consoleErrors.push(msg.text());});page.on('pageerror',e=>evidence.pageErrors.push(e.message));page.on('response',r=>{if(r.status()>=400)evidence.httpErrors.push({url:r.url(),status:r.status()});});
page.on('request',r=>{if(r.url().endsWith('/write')||r.url().endsWith('/delivery')||r.url().endsWith('/reclaim'))evidence.payloads.push(JSON.parse(r.postData()??'{}'));});};
observePage();
const button=name=>page.getByRole('button',{name,exact:true});
const open=async()=>{await page.goto('http://127.0.0.1:20082/');await button('项目工作区').click();await page.getByText('Fixture Project',{exact:true}).waitFor();await page.getByText('正在核对权限与工作区…',{exact:true}).waitFor({state:'hidden'});};
const find=async name=>{const id=ready.workspaces[name].id,card=page.getByTestId(`workspace-${id}`);if(!await card.count()){await button('加载更多').click();await card.waitFor();}await card.getByRole('button',{name:'详情与证据',exact:true}).click();await button('返回列表').waitFor();await page.getByText(ready.workspaces[name].cwd,{exact:true}).first().waitFor();await page.getByText('正在检查目录、成果与占用…',{exact:true}).waitFor({state:'hidden'});};
const resolveNoChange=async()=>{await button('核验无代码改动').click();await button('确认核验并记录证据').click();await page.getByText('成果证据已记录',{exact:true}).waitFor();await button('生成回收计划').waitFor();};
const finalize = process.env.HAPPY_WORKSPACE_FINALIZE_FIXTURE === '1';
try {
    if (process.env.HAPPY_WORKSPACE_ONE_CLICK_FIXTURE==='1') {
        const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:'pipe'}).trim();
        await page.setViewportSize({width:440,height:956});
        await page.emulateMedia({colorScheme:'dark'});
        await open();
        const row=page.getByTestId('workspace-'+ready.workspaces.live.id);
        if(!await row.count())await button('加载更多').click();
        const reclaim=row.getByRole('button',{name:'回收',exact:true});
        await reclaim.click();
        await row.getByText('正在等待回收',{exact:true}).waitFor();
        assert.equal(evidence.payloads.length,1);
        await row.screenshot({path:join(out,'one-click-waiting.png')});
        await page.close();
        const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
        const resumed=await start(ready.root);
        assert.notEqual(ready.pid,resumed.pid);
        const cwd=ready.workspaces.live.cwd;
        writeFileSync(join(ready.root,'release-idle'),'allow cooperative close');
        const started=Date.now();
        while(existsSync(cwd)&&Date.now()-started<130_000) await new Promise(resolve=>setTimeout(resolve,250));
        assert.ok(!existsSync(cwd));
        assert.ok(!git(ready.repo,'worktree','list','--porcelain').includes(cwd));
        assert.equal(readFileSync(join(ready.root,'thread-history'),'utf8'),'fixture-thread saved');
        page=await context.newPage();observePage();
        await open();
        await button('回收记录').click();
        const card=page.getByTestId('workspace-'+ready.workspaces.live.id);
        await card.getByText('已回收',{exact:true}).first().waitFor();
        await card.getByRole('button',{name:'查看／恢复保留资料'}).click();
        await page.getByText('保留资料位于执行电脑',{exact:true}).waitFor();
        await page.getByText('原请求 · send-live',{exact:true}).waitFor();
        const detail=await page.evaluate(async id=>{
            const response=await fetch('/api/workspace-owner/v1/read',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fixture-owner'},
                body:JSON.stringify({action:'detail',machineID:'fixture-machine',projectID:'fixture-project',workspaceID:id,guidance:true,reclaim:true})});
            return (await response.json()).data;
        },ready.workspaces.live.id);
        assert.equal(detail.item.reclaimRequest.state,'released');
        const archive=detail.item.reclaimRequest.archive;
        assert.deepEqual(readFileSync(join(archive.temporary,'fixture-7.data')),Buffer.from([7,255,2]));
        const commands=readFileSync(join(archive.directory,'RECOVERY.txt'),'utf8').split('\n').filter(line=>line.startsWith('git ')||line.startsWith('tar '));
        execFileSync('/bin/bash',['-e','-o','pipefail','-c',commands.join('\n')],{stdio:'pipe'});
        assert.ok(git(ready.repo,'worktree','list','--porcelain').includes('/restored/'+ready.workspaces.live.id));
        assert.equal(evidence.payloads.length,1);
        evidence.reclamation={operationID:detail.item.reclaimRequest.operationID,registrationAbsent:true,recoveryTested:true,servicePIDs:[ready.pid,resumed.pid]};
        evidence.scenarios.push('one list click, close page and restart Owner, cooperative dedicated process saves history and exits, real Git registration removed, temporary bytes restored with documented recovery');
        await page.screenshot({path:join(out,'released-recovery-440.png'),fullPage:true});
        evidence.actualFixtureRemoved=1;evidence.realUserDirectoriesRemoved=0;
    } else if (process.env.HAPPY_WORKSPACE_GUIDANCE_FIXTURE==='1') {
        const notice=page.getByTestId('workspace-reclaim-notice');
        const scoped=name=>page.getByTestId('workspace-'+ready.workspaces[name].id).getByTestId('workspace-reclaim-notice');
        const alert=box=>box.getByRole('alert').filter({hasText:'暂时不能回收'});
        await page.setViewportSize({width:440,height:956});
        await page.emulateMedia({colorScheme:'light'});
        await open();
        const live=page.getByTestId('workspace-'+ready.workspaces.live.id);
        if(!await live.count())await button('加载更多').click();
        const waiting=page.getByTestId('workspace-'+ready.workspaces.ready.id);
        if(!await waiting.count())await button('加载更多').click();
        await alert(scoped('live')).waitFor();
        assert.match(await scoped('live').innerText(),/临时目录.*1/);
        assert.match(await scoped('live').innerText(),/检测到工作区仍被占用/);
        assert.match(await scoped('live').innerText(),/手动回收/);
        assert.match(await scoped('ready').innerText(),/条件满足后，宿主会自动重新检查并继续/);
        assert.doesNotMatch(await scoped('ready').innerText(),/需要你处理/);
        await scoped('live').screenshot({path:join(out,'list-light-440.png')});

        await page.goto('http://127.0.0.1:20082/?task='+encodeURIComponent(ready.workspaces.live.cwd));
        await alert(notice).waitFor();
        assert.match(await notice.innerText(),/临时目录.*1/);
        await notice.screenshot({path:join(out,'original-task-card.png')});
        await button('查看回收条件').click();
        await page.emulateMedia({colorScheme:'dark'});
        await open();
        await find('live');
        await alert(notice.first()).waitFor();
        const rect=await alert(notice.first()).boundingBox();
        assert.ok(rect&&rect.y>=0&&rect.y+rect.height<956);
        await button('重新检查').first().click({trial:true});
        const color=await notice.first().evaluate(el=>getComputedStyle(el).backgroundColor);
        assert.equal(color,'rgb(70, 24, 32)');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await page.screenshot({path:join(out,'detail-dark-440-first-screen.png')});
        await page.getByText(/keep-report\.txt/).waitFor();
        const beforeRecheck=evidence.payloads.length;
        await button('生成回收计划').click();
        await page.getByText(/保护条件阻挡/).waitFor();
        assert.ok(await button('确认并回收').isDisabled());
        const cleared=once(child,'message');child.send('clear-fixture-blockers');assert.equal((await cleared)[0].kind,'cleared');
        await button('重新检查').first().click();
        await notice.first().getByText(/临时目录中有来源未核实的资料/).waitFor({state:'hidden'});
        await page.getByText(/历史工作区，需要手动回收/).first().waitFor();
        assert.doesNotMatch(await notice.first().innerText(),/检测到工作区仍被占用|临时目录中有来源未核实的资料/);
        assert.equal(evidence.payloads.length,beforeRecheck+1,'recheck does not make another plan or mutation');
        await page.screenshot({path:join(out,'rechecked-dark-440.png')});
        await resolveNoChange();
        await button('生成回收计划').click();
        await page.getByRole('checkbox',{name:'我确认回收上方列出的这个目录'}).click();
        await button('确认并回收').click();
        await notice.first().getByText('已回收',{exact:true}).waitFor();
        assert.doesNotMatch(await notice.first().innerText(),/暂时不能回收|继续检查/);
        evidence.scenarios.push('two simultaneous blockers on list, original task card and detail; older workspace manual and active automatic wait; 440px theme and first-screen action; read-only refresh; final receipt wins');
        evidence.actualFixtureRemoved=1;evidence.realUserDirectoriesRemoved=0;
    } else if (process.env.HAPPY_WORKSPACE_RECLAIM_FIXTURE === '1') {
        const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:'pipe'}).trim();
        await open();
        console.log('opened workspace list');
        await find('ready');
        await page.getByText(/等待回收/).waitFor();
        assert.equal(await button('生成回收计划').count(),0);
        await page.getByText('原请求 · send-ready',{exact:true}).waitFor();
        console.log('confirmed original task is waiting');
        await page.close();
        const exit=once(child,'exit');child.kill('SIGKILL');await exit;
        const instance=await start(ready.root);
        assert.notEqual(instance.pid,ready.pid);
        console.log('restarted owner with browser closed');
        evidence.servicePIDs=[ready.pid,instance.pid];
        git(ready.repo,'init','--bare',ready.remote);
        const workspace=ready.workspaces.ready.cwd;
        const head=git(workspace,'rev-parse','HEAD');
        git(ready.repo,'push','origin','main');
        const deadline=Date.now()+95_000;
        while(existsSync(workspace)&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,250));
        console.log('completed background wait');
        assert.ok(!existsSync(workspace),'background must remove the worktree while no browser page is open');
        assert.ok(!git(ready.repo,'worktree','list','--porcelain').includes(workspace));
        const ipc=once(child,'message');child.send('background-result');
        const [record]=await ipc;
        assert.equal(record.requestID,'send-ready');
        assert.equal(record.result.operation.state,'removed');
        assert.equal(record.receipt.data.execution.reclaimState,'released');
        assert.equal(record.receipt.data.execution.reclaimOperationID,record.result.operation.id);
        assert.equal(git(ready.repo,'rev-parse',record.result.disposition.retainedRef),head);
        assert.equal(readFileSync(join(ready.workspaces.dirty.cwd,'keep.txt'),'utf8'),'must retain\n');
        assert.ok(existsSync(ready.workspaces.live.cwd));
        evidence.reclamation={operationID:record.result.operation.id,requestID:record.requestID,head,retainedRef:record.result.disposition.retainedRef,
            receipt:record.result.operation.removal,directoryAbsent:record.absent,gitRegistrationAbsent:true};
        page=await context.newPage();
        observePage();
        await open();
        await button('回收记录').click();
        const card=page.getByTestId('workspace-'+ready.workspaces.ready.id);
        await card.getByText('已回收',{exact:true}).first().waitFor();
        await card.getByRole('button',{name:'详情与证据',exact:true}).click();
        await page.getByText('原请求 · send-ready',{exact:true}).waitFor();
        await page.screenshot({path:join(out,'automatic-reclaim-after-restart.png'),fullPage:true});
        evidence.scenarios.push('normal project navigation and original request, page closed, owner restarted, remote restored, background no-change receipt in history; dirty/busy retained');
        assert.deepEqual(evidence.payloads,[]);
        assert.deepEqual(evidence.consoleErrors,[]);
        assert.deepEqual(evidence.pageErrors,[]);
        assert.deepEqual(evidence.httpErrors,[]);
        writeFileSync(join(out,'report.json'),JSON.stringify(evidence,null,2));
        console.log(JSON.stringify(evidence,null,2));
        await browser.close();
        const stopped=once(child,'exit');child.send('stop');await stopped;
        process.exit(0);
    } else if (process.env.HAPPY_WORKSPACE_RESTART_FIXTURE === '1') {
        const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:'pipe'}).trim();
        evidence.servicePIDs=[ready.pid];
        const restart = async () => {
            const exit=once(child,'exit');child.kill('SIGKILL');await exit;
            const instance=await start(ready.root);evidence.servicePIDs.push(instance.pid);await open();
        };
        const cardFor = async name => {
            const card=page.getByTestId(`workspace-${ready.workspaces[name].id}`);
            if(!await card.count()){await button('加载更多').click();await card.waitFor();}
            return card;
        };
        await open();
        let card=await cardFor('dirty');
        await card.getByText('有未提交内容 · 含未跟踪文件',{exact:true}).waitFor();
        await restart();
        card=await cardFor('dirty');await card.getByText('有未提交内容 · 含未跟踪文件',{exact:true}).waitFor();
        assert.equal(readFileSync(join(ready.workspaces.dirty.cwd,'keep.txt'),'utf8'),'must retain\n');
        evidence.scenarios.push('dirty and untracked files survive an Owner process restart');
        card=await cardFor('unknown-reply');await card.getByText('已推送 · 待合并',{exact:true}).waitFor();
        await restart();
        card=await cardFor('unknown-reply');await card.getByText('已推送 · 待合并',{exact:true}).waitFor();
        await card.getByRole('button',{name:'详情与证据',exact:true}).click();
        await page.getByText('原请求 · send-unknown-reply',{exact:true}).waitFor();
        await page.screenshot({path:join(out,'pushed-after-restart.png'),fullPage:true});
        evidence.scenarios.push('real pushed remote branch survives restart with original request association');
        git(ready.workspaces.ready.cwd,'push','origin','HEAD:refs/heads/main');
        await restart();
        card=await cardFor('ready');await card.getByText('已合并 · 待收尾',{exact:true}).waitFor();
        assert.ok(existsSync(ready.workspaces.ready.cwd));
        await page.screenshot({path:join(out,'merged-after-restart.png'),fullPage:true});
        evidence.scenarios.push('remote main advances while stale local main remains; merged candidate is visible after restart');
        card=await cardFor('unconfirmed');evidence.missingCard=await card.innerText();assert.match(evidence.missingCard,/目录缺失 · Git 登记(?:存在|缺失)/);
        const old=page.getByText(ready.old,{exact:true});
        if(!await old.count())await button('加载更多').click();
        await old.waitFor();
        const oldCard=page.getByTestId(/^workspace-/).filter({has:old});
        await oldCard.getByText('待认领',{exact:true}).waitFor();
        await oldCard.getByRole('button',{name:'详情与证据',exact:true}).click();
        await page.getByText('由项目所有者核对归属。',{exact:true}).waitFor();
        assert.equal(await button('生成回收计划').count(),0);
        assert.ok(existsSync(ready.old));
        evidence.scenarios.push('missing checkout and historical unclaimed registration remain independently visible');
        await button('返回列表').click();
        card=await cardFor('live');
        await card.getByText(/目录存在 · Git 登记存在 · 归属映射缺失/).waitFor();
        await card.getByRole('button',{name:'详情与证据',exact:true}).click();
        await page.getByText('原请求 · send-live',{exact:true}).waitFor();
        assert.equal(await button('生成回收计划').count(),0);
        await button('返回列表').click();
        evidence.scenarios.push('separate creation evidence recovers the original request link when the queue mapping is absent');
        const ownerRead=async (authorization,requestID,projectID='fixture-project')=>page.request.post('http://127.0.0.1:20082/api/workspace-owner/v1/read',{headers:{
            origin:'http://127.0.0.1:20082',authorization},data:{action:'delivery-inventory',machineID:'fixture-machine',projectID,requestID}});
        assert.equal((await ownerRead('Bearer other-owner','send-live')).status(),403);
        assert.equal((await ownerRead('Bearer fixture-owner','send-live','other-project')).status(),403);
        const scoped=await(await ownerRead('Bearer fixture-owner','send-live')).json();
        assert.equal(scoped.data.items.length,1);
        assert.equal(scoped.data.items[0].id,ready.workspaces.live.id);
        assert.equal((await(await ownerRead('Bearer fixture-owner','send-unrelated')).json()).data.total,0);
        evidence.scenarios.push('authenticated request filter returns only its original workspace; different account denied');
        await find('delivery');
        await button('交付当前候选').click();
        await page.getByRole('textbox',{name:'业务验收证据'}).fill('Disposable browser acceptance');
        phase='unknown';
        await page.route('**/api/workspace-owner/v1/delivery',async route=>{
            const reply=await route.fetch();
            const body=await reply.json();
            evidence.lostDeliveryReply={status:reply.status(),phase:body.data?.phase,operationID:body.data?.operationID};
            await route.abort('failed');
        });
        await button('授权交付此候选').click();
        await page.getByRole('alert').waitFor();
        assert.equal(evidence.lostDeliveryReply.phase,'released');
        await page.unroute('**/api/workspace-owner/v1/delivery');phase='normal';
        await restart();
        await button('回收记录').click();
        card=page.getByTestId(`workspace-${ready.workspaces.delivery.id}`);await card.getByText('已回收',{exact:true}).waitFor();
        await card.getByRole('button',{name:'详情与证据',exact:true}).click();
        await page.getByText('目录释放已核验',{exact:true}).waitFor();
        assert.equal(existsSync(ready.workspaces.delivery.cwd),false);
        const releasedHead=git(ready.remote,'rev-parse','refs/heads/main');
        assert.equal(git(ready.remote,'show',releasedHead+':delivery.txt'),'delivery');
        assert.equal(evidence.payloads.filter(p=>p.action==='start-delivery').length,1);
        await page.screenshot({path:join(out,'released-after-restart.png'),fullPage:true});
        evidence.scenarios.push('one browser authorization -> real test and bare remote updates -> archive and release -> dropped HTTP acknowledgement -> released receipt after restart');
        assert.equal(new Set(evidence.servicePIDs).size,5);
        evidence.actualFixtureRemoved=1;evidence.realUserDirectoriesRemoved=0;
    } else if (finalize) {
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
        await page.getByText('检测到工作区仍被占用，具体会话或程序待核实。',{exact:false}).first().waitFor();
        assert.ok(existsSync(ready.workspaces.live.cwd));
        evidence.scenarios.push('dirty and occupied worktrees retained with reason');
        evidence.actualFixtureRemoved=1;evidence.realUserDirectoriesRemoved=0;
    } else {
    await page.goto('http://127.0.0.1:20082/');await page.screenshot({path:join(out,'entry-desktop.png'),fullPage:true});
    await button('项目工作区').click();await page.getByText('Fixture Project',{exact:true}).waitFor();await page.getByText('正在核对权限与工作区…',{exact:true}).waitFor({state:'hidden'});
    await page.screenshot({path:join(out,'list-desktop.png'),fullPage:true});
    await find('dirty');await page.getByText('存在未保存的改动或未跟踪文件。',{exact:false}).first().waitFor();
    await button('生成回收计划').click();await page.getByText('此计划仍被保护条件阻挡，确认不能跳过这些检查。',{exact:true}).waitFor();assert.ok(await button('确认并回收').isDisabled());await page.screenshot({path:join(out,'dirty-protected.png'),fullPage:true});
    await button('返回列表').click();await find('live');await page.getByText('检测到工作区仍被占用，具体会话或程序待核实。',{exact:false}).first().waitFor();assert.ok(existsSync(ready.workspaces.live.cwd));
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
