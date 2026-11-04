// Isolated consent UI fixture: no account login, server credentials or real grant.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(app, '../..');
const artifacts = path.join(repo, '.e2e-artifacts', `automation-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(artifacts, { recursive: true });
const mocks = {
    'expo-clipboard': `export const setStringAsync=async()=>{};`,
    'react-native-unistyles': `import {lightTheme,darkTheme} from ${JSON.stringify(path.join(app,'sources/theme.ts'))}; const theme=new URLSearchParams(location.search).has('dark')?darkTheme:lightTheme; export const useUnistyles=()=>({theme}); export const StyleSheet={hairlineWidth:1,create:f=>f(theme)};`,
    'expo-router': `export const Stack={Screen:()=>null}; export const useLocalSearchParams=()=>({connection:'fixture_connection'}); export const useRouter=()=>({push:()=>{}});`,
    'expo-camera': `export const CameraView={isModernBarcodeScannerAvailable:false};`,
    '@/auth/AuthContext': `export const useAuth=()=>({credentials:new URLSearchParams(location.search).has('unauth')?null:{token:'fixture-only-not-a-credential',get secret(){throw Error('Account secret must not be accessed')}}});`,
    '@/sync/serverConfig': `export const getServerUrl=()=>location.origin;`,
    '@/auth/automationApproval': `const p=new URLSearchParams(location.search),now=Date.now(); let state=p.get('state')||'pending'; const consent=()=>({id:'fixture_connection',userID:'fixture_user',clientID:'fixture_assistant',clientName:'测试助手 · REST',clientFingerprint:'a'.repeat(64),workerID:'fixture_worker',workerName:'4090Wsl2 · 受信 Worker',workerFingerprint:'b'.repeat(64),machineID:'fixture_machine',projectID:'automation-test',projectDirectory:'/home/dev/code/happy-automation-test',methods:['machines.list','sessions.list','tasks.create','requests.get','sessions.send','sessions.status','sessions.logs','sessions.result','sessions.cancel'],sessionIDs:[],expiresAt:now+3600000,pendingUntil:p.has('deadline')?now-1000:now+300000,state,digest:'fixture_digest',challenge:'fixture_challenge',disclosure:'控制组件可见批准范围内的指令与结果；Happy 账号密钥留在用户机器。撤权不自动停止已运行任务。'}); window.__fixtureCalls={approve:0,revoke:0}; export const automationApprovalApi=()=>({compatibility:async()=>({protocol:1,approval:1,worker:1}),consent:async()=>consent(),list:async()=>[consent()],approve:async c=>{if(c.id!=='fixture_connection')throw Error('WRONG_SCOPE');window.__fixtureCalls.approve++;state='approved'},revoke:async()=>{window.__fixtureCalls.revoke++;state='revoked'}}); export const automationConnectionQR=id=>'happy:///automation?connection='+id; export const parseAutomationQR=()=> 'fixture_connection';`,
    '@/components/Item': `import React from 'react';import {Pressable,Text} from 'react-native';export const Item=({title,subtitle,onPress,disabled})=><Pressable disabled={disabled} onPress={onPress} style={{padding:20}}><Text>{title}</Text><Text>{subtitle}</Text></Pressable>;`,
    '@/components/qr': `import React from 'react';import {Text} from 'react-native';export const QRCode=()=> <Text accessibilityLabel="fixture QR placeholder">仅为隔离测试二维码占位</Text>;`,
    '@/hooks/useScanQrCode': `export const useScanQrCode=()=>({scanQrCode:async()=>{}});`,
    '@/hooks/useCheckCameraPermissions': `export const useCheckScannerPermissions=()=>async()=>false;`,
    '@expo/vector-icons': `import React from 'react';import {Text} from 'react-native';export const Ionicons=()=> <Text>✓</Text>;`,
};
let browser, server;
const checks=[], errors=[], unexpectedRequests=[];
try {
    const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Screen from './sources/app/(app)/settings/automation';createRoot(document.getElementById('root')).render(<Screen/>);`,resolveDir:app,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{__DEV__:'false','process.env.NODE_ENV':'"production"'},alias:{'react-native':'react-native-web','@':path.join(app,'sources')},plugins:[{name:'fixture-boundaries',setup(b){b.onResolve({filter:/.*/},args=>args.path in mocks?{path:args.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'tsx',resolveDir:app}));}}]});
    server=createServer((request,response)=>{if(request.url==='/bundle.js'){response.setHeader('Content-Type','text/javascript');response.end(bundle.outputFiles[0].contents);}else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%;font-family:system-ui}</style><div id="root"></div><script src="/bundle.js"></script></html>');}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true});
    for(const profile of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844},{name:'mobile-dark',width:390,height:844,dark:true}]){
        const context=await browser.newContext({viewport:{width:profile.width,height:profile.height},locale:'zh-CN',serviceWorkers:'block'});
        await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){unexpectedRequests.push('outside-loopback');return route.abort();}return route.continue();});
        const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
        for(const state of ['pending','expired','revoked','approved']){
            await page.goto(`${origin}/?state=${state}${profile.dark?'&dark':''}`);
            await page.getByRole('heading',{name:'由你决定助手能做什么'}).waitFor();
            await page.getByText('测试助手 · REST',{exact:true}).first().waitFor();
            assert.equal(await page.getByText('a'.repeat(64),{exact:true}).count(),0);
            assert.equal(await page.getByRole('button',{name:'确认批准以上权限',exact:true}).count(),state==='pending'?1:0);
            assert.equal(await page.getByLabel('fixture QR placeholder').count(),0);
            assert((await page.locator('body').innerText()).includes('/home/dev/code/happy-automation-test'));
            assert((await page.locator('body').innerText()).includes('不含任何既有会话'));
            await page.getByRole('button',{name:'查看身份与安全详情',exact:true}).click();
            await page.getByText('a'.repeat(64),{exact:true}).waitFor();
            const overflow=await page.evaluate(()=>[...document.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth+1&&e.getBoundingClientRect().width>0).length);
            assert.equal(overflow,0,`${profile.name} ${state} horizontal overflow`);
            await page.getByRole('button',{name:'收起身份与安全详情',exact:true}).click();
            await page.screenshot({path:path.join(artifacts,`${profile.name}-${state}.png`),fullPage:true});
            if(state==='pending'){
                assert.equal(await page.evaluate(()=>window.__fixtureCalls.approve),0);
                await page.getByRole('button',{name:'显示连接二维码',exact:true}).click();await page.getByLabel('fixture QR placeholder').waitFor();
                await page.getByRole('button',{name:'确认批准以上权限',exact:true}).click();await page.getByRole('button',{name:'撤销连接',exact:true}).waitFor();
                assert.equal(await page.evaluate(()=>window.__fixtureCalls.approve),1);
                await page.getByRole('button',{name:'撤销连接',exact:true}).click();await page.getByText('这项连接的访问权限已撤销。',{exact:false}).waitFor();
                assert.equal(await page.evaluate(()=>window.__fixtureCalls.revoke),1);
            }
            checks.push(`${profile.name}:${state}:scope+status+details+overflow+no-implicit-approval`);
        }
        await page.goto(`${origin}/?deadline`);await page.getByText('这项连接已过期',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'确认批准以上权限',exact:true}).count(),0);checks.push(`${profile.name}:approval-deadline`);
        await context.close();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(unexpectedRequests,[]);
} finally {
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
    await writeFile(path.join(artifacts,'report.json'),JSON.stringify({fixtureOnly:true,realLogin:false,realApproval:false,checks,errors,unexpectedRequests,browserClosed:true},null,2)+'\n');
    console.log(JSON.stringify({artifacts,checks:checks.length,errors,unexpectedRequests}));
}
