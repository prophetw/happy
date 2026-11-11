import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url), built = resolve(process.env.HAPPY_LIFECYCLE_TEST_BUILD ?? '.hosted-lifecycle-test');
const api = require(join(built, 'hostedDotLifecycle.cjs')), stateApi = require(join(built, 'hostedDotState.cjs'));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'happy-lifecycle-')), directory = join(root, 'runtime'), home = join(root, 'native');
  mkdirSync(directory); mkdirSync(home);
  t.after(() => { for (const child of children) { try { process.kill(child, 'SIGTERM'); } catch {} } rmSync(root, { recursive: true, force: true }); });
  const children = [], b = { directory, dotId: randomUUID(), sessionId: 'offline-session' };
  const config = stateApi.HostedDotConfig.parse({ version: 1, ...b, happyHome: root, serverUrl: 'https://offline.invalid',
    executable: '/never-run-native', args: [], model: 'offline', provider: 'fixture', instruction: 'offline test', codexHome: home });
  const entrypoint = join(root, 'fake-host.cjs');
  writeFileSync(entrypoint, `const fs=require('node:fs'), cp=require('node:child_process'),path=require('node:path');
const stateApi=require(${JSON.stringify(join(built, 'hostedDotState.cjs'))});
const publisher=require(${JSON.stringify(join(built, 'hostedDotAuthorityPublisher.cjs'))});
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8')), dir=config.directory;
const fd=fs.openSync(path.join(dir,'runtime.lock'),'a',0o600);
if(cp.spawnSync('flock',['--exclusive','--nonblock','3'],{stdio:['ignore','pipe','pipe',fd]}).status!==0)process.exit(7);
const file=path.join(dir,'state.json'), state=stateApi.loadHostedState(file,config);
const publish=publisher.createHostedAuthorityPublisher(file,state,stateApi.hostedProducerIdentity());
state.status='ready';publish();
setInterval(()=>{const file=path.join(dir,'control.json');if(!fs.existsSync(file))return;
const c=JSON.parse(fs.readFileSync(file,'utf8'));if(state.controls.includes(c.id))return;
state.controls.push(c.id);state.status='stopped';publish();fs.closeSync(fd);process.exit(0);},20);
`);
  const save = value => stateApi.savePrivate(join(directory, 'state.json'), value);
  const initialize = () => { stateApi.savePrivate(join(directory, 'config.json'), config); const state = stateApi.loadHostedState(join(directory, 'state.json'), config); save(state); return state; };
  return { root, directory, home, b, config, entrypoint, save, initialize,
    start: () => { const value=api.startHostedDot({ config, entrypoint }); if(value.owner)children.push(value.owner.pid);return value; },
    status: () => api.statusHostedDot(b), clear: (requestId=randomUUID(),epoch=1) => ({ ...b,requestId,epoch,codexHome:home }) };
}
async function waitFor(fn) { for (let i=0;i<200;i++) { if(fn())return;await new Promise(r=>setTimeout(r,10)); } throw Error('fixture timeout'); }
test('status is read-only on absent directories and never returns conversation text', t => {
  const f=fixture(t), absent={...f.b,directory:join(f.root,'absent')};
  assert.equal(api.statusHostedDot(absent).status,'not_started');assert.equal(existsSync(absent.directory),false);
  const state=f.initialize();state.inputs=[{seq:1,id:'user-1',epoch:0,text:'private message',status:'unknown'}];f.save(state);
  assert.equal(f.status().pendingInputs,1);assert.ok(!JSON.stringify(f.status()).includes('private message'));
});
test('actual exported producer start, repeated start, status, stop and restart', async t => {
  const f=fixture(t), first=f.start();assert.equal(first.running,true);
  await waitFor(()=>f.status().status==='ready');const second=f.start();assert.equal(second.owner.pid,first.owner.pid);
  const requestId=randomUUID();await api.stopHostedDot({...f.b,requestId});assert.equal(f.status().running,false);assert.ok(f.status().controls.includes(requestId));
  await api.stopHostedDot({...f.b,requestId});const third=f.start();assert.notEqual(third.owner.pid,first.owner.pid);
  await waitFor(()=>f.status().status==='ready');await api.stopHostedDot({...f.b,requestId:randomUUID()});
});
test('stop preserves a conflicting unacknowledged command and rejects request reuse', async t => {
  const f=fixture(t);f.initialize();const file=join(f.directory,'control.json'), value={id:'one',action:'delete'};writeFileSync(file,JSON.stringify(value));
  await assert.rejects(api.stopHostedDot({...f.b,requestId:'two'}),/control_pending/);
  await assert.rejects(api.stopHostedDot({...f.b,requestId:'one',action:'stop'}),/request_conflict/);
  assert.deepEqual(JSON.parse(readFileSync(file)),value);assert.throws(f.start,/deleted/);
});
test('an unacknowledged stop is never silently erased by start', t=>{
  const f=fixture(t);f.initialize();writeFileSync(join(f.directory,'control.json'),JSON.stringify({id:'lost',action:'stop'}));
  assert.throws(f.start,/control_pending/);
});
test('stop on an already-stopped journal durably acknowledges each request and permits restart', async t=>{
  const f=fixture(t), state=f.initialize();state.status='stopped';state.threadId='existing-thread';
  state.inputs=[{seq:1,id:'old-input',epoch:0,delivery:'queue',text:'preserve',status:'completed',turnId:'old-turn'}];f.save(state);
  await api.stopHostedDot({...f.b,requestId:'first'});
  await api.stopHostedDot({...f.b,requestId:'first'});
  await api.stopHostedDot({...f.b,requestId:'second'});
  const saved=JSON.parse(readFileSync(join(f.directory,'state.json'),'utf8'));
  assert.deepEqual(saved.controls,['first','second']);assert.deepEqual(saved.inputs,state.inputs);assert.equal(saved.threadId,'existing-thread');
  assert.equal(f.start().running,true);await waitFor(()=>f.status().status==='ready');
  await api.stopHostedDot({...f.b,requestId:'third'});
});
test('stop before first launch leaves no unconsumable control or synthetic journal',async t=>{
  const f=fixture(t);await api.stopHostedDot({...f.b,requestId:'never-started'});
  assert.equal(existsSync(join(f.directory,'control.json')),false);assert.equal(existsSync(join(f.directory,'state.json')),false);
  assert.equal(f.start().running,true);await waitFor(()=>f.status().status==='ready');await api.stopHostedDot({...f.b,requestId:'finish'});
});
test('producer exit before control consumption is acknowledged without changing input outcomes',async t=>{
  const f=fixture(t),state=f.initialize();state.inputs=[{seq:1,id:'uncertain',epoch:0,delivery:'queue',text:'do not replay',status:'unknown'}];f.save(state);
  writeFileSync(f.entrypoint,'setTimeout(()=>process.exit(0),100);');f.start();
  await api.stopHostedDot({...f.b,requestId:'exit-race'});
  assert.equal(f.status().running,false);assert.ok(f.status().controls.includes('exit-race'));
  const saved=JSON.parse(readFileSync(join(f.directory,'state.json'),'utf8'));assert.deepEqual(saved.inputs,state.inputs);assert.equal(saved.status,state.status);
});
test('acknowledging a stopped blocked journal never clears recovery guards',async t=>{
  const f=fixture(t),state=f.initialize();state.status='blocked';state.error='hosted_bootstrap_unconfirmed';f.save(state);
  await api.stopHostedDot({...f.b,requestId:'blocked-stop'});
  assert.equal(f.status().status,'blocked');assert.equal(f.status().error,state.error);assert.throws(f.start,/recovery_blocked/);
});
test('a stale same-id stop can be completed only after the runtime lock is free',async t=>{
  const {openSync,closeSync}=await import('node:fs'),{spawnSync}=await import('node:child_process');
  const f=fixture(t);f.initialize();const file=join(f.directory,'control.json');writeFileSync(file,JSON.stringify({id:'stale',action:'stop'}));
  const fd=openSync(join(f.directory,'runtime.lock'),'a');assert.equal(spawnSync('flock',['--exclusive','--nonblock','3'],{stdio:['ignore','pipe','pipe',fd]}).status,0);
  try {await assert.rejects(api.stopHostedDot({...f.b,requestId:'stale'}),/lock_busy/);assert.ok(!f.status().controls.includes('stale'));}
  finally {closeSync(fd);}
  await api.stopHostedDot({...f.b,requestId:'stale'});assert.ok(f.status().controls.includes('stale'));
});
test('delete on an already-stopped Dot remains a permanent launch fence',async t=>{
  const f=fixture(t);f.initialize();await api.stopHostedDot({...f.b,requestId:'delete-stopped',action:'delete'});
  assert.throws(f.start,/deleted/);assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'control.json'),'utf8')),{id:'delete-stopped',action:'delete'});
  await assert.rejects(api.stopHostedDot({...f.b,requestId:'delete-stopped',action:'stop'}),/request_conflict/);
});
for(const status of ['dispatching','accepted','unknown'])test(`recover never replays ${status}`,t=>{
  const f=fixture(t),state=f.initialize();state.status='blocked';state.error='hosted_start_or_recovery_failed';state.inputs=[{seq:1,id:'input',epoch:0,text:'offline',status}];f.save(state);
  const before=readFileSync(join(f.directory,'state.json'));assert.equal(api.recoverHostedDot(f.b).recovered,false);assert.deepEqual(readFileSync(join(f.directory,'state.json')),before);assert.throws(f.start,/recovery_blocked/);
});
test('recover owns backoff and only known safe errors', t=>{
  const f=fixture(t),state=f.initialize();state.status='blocked';state.error='hosted_start_or_recovery_failed';f.save(state);
  assert.equal(api.recoverHostedDot(f.b).recovered,true);assert.equal(f.status().status,'starting');
  f.save(state);assert.equal(api.recoverHostedDot(f.b).reason,'backoff');
  state.error='hosted_bootstrap_unconfirmed';f.save(state);assert.equal(api.recoverHostedDot(f.b).reason,'not_safe');
});
test('live producer cannot be recovered', async t=>{
  const f=fixture(t);f.start();await waitFor(()=>f.status().status==='ready');assert.equal(api.recoverHostedDot(f.b).reason,'running');await api.stopHostedDot({...f.b,requestId:randomUUID()});
});
test('prepare clear fences start and recover, stop is confirmed, clear preserves auth and memory',async t=>{
  const f=fixture(t);writeFileSync(join(f.home,'auth.json'),'credentials-stay');writeFileSync(join(f.home,'memory.json'),'memory-stays');
  for(const name of ['sessions','archived_sessions']){mkdirSync(join(f.home,name));writeFileSync(join(f.home,name,'old'),'private transcript');}
  f.start();await waitFor(()=>f.status().status==='ready');const request=f.clear();await api.prepareHostedDotClear(request);
  assert.equal(f.status().running,false);assert.equal(f.status().clearPending,true);assert.throws(f.start,/clear_pending/);assert.throws(()=>api.recoverHostedDot(f.b),/clear_pending/);
  await api.prepareHostedDotClear(request);api.clearHostedDot(request);api.clearHostedDot(request);
  assert.equal(f.status().epoch,1);assert.equal(f.status().clearPending,false);assert.equal(existsSync(join(f.directory,'state.json')),false);
  assert.equal(existsSync(join(f.home,'sessions')),false);assert.equal(existsSync(join(f.home,'archived_sessions')),false);
  assert.equal(readFileSync(join(f.home,'auth.json'),'utf8'),'credentials-stay');assert.equal(readFileSync(join(f.home,'memory.json'),'utf8'),'memory-stays');
});
test('clear retry survives epoch publication before old journal removal', async t=>{
  const f=fixture(t);f.initialize();const request=f.clear();await api.prepareHostedDotClear(request);
  writeFileSync(join(f.directory,'reset-epoch.json'),JSON.stringify({epoch:1}));
  assert.throws(f.status,/epoch_stale/);api.clearHostedDot(request);assert.equal(f.status().epoch,1);
});
test('clear cannot change binding, epoch, native home or request after preparation',async t=>{
  const f=fixture(t);f.initialize();assert.throws(()=>api.clearHostedDot(f.clear()),/not_prepared/);
  await assert.rejects(api.prepareHostedDotClear(f.clear('request',2)),/epoch_changed/);
  await assert.rejects(api.prepareHostedDotClear({...f.clear('request'),codexHome:f.root}),/home_changed/);
  const request=f.clear('request');await api.prepareHostedDotClear(request);
  await assert.rejects(api.prepareHostedDotClear({...request,requestId:'different'}),/request_conflict/);
  assert.throws(()=>api.clearHostedDot({...request,sessionId:'wrong'}),/request_conflict/);
  api.clearHostedDot(request);assert.throws(()=>api.clearHostedDot({...request,epoch:2}),/request_conflict/);
});
test('status rejects wrong binding, corrupt journal, unsafe epoch and reused PID identity',t=>{
  const f=fixture(t),state=f.initialize();assert.throws(()=>api.statusHostedDot({...f.b,sessionId:'other'}),/binding_changed/);
  writeFileSync(join(f.directory,'state.json'),'bad json');assert.throws(f.status);f.save(state);
  writeFileSync(join(f.directory,'reset-epoch.json'),JSON.stringify({epoch:1}));assert.throws(f.status,/epoch_stale/);rmSync(join(f.directory,'reset-epoch.json'));
  const owner=stateApi.hostedProducerIdentity();writeFileSync(join(f.directory,'owner.json'),JSON.stringify({...owner,start:owner.start+'0'}));assert.equal(f.status().running,false);
});
for(const file of ['state.json','config.json','owner.json','reset-epoch.json'])test(`reject symlink ${file} without reading its target`,t=>{
  const f=fixture(t);f.initialize();const target=join(f.root,'untouched');writeFileSync(target,'keep');rmSync(join(f.directory,file),{force:true});symlinkSync(target,join(f.directory,file));assert.throws(f.status,/symlink/);assert.equal(readFileSync(target,'utf8'),'keep');
});
test('clear rejects symlinked native transcript and preserves the pending fence',async t=>{
  const f=fixture(t);f.initialize();const request=f.clear();await api.prepareHostedDotClear(request);const target=join(f.root,'keep');mkdirSync(target);writeFileSync(join(target,'data'),'keep');symlinkSync(target,join(f.home,'sessions'));
  assert.throws(()=>api.clearHostedDot(request),/symlink/);assert.equal(existsSync(join(f.directory,'lifecycle-clear.json')),true);assert.equal(readFileSync(join(target,'data'),'utf8'),'keep');
});

