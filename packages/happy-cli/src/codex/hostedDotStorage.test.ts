import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostedDotConfig, HostedDotJournal, loadHostedState, addOutput, hostedProducerIdentity } from './hostedDotState';
import { readHostedStorage, saveHostedStorage, hostedStorageBackend } from './hostedDotStorage';
import { createHostedAuthorityPublisher } from './hostedDotAuthorityPublisher';
import { stopHostedDot, statusHostedDot, readHostedDotJournal, prepareHostedDotClear, clearHostedDot } from './hostedDotLifecycle';
import { createHostedAdmission, requestHostedAdmission } from './hostedDotAdmission';
import { readHostedInputAuthority } from './hostedDotAuthority';
const roots:string[]=[];
function fixture(sqlite=false){
 const root=mkdtempSync(join(tmpdir(),'happy-sqlite-deploy-'));roots.push(root);
 const directory=join(root,'runtime');mkdirSync(directory,{mode:0o700});
 const config=HostedDotConfig.parse({version:1,dotId:'00000000-0000-4000-8000-000000000001',sessionId:'synthetic-session',happyHome:root,serverUrl:'http://127.0.0.1:1',directory,executable:process.execPath,args:[],model:'synthetic',provider:'openai',instruction:'synthetic',codexHome:root});
 const file=join(directory,'state.json');writeFileSync(join(directory,'config.json'),JSON.stringify(config),{mode:0o600});
 if(sqlite){
  // Fresh synthetic pending marker; never convert a real or existing JSON journal.
  writeFileSync(join(directory,'storage.json'),JSON.stringify({version:1,kind:'happy-dot-state',directory,backend:'sqlite',pending:true}),{mode:0o600});
  writeFileSync(file,JSON.stringify({version:0,storage:'sqlite',error:'hosted_sqlite_reader_required'}),{mode:0o600});
 }
 const state=loadHostedState(file,config);state.status='ready';state.threadId='synthetic-thread';
 state.outputs.push({localId:'hosted:0:synthetic',sent:false,envelope:{id:'synthetic',ev:{t:'text',text:'合成🙂'}}});
 saveHostedStorage(file,state);return {root,directory,config,file,state};
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true});});
describe.each([false,true])('deployed storage backend sqlite=%s',sqlite=>{
 it('reads/writes the existing shape and keeps the main dedup boolean contract',()=>{
  const f=fixture(sqlite);expect(hostedStorageBackend(f.directory)).toBe(sqlite?'sqlite':'json');expect(loadHostedState(f.file,f.config).threadId).toBe('synthetic-thread');
  const envelope={id:'more',time:1,role:'agent',ev:{t:'text',text:'文🙂'}} as Parameters<typeof addOutput>[1];
  expect(addOutput(f.state,envelope)).toBe(true);expect(addOutput(f.state,envelope)).toBe(false);
  saveHostedStorage(f.file,f.state);expect(readHostedStorage(f.file)?.outputs).toHaveLength(2);
 });
 it('retains outputs when an offline lifecycle stop appends its receipt',async()=>{
  const f=fixture(sqlite),before=readHostedStorage(f.file)!.outputs;
  await stopHostedDot({directory:f.directory,dotId:f.config.dotId,sessionId:f.config.sessionId,requestId:'synthetic-stop'});
  const after=readHostedStorage(f.file)!;expect(after.outputs).toEqual(before);expect(after.controls).toContain('synthetic-stop');expect(readHostedDotJournal({directory:f.directory,dotId:f.config.dotId,sessionId:f.config.sessionId}).epoch).toBe(0);
 });
 it('publishes authority without changing thread/input/output identity',()=>{
  const f=fixture(sqlite);createHostedAuthorityPublisher(f.file,f.state,{pid:process.pid,start:'1',boot:'00000000-0000-4000-8000-000000000001'})();
  const value=readHostedStorage(f.file)!;expect(value.threadId).toBe('synthetic-thread');expect(value.outputs).toEqual(f.state.outputs);expect(value.authority.revision).toBeGreaterThan(0);
 });
});
it('reads expanded journals through producer, lifecycle and input authority without removing the upper bound', () => {
 const f=fixture(true),legacyLimit=32*1024*1024;
 createHostedAuthorityPublisher(f.file,f.state,hostedProducerIdentity())();
 f.state.outputs=Array.from({length:50000},(_,n)=>({localId:`hosted:0:history-${n}`,sent:n<49783,
  envelope:{id:`history-${n}`,ev:{t:'text',text:'history'}}}));
 const initialBytes=Buffer.byteLength(JSON.stringify(f.state));expect(initialBytes).toBeLessThan(legacyLimit);
 f.state.outputs.push({localId:'hosted:0:after-legacy-cap',sent:false,
  envelope:{id:'after-legacy-cap',ev:{t:'text',text:'x'.repeat(legacyLimit-initialBytes+2048)}}});
 saveHostedStorage(f.file,f.state);expect(Buffer.byteLength(JSON.stringify(f.state))).toBeGreaterThan(legacyLimit);
 const producer=loadHostedState(f.file,f.config);expect(producer.outputs).toHaveLength(50001);
 expect(HostedDotJournal.parse(producer).outputs).toHaveLength(50001);
 expect(statusHostedDot({directory:f.directory,dotId:f.config.dotId,sessionId:f.config.sessionId}).threadId).toBe('synthetic-thread');
 expect(readHostedInputAuthority(f.config).inputs).toEqual([]);
 f.state.outputs=Array.from({length:100001},(_,n)=>({localId:`hosted:0:overflow-${n}`,sent:false,envelope:{id:n}}));
 expect(()=>HostedDotJournal.parse(f.state)).toThrow();
 expect(()=>saveHostedStorage(f.file,f.state)).toThrow('hosted_storage_records_invalid');
 expect(readHostedStorage(f.file)!.outputs).toHaveLength(50001);
},60000);

