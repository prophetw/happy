import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { HostedDotConfig, HostedDotJournal, loadHostedState, addOutput, hostedProducerIdentity, reclaimDeliveredOutputPrefix } from './hostedDotState';
import { readHostedStorage, saveHostedStorage, hostedStorageBackend, prepareHostedStorage } from './hostedDotStorage';
import { createHostedAuthorityPublisher } from './hostedDotAuthorityPublisher';
import { stopHostedDot, statusHostedDot, readHostedDotJournal, prepareHostedDotClear, clearHostedDot, migrateHostedDotJournal } from './hostedDotLifecycle';
import { createHostedAdmission, requestHostedAdmission } from './hostedDotAdmission';
import { readHostedInputAuthority } from './hostedDotAuthority';
const roots:string[]=[];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
function fixture(preselected=false){
 const root=mkdtempSync(join(tmpdir(),'happy-sqlite-deploy-'));roots.push(root);
 const directory=join(root,'runtime');mkdirSync(directory,{mode:0o700});
 const config=HostedDotConfig.parse({version:1,dotId:'00000000-0000-4000-8000-000000000001',sessionId:'synthetic-session',happyHome:root,serverUrl:'http://127.0.0.1:1',directory,executable:process.execPath,args:[],model:'synthetic',provider:'openai',instruction:'synthetic',codexHome:root});
 const file=join(directory,'state.json');
 if(preselected){
  // Fresh synthetic pending marker; never convert a real or existing JSON journal.
  writeFileSync(join(directory,'storage.json'),JSON.stringify({version:1,kind:'happy-dot-state',directory,backend:'sqlite',pending:true}),{mode:0o600});
  writeFileSync(file,JSON.stringify({version:0,storage:'sqlite',error:'hosted_sqlite_reader_required'}),{mode:0o600});
 }
 prepareHostedStorage(directory);
 writeFileSync(join(directory,'config.json'),JSON.stringify(config),{mode:0o600});
 const state=loadHostedState(file,config);state.status='ready';state.threadId='synthetic-thread';
 state.outputs.push({localId:'hosted:0:synthetic',sent:false,envelope:{id:'synthetic',ev:{t:'text',text:'合成🙂'}}});
 saveHostedStorage(file,state);return {root,directory,config,file,state};
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true});});
describe.each([false,true])('SQLite journal with preselected storage=%s',sqlite=>{
 it('reads/writes the existing shape and keeps the main dedup boolean contract',()=>{
  const f=fixture(sqlite);expect(hostedStorageBackend(f.directory)).toBe('sqlite');expect(loadHostedState(f.file,f.config).threadId).toBe('synthetic-thread');
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

it('preserves v2 receipts through producer, lifecycle, input authority and an offline stop', async () => {
 const f=fixture(true);createHostedAuthorityPublisher(f.file,f.state,{pid:99999999,start:'1',boot:'00000000-0000-4000-8000-000000000001'})();f.state.outputs[0].sent=true;
 expect(reclaimDeliveredOutputPrefix(f.state)).toBe(1);saveHostedStorage(f.file,f.state);
 const producer=loadHostedState(f.file,f.config);expect(producer.outputs).toHaveLength(0);expect(producer.outputReceipts).toEqual(['hosted:0:synthetic']);
 expect(statusHostedDot({directory:f.directory,dotId:f.config.dotId,sessionId:f.config.sessionId}).threadId).toBe('synthetic-thread');
 expect(readHostedInputAuthority(f.config).inputs).toEqual([]);
 await stopHostedDot({directory:f.directory,dotId:f.config.dotId,sessionId:f.config.sessionId,requestId:'v2-stop'});
 const stopped=readHostedStorage(f.file)!;expect(stopped.outputReceipts).toEqual(['hosted:0:synthetic']);expect(stopped.controls).toContain('v2-stop');
});
it('defaults to v2 and imports a nonempty JSON journal exactly once, including ACKs and cursors', () => {
 const f=fixture();
 const sql=new DatabaseSync(join(f.directory,'state.sqlite'),{readOnly:true});
 try {expect(sql.prepare('SELECT version FROM metadata').get()?.version).toBe(2);}
 finally {sql.close();}
 rmSync(join(f.directory,'storage.json'));
 rmSync(join(f.directory,'state.sqlite'));
 const state={...f.state,afterSeq:17,controls:['stop-old'],outputs:[
  {...f.state.outputs[0],sent:true},
  {localId:'hosted:0:unsent',sent:false,envelope:{id:'unsent',ev:{t:'text',text:'queued output'}}},
 ],inputs:[{id:'user',seq:17,status:'queued',text:'pending input'}]};
 const original=JSON.stringify(state);
 writeFileSync(f.file,original);
 expect(()=>loadHostedState(f.file,f.config)).toThrow('hosted_storage_migration_required');
 expect(()=>saveHostedStorage(f.file,state)).toThrow('hosted_storage_migration_required');
 const result=migrateHostedDotJournal({directory:f.directory,dotId:f.config.dotId,sessionId:f.config.sessionId});
 expect(result.migrated).toBe(true);
 expect(result.source).toEqual(result.target);
 expect(result.target).toMatchObject({afterSeq:17,inputs:1,outputs:2,pendingOutputs:1});
 expect(readHostedStorage(f.file)).toEqual(state);
 expect(readFileSync(join(f.directory,'state.json.pre-sqlite'),'utf8')).toBe(original);
 expect(migrateHostedDotJournal({directory:f.directory,dotId:f.config.dotId,sessionId:f.config.sessionId}).migrated).toBe(false);
 // Simulate interruption after staging the complete SQLite journal and publishing the sentinel.
 rmSync(join(f.directory,'storage.json'));
 renameSync(join(f.directory,'state.sqlite'),join(f.directory,'state.sqlite.migrating'));
 expect(()=>loadHostedState(f.file,f.config)).toThrow('hosted_storage_migration_incomplete');
 expect(migrateHostedDotJournal({directory:f.directory,dotId:f.config.dotId,sessionId:f.config.sessionId}).source).toEqual(result.target);
 expect(readHostedStorage(f.file)).toEqual(state);
});
it('does not infer a fresh journal when the configured Dot loses its storage files', () => {
 const f=fixture();
 for(const name of ['storage.json','state.json','state.sqlite'])rmSync(join(f.directory,name));
 expect(()=>loadHostedState(f.file,f.config)).toThrow('hosted_storage_missing');
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