test('unobserved runtime lock prevents recovery, clear and configuration rollback',async t=>{
  const {openSync,closeSync}=await import('node:fs'),{spawnSync}=await import('node:child_process');
  const f=fixture(t),state=f.initialize();state.status='blocked';state.error='hosted_start_or_recovery_failed';f.save(state);
  const fd=openSync(join(f.directory,'runtime.lock'),'a');assert.equal(spawnSync('flock',['--exclusive','--nonblock','3'],{stdio:['ignore','pipe','pipe',fd]}).status,0);
  try{assert.throws(()=>api.assertHostedDotStopped(f.b),/lock_busy/);assert.throws(()=>api.recoverHostedDot(f.b),/lock_busy/);await assert.rejects(api.prepareHostedDotClear(f.clear()),/lock_busy/);}finally{closeSync(fd);}
});
test('stop timeout remains unconfirmed and does not force-kill a producer',async t=>{
  const f=fixture(t);writeFileSync(f.entrypoint,'setInterval(()=>{},1000);');const started=f.start();
  await assert.rejects(api.stopHostedDot({...f.b,requestId:'timeout',timeoutMs:1}),/stop_unconfirmed/);assert.equal(f.status().running,true);assert.equal(f.status().owner.pid,started.owner.pid);
});
test('a live authority producer cannot be hidden by a stale owner file',t=>{
  const f=fixture(t),state=f.initialize(),producer=stateApi.hostedProducerIdentity();state.authority={version:1,producer,revision:1};f.save(state);
  writeFileSync(join(f.directory,'owner.json'),JSON.stringify({...producer,start:producer.start+'0'}));assert.throws(f.status,/owner_changed/);
});
test('a lifecycle clear fence immediately revokes the public input authority',t=>{
  const f=fixture(t),state=f.initialize();state.authority={version:1,producer:stateApi.hostedProducerIdentity(),revision:1};state.status='running';state.inputs=[{seq:1,id:'real-user',epoch:0,text:'offline',status:'accepted'}];f.save(state);
  const authority=require(join(built,'hostedDotAuthority.cjs'));assert.equal(authority.readHostedInputAuthority(f.b).status,'running');
  writeFileSync(join(f.directory,'lifecycle-clear.json'),JSON.stringify(f.clear()));assert.throws(()=>authority.readHostedInputAuthority(f.b),/clear_pending/);
});