it('SQLite sentinel rejects legacy JSON schema and conversion APIs are absent',async()=>{
 const f=fixture(true);expect(JSON.parse(readFileSync(f.file,'utf8')).error).toBe('hosted_sqlite_reader_required');
 const storage=await import('./hostedDotStorage');expect('migrateHostedStorage' in storage).toBe(false);expect('rollbackHostedStorage' in storage).toBe(false);expect('recoverHostedStorage' in storage).toBe(false);
});

it('rejects direct or spread projection writeback without losing SQLite outputs',()=>{
 const f=fixture(true),before=readHostedStorage(f.file);const projection=readHostedStorage(f.file,['inputs','controls'])!;
 expect(()=>saveHostedStorage(f.file,projection)).toThrow('hosted_storage_projection_read_only');
 expect(()=>saveHostedStorage(f.file,{...projection})).toThrow('hosted_storage_projection_read_only');
 expect(readHostedStorage(f.file)).toEqual(before);
});

it.each([false,true])('pause/resume then explicit clear allows a fresh epoch, sqlite=%s',async sqlite=>{
 const f=fixture(sqlite),binding={directory:f.directory,dotId:f.config.dotId,sessionId:f.config.sessionId,epoch:0};
 const producer=createHostedAdmission(binding,hostedProducerIdentity());producer.permits(false);
 requestHostedAdmission({...binding,operation:{id:'fixture-pause',action:'pause',expectedRevision:0,leaseUntil:Date.now()+30000}});expect(producer.permits(false)).toBe(false);
 requestHostedAdmission({...binding,operation:{id:'fixture-resume',action:'resume',expectedRevision:1,leaseUntil:0}});expect(producer.permits(false)).toBe(true);producer.stopped();
 const clear={...binding,epoch:1,requestId:'fixture-clear',codexHome:f.root};await prepareHostedDotClear(clear);clearHostedDot(clear);
 const next={...f.config,sessionId:'synthetic-next-session'};writeFileSync(join(f.directory,'config.json'),JSON.stringify(next),{mode:0o600});
 expect(createHostedAdmission({...binding,sessionId:next.sessionId,epoch:1},hostedProducerIdentity()).permits(false)).toBe(true);
});
