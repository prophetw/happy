// Run: pnpm --dir packages/happy-app exec node --import tsx scripts/service-access.e2e.mjs
// Real loopback REST + trusted-worker fixture; synthetic owner auth/relay only. No Happy home or live URLs.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRig } from '../../happy-agent/examples/rest-fixture.ts';
const app=fileURLToPath(new URL('../',import.meta.url)), repo=path.resolve(app,'../..');
const artifacts=path.join(repo,'.e2e-artifacts',`service-access-${new Date().toISOString().replace(/[:.]/g,'-')}`);await mkdir(artifacts,{recursive:true});
const mocks={
 'react-native-unistyles':`import {lightTheme} from ${JSON.stringify(path.join(app,'sources/theme.ts'))};export const useUnistyles=()=>({theme:lightTheme});export const StyleSheet={hairlineWidth:1,create:f=>f(lightTheme)};`,
 'expo-router':`import React from 'react';export const Stack={Screen:()=>null};export const useLocalSearchParams=()=>({connection:new URLSearchParams(location.search).get('connection')||undefined});export const useRouter=()=>({push:url=>{location.href=url}});export const useFocusEffect=effect=>React.useEffect(effect,[effect]);`,
 'expo-camera':`export const CameraView={isModernBarcodeScannerAvailable:false};`,
 'expo-clipboard':`export const setStringAsync=async()=>{};`,
 '@/auth/AuthContext':`export const useAuth=()=>({credentials:{token:'fixture-owner-A',get secret(){throw Error('Account secret must not be read')}}});`,
 '@/sync/serverConfig':`export const getServerUrl=()=>location.origin+'/home-relay';`,
 '@/components/Item':`import React from 'react';import {Pressable,Text} from 'react-native';export const Item=({title,subtitle,onPress,disabled})=><Pressable disabled={disabled} onPress={onPress} style={{padding:20}}><Text>{title}</Text><Text>{subtitle}</Text></Pressable>;`,
 '@/components/qr':`import React from 'react';import {Text} from 'react-native';export const QRCode=()=> <Text>隔离fixture二维码占位</Text>;`,
 '@/hooks/useScanQrCode':`export const useScanQrCode=()=>({scanQrCode:async()=>{}});`,
 '@/hooks/useCheckCameraPermissions':`export const useCheckScannerPermissions=()=>async()=>false;`,
 '@expo/vector-icons':`import React from 'react';import {Text} from 'react-native';export const Ionicons=()=> <Text>✓</Text>;`,
};
let browser,server,rig,bundle;const checks=[],errors=[],networkFailures=[];
try{
 bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Screen from './sources/app/(app)/settings/automation';import {ServiceConnectionForm} from './sources/components/automation/ServiceAccess';import {automationApprovalApi} from './sources/auth/automationApproval';const api=automationApprovalApi(location.origin,()=> 'Bearer fixture-owner-A');createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('form')?<ServiceConnectionForm api={api} onCreated={id=>location.href='/?connection='+id}/>:<Screen/>);`,resolveDir:app,loader:'tsx'},bundle:true,write:false,platform:'browser',jsx:'automatic',define:{__DEV__:'false','process.env.NODE_ENV':'"production"'},alias:{'react-native':'react-native-web','@':path.join(app,'sources')},plugins:[{name:'isolated-UI',setup(b){b.onResolve({filter:/.*/},a=>a.path in mocks?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'tsx',resolveDir:app}));}}]})).outputFiles[0].contents;
 server=createServer((req,res)=>{
  if(req.url.startsWith('/happy-control/v1/')&&rig){const target=httpRequest(rig.address+req.url,{method:req.method,headers:req.headers},out=>{res.writeHead(out.statusCode,out.headers);out.pipe(res);});target.on('error',()=>{res.writeHead(502);res.end();});req.pipe(target);return;}
  if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle);return;}
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%;font-family:system-ui}</style><div id="root"></div><script src="/bundle.js"></script></html>');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 rig=await fixtureRig({origin,workerIntervalMs:100,multipleProjects:true,serviceTokens:{clients:[{id:'fixture_backend',userID:'userA',name:'Fixture 合作方后端',generation:'fixture_v1'}]}});await rig.startWorker();
 browser=await chromium.launch({headless:true});
 for(const profile of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  const context=await browser.newContext({viewport:{width:profile.width,height:profile.height},locale:'zh-CN',serviceWorkers:'block'});const page=await context.newPage();
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){networkFailures.push('outside-loopback');return route.abort();}return route.continue();});
  page.on('pageerror',()=>errors.push('page-error'));page.on('console',m=>{if(m.type()==='error')errors.push('console-error');});page.on('requestfailed',()=>networkFailures.push('request-failed'));
  await page.goto(origin+'/?form');await page.getByRole('heading',{name:'为后端创建服务授权',exact:true}).waitFor();
  await page.getByRole('checkbox',{name:'Fixture 合作方后端',exact:true}).waitFor();
  const submit=page.getByRole('button',{name:'创建申请并审查权限',exact:true}),days=page.getByLabel('服务授权有效天数',{exact:true});
  await days.fill('31');assert(await submit.isDisabled());await days.fill('30');
  for(const [label,method] of [['创建任务','tasks.create'],['追加指令','sessions.send'],['取消任务','sessions.cancel']]){const checkbox=page.getByRole('checkbox',{name:`${label} · ${method}`,exact:true});assert.equal(await checkbox.getAttribute('aria-checked'),'false');await checkbox.click();}
  const projectA=page.getByRole('checkbox',{name:`projectA · ${rig.project}`,exact:true}),projectB=page.getByRole('checkbox',{name:`projectB · ${rig.projectB}`,exact:true});
  assert.equal(await projectA.getAttribute('aria-checked'),'true');assert.equal(await projectB.getAttribute('aria-checked'),'false');
  await projectA.click();assert(await submit.isDisabled());await projectA.click();await projectB.click();
  assert.equal(await page.getByRole('checkbox',{name:`projectC · ${rig.projectC}`,exact:true}).getAttribute('aria-checked'),'false');
  await page.screenshot({path:path.join(artifacts,profile.name+'-scope.png'),fullPage:true});await submit.click();
  await page.getByRole('button',{name:'确认批准以上权限',exact:true}).waitFor();const id=new URL(page.url()).searchParams.get('connection');assert(id);
  assert.equal(rig.gateway.grants.get(id).state,'pending');assert.equal(await page.getByLabel('一次性服务访问令牌').count(),0);
  assert.deepEqual(rig.gateway.grants.get(id).projectIDs,['projectA','projectB']);assert.equal(rig.gateway.grants.get(id).scopeVersion,2);
  await page.getByText(rig.project,{exact:true}).waitFor();await page.getByText(rig.projectB,{exact:true}).waitFor();
  await page.getByRole('button',{name:'确认批准以上权限',exact:true}).click();const issue=page.getByRole('button',{name:'生成服务访问令牌（仅交付一次）',exact:true});await issue.waitFor();
  assert.equal(rig.gateway.store.list('service-token:').length,profile.name==='desktop'?0:1);await issue.click();
  const input=page.getByLabel('一次性服务访问令牌',{exact:true});await input.waitFor();assert.equal(await input.getAttribute('type'),'password');const token=await input.inputValue();
  assert.equal(await page.evaluate(value=>JSON.stringify(localStorage).includes(value),token),false);
  assert.equal(await page.evaluate(value=>JSON.stringify(sessionStorage).includes(value),token),false);
  await page.screenshot({path:path.join(artifacts,profile.name+'-delivery.png'),fullPage:true,mask:[input]});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  async function backend(route,method='GET',body){const r=await fetch(rig.address+'/happy-control/v1'+route,{method,headers:{authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
  rig.setProcess('running');const createdA=await backend('/tasks','POST',{requestID:profile.name+'_create_a',machineID:'machineA',projectID:'projectA'});assert.equal(createdA.body.data.state,'confirmed');
  const created=await backend('/tasks','POST',{requestID:profile.name+'_create_b',machineID:'machineA',projectID:'projectB'});assert.equal(created.body.data.state,'confirmed');const sid=created.body.data.sessionID;
  const actual=(await rig.transport.sessions()).sessions;assert.equal(actual.find(s=>s.id===createdA.body.data.sessionID).metadata.path,rig.project);assert.equal(actual.find(s=>s.id===sid).metadata.path,rig.projectB);
  assert.equal((await backend('/tasks','POST',{requestID:profile.name+'_denied',machineID:'machineA',projectID:'projectC'})).body.error.code,'SCOPE_DENIED');
  const sent=await backend(`/sessions/${sid}/messages`,'POST',{requestID:profile.name+'_send',text:'isolated fixture instruction'});assert.equal(sent.body.data.state,'submitted');
  rig.complete(sid,profile.name+'_turn');const result=await backend(`/sessions/${sid}/result?turnID=${profile.name}_turn`);assert.equal(result.body.data.outcome,'completed');
  const cancelled=await backend(`/sessions/${sid}/cancel`,'POST',{requestID:profile.name+'_cancel'});assert.equal(cancelled.body.data.process,'unknown');rig.setProcess('stopped');assert.equal((await backend('/requests/'+profile.name+'_cancel')).body.data.process,'stopped');
  const stored=(await Promise.all((await readdir(path.join(rig.dir,'gateway/state'))).map(p=>readFile(path.join(rig.dir,'gateway/state',p),'utf8')))).join('');assert(!stored.includes(token));assert(!JSON.stringify(rig.audit).includes(token));
  await page.getByRole('button',{name:'撤销连接',exact:true}).click();await input.waitFor({state:'detached'});assert.equal((await backend('/machines')).body.error.code,'GRANT_REVOKED');
  await page.reload();await page.getByText('已撤销',{exact:true}).first().waitFor();assert.equal(await page.getByLabel('一次性服务访问令牌').count(),0);
  checks.push(profile.name+':multi-project-checkbox+full-directory-review+one-token-two-projects+unselected-project-denied+30day-scope+explicit-approval+one-time-secret+backend-REST+encrypted-fixture+cancel-unknown/stopped+revoke+no-plaintext-persistence');await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(networkFailures,[]);
}finally{
 if(browser)await browser.close();if(rig)await rig.close();if(server)await new Promise(resolve=>server.close(resolve));
 await writeFile(path.join(artifacts,'report.json'),JSON.stringify({fixtureOnly:true,realAccountOrGrant:false,publicListener:false,checks,errors,networkFailures,browserClosed:true,loopbackServersClosed:true},null,2)+'\n');console.log(JSON.stringify({artifacts,scenarios:checks.length,errors,networkFailures,browserClosed:true,loopbackServersClosed:true}));
}
