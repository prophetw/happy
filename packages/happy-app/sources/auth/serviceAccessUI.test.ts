import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const runtime=vi.hoisted(()=>({appListener:undefined as undefined|((state:string)=>void),blur:undefined as undefined|(()=>void),copy:vi.fn(),state:'active'}));
vi.mock('react-native',()=>({View:'View',Text:'Text',TextInput:'TextInput',Pressable:'Pressable',AppState:{get currentState(){return runtime.state;},addEventListener:(_:string,callback:(state:string)=>void)=>{runtime.appListener=callback;return{remove(){runtime.appListener=undefined;}};}}}));
vi.mock('react-native-unistyles',()=>({StyleSheet:{create:(f:any)=>f({colors:{text:'#111',textSecondary:'#666',textDestructive:'#a00',divider:'#ddd',surfaceHigh:'#eee'}})}}));
vi.mock('expo-clipboard',()=>({setStringAsync:runtime.copy}));
vi.mock('expo-router',()=>({useFocusEffect:(effect:React.EffectCallback)=>React.useEffect(()=>{const cleanup=effect();runtime.blur=typeof cleanup==='function'?cleanup:undefined;return cleanup;},[effect])}));
vi.mock('@/components/DirectoryPicker',()=>({DirectoryPicker:'DirectoryPicker'}));
vi.mock('@/text',()=>({t:(key:string,params?:{id?:string})=>params?.id?`${key}:${params.id}`:key}));
import { ServiceConnectionForm, ServiceTokenDelivery } from '@/components/automation/ServiceAccess';
import type { AutomationConsent, ServiceConnectionOptions, automationApprovalApi } from '@/auth/automationApproval';
const fixtureSecret='fixture-secret-with-no-real-access';
const consent={id:'service_connection',credentialMode:'service-token-v1',state:'approved',serviceToken:{issued:false}} as AutomationConsent;
let renderer:any;
const button=(label:string)=>renderer.root.findAllByType('Pressable').find((n:any)=>n.props.accessibilityLabel===label);
const hasSecret=()=>JSON.stringify(renderer.toJSON()).includes(fixtureSecret);
function api(){return{serviceOptions:vi.fn(async()=>({protocol:1,maxGrantMs:30*24*3600000,clients:[{id:'service',name:'Fixture backend'}],workers:[{id:'worker',name:'Fixture worker',machineID:'machine',methods:['machines.list','tasks.create','sessions.send','sessions.cancel'],projects:[{id:'project',directory:'/fixture/project',sessionIDs:[]}]}]})),createService:vi.fn(async()=>({id:'created_connection'})),issueServiceToken:vi.fn(async()=>({connectionID:consent.id,token:fixtureSecret,expiresAt:Date.now()+60000}))} as unknown as ReturnType<typeof automationApprovalApi>;}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);runtime.state='active';runtime.copy.mockResolvedValue(undefined);runtime.copy.mockClear();});
afterEach(async()=>{if(renderer){await act(async()=>renderer.unmount());renderer=undefined;}vi.unstubAllGlobals();});
describe('service access UI, fixture credentials only',()=>{
 it('does not issue automatically, masks one-time delivery and never copies without a click',async()=>{
  const a=api();await act(async()=>{renderer=create(React.createElement(ServiceTokenDelivery,{consent,api:a}));});expect(a.issueServiceToken).not.toHaveBeenCalled();
  const issue=button('生成服务访问令牌（仅交付一次）').props.onPress;
  await act(async()=>{issue();issue();});expect(a.issueServiceToken).toHaveBeenCalledTimes(1);expect(hasSecret()).toBe(true);expect(runtime.copy).not.toHaveBeenCalled();
  const input=renderer.root.findByType('TextInput');expect(input.props.secureTextEntry).toBe(true);expect(input.props.autoComplete).toBe('off');
  await act(async()=>{button('复制服务令牌').props.onPress();});expect(runtime.copy).toHaveBeenCalledTimes(1);
 });
 it('clears on background and retained reveal/copy handlers cannot recover the secret',async()=>{
  const a=api();await act(async()=>{renderer=create(React.createElement(ServiceTokenDelivery,{consent,api:a}));});await act(async()=>{button('生成服务访问令牌（仅交付一次）').props.onPress();});
  const copy=button('复制服务令牌').props.onPress,reveal=button('显示服务令牌').props.onPress;
  await act(async()=>{runtime.appListener?.('background');});await act(async()=>{runtime.appListener?.('active');copy();reveal();});
  expect(hasSecret()).toBe(false);expect(runtime.copy).not.toHaveBeenCalled();expect(button('生成服务访问令牌（仅交付一次）')).toBeUndefined();
 });
 it('clears on account/API identity switch even if the same screen and connection remain mounted',async()=>{
  const a=api();await act(async()=>{renderer=create(React.createElement(ServiceTokenDelivery,{consent,api:a}));});await act(async()=>{button('生成服务访问令牌（仅交付一次）').props.onPress();});
  const copy=button('复制服务令牌').props.onPress;
  await act(async()=>{renderer.update(React.createElement(ServiceTokenDelivery,{consent,api:api()}));});
  await act(async()=>{copy();});
  expect(hasSecret()).toBe(false);expect(runtime.copy).not.toHaveBeenCalled();
 });
 it('clears on navigation blur and rejects a late issuance reply while the screen stays mounted',async()=>{
  let finish!:(value:any)=>void;const a=api();a.issueServiceToken=vi.fn(()=>new Promise<{connectionID:string;token:string;expiresAt:number}>(resolve=>{finish=resolve;}));
  await act(async()=>{renderer=create(React.createElement(ServiceTokenDelivery,{consent,api:a}));});
  await act(async()=>{button('生成服务访问令牌（仅交付一次）').props.onPress();});
  await act(async()=>{runtime.blur?.();finish({token:fixtureSecret,connectionID:consent.id,expiresAt:Date.now()+60000});});
  expect(hasSecret()).toBe(false);expect(runtime.copy).not.toHaveBeenCalled();expect(button('生成服务访问令牌（仅交付一次）')).toBeUndefined();
 });
 it('does not issue when initially in the background and treats unknown delivery as non-repeatable',async()=>{
  runtime.state='background';const a=api();await act(async()=>{renderer=create(React.createElement(ServiceTokenDelivery,{consent,api:a}));});await act(async()=>{button('生成服务访问令牌（仅交付一次）').props.onPress();});expect(a.issueServiceToken).not.toHaveBeenCalled();
  await act(async()=>{runtime.appListener?.('active');});a.issueServiceToken=vi.fn(async()=>{throw Error('fixture-private-payload');});
  await act(async()=>{button('生成服务访问令牌（仅交付一次）').props.onPress();});
  expect(button('生成服务访问令牌（仅交付一次）')).toBeUndefined();expect(JSON.stringify(renderer.toJSON()).includes('fixture-private-payload')).toBe(false);
 });
 it('creates only a registered scope, defaults read-only/new sessions, and rejects more than 30 days',async()=>{
  const a=api(),created=vi.fn();await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:created}));});
  const choices=renderer.root.findAllByType('Pressable').filter((n:any)=>n.props.accessibilityRole==='checkbox');
  for(const method of ['tasks.create','sessions.send','sessions.cancel'])expect(choices.find((n:any)=>n.props.accessibilityLabel.includes(method)).props.accessibilityState.checked).toBe(false);
  await act(async()=>{renderer.root.findByType('TextInput').props.onChangeText('31');});expect(button('创建申请并审查权限').props.disabled).toBe(true);
  await act(async()=>{renderer.root.findByType('TextInput').props.onChangeText('30');});
  await act(async()=>{button('创建申请并审查权限').props.onPress();});
  expect(a.createService).toHaveBeenCalledTimes(1);const scope=(a.createService as any).mock.calls[0][0];expect(scope).toMatchObject({clientID:'service',workerID:'worker',machineID:'machine',projectID:'project',methods:['machines.list'],sessionIDs:[],expiresInMs:30*24*3600000});expect(scope.expiresAt).toBeUndefined();expect(scope).not.toHaveProperty('options');expect(created).toHaveBeenCalledWith('created_connection');
 });
 it.each([-3600000,1000,3600000])('submits the chosen duration independently of client clock skew (%i ms)',async(skew)=>{
  const clock=vi.spyOn(Date,'now').mockReturnValue(1793793600000+skew);
  try{
   const a=api();await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn()}));});
   await act(async()=>{button('创建申请并审查权限').props.onPress();});
   expect(a.createService).toHaveBeenCalledWith(expect.objectContaining({expiresInMs:30*24*3600000}));
   expect((a.createService as any).mock.calls[0][0].expiresAt).toBeUndefined();
  }finally{clock.mockRestore();}
 });
 it.each([
  ['SCOPE_DENIED','创建申请被拒绝，未创建授权'],
  ['DIRECTORY_SELECTION_MISMATCH','目录核实已失效或与所选范围不一致'],
  ['fixture-private-details','创建结果未确认'],
 ])('distinguishes a definite rejection from an unknown creation result (%s)',async(code,message)=>{
  const a=api(),created=vi.fn();a.createService=vi.fn(async()=>{throw Error(code);});
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:created}));});
  await act(async()=>{button('创建申请并审查权限').props.onPress();});
  const text=JSON.stringify(renderer.toJSON());expect(text).toContain(message);expect(text).not.toContain('fixture-private-details');
  expect(created).not.toHaveBeenCalled();expect(button('创建申请并审查权限').props.disabled).toBe(true);
  await act(async()=>{button('创建申请并审查权限').props.onPress();});expect(a.createService).toHaveBeenCalledTimes(1);
 });
});

function multiApi(upgraded = true) {
 const a = api();
 a.serviceOptions = vi.fn(async () => ({protocol:1,maxGrantMs:30*24*3600000,...(upgraded?{projectScopes:1,maxProjects:2}:{}),clients:[{id:'service',name:'Fixture backend',fingerprint:'fixture'}],workers:[
  {id:'worker',name:'Fixture worker',machineID:'machine',...(upgraded?{projectScopes:1}:{}),methods:['machines.list','tasks.create','sessions.send'],projects:[
   {id:'projectA',directory:'/fixture/a',sessionIDs:[]},{id:'projectB',directory:'/fixture/b',sessionIDs:[]},{id:'projectC',directory:'/fixture/c',sessionIDs:[]} ]},
  {id:'other_worker',name:'Other worker',machineID:'other_machine',...(upgraded?{projectScopes:1}:{}),methods:['machines.list'],projects:[{id:'projectX',directory:'/fixture/x',sessionIDs:[]}]}
 ]})) as any;
 return a;
}
describe('multi-project form selection (no real registration/credentials)', () => {
 it('defaults to one explicit project, requires at least one, and submits the exact selected set with v2 only for multiple projects',async()=>{
  const a=multiApi();await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn()}));});
  expect(button('projectA · /fixture/a').props.accessibilityState.checked).toBe(true);expect(button('projectB · /fixture/b').props.accessibilityState.checked).toBe(false);
  await act(async()=>{button('projectA · /fixture/a').props.onPress();});expect(button('创建申请并审查权限').props.disabled).toBe(true);
  await act(async()=>{button('projectB · /fixture/b').props.onPress();button('projectA · /fixture/a').props.onPress();});
  await act(async()=>{button('创建申请并审查权限').props.onPress();});
  const scope=(a.createService as any).mock.calls[0][0];expect(scope).toMatchObject({scopeVersion:2,projectIDs:['projectA','projectB'],sessionIDs:[],methods:['machines.list']});expect(scope.projectID).toBeUndefined();
 });
 it('blocks an oversized selection and resets directories and methods when the machine/worker changes',async()=>{
  const a=multiApi();await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn()}));});
  await act(async()=>{button('projectB · /fixture/b').props.onPress();button('projectC · /fixture/c').props.onPress();});expect(button('创建申请并审查权限').props.disabled).toBe(true);
  await act(async()=>{button('Other worker · other_machine').props.onPress();});
  expect(button('projectA · /fixture/a')).toBeUndefined();expect(button('projectX · /fixture/x').props.accessibilityState.checked).toBe(true);
  await act(async()=>{button('创建申请并审查权限').props.onPress();});
  expect((a.createService as any).mock.calls[0][0]).toMatchObject({workerID:'other_worker',machineID:'other_machine',projectID:'projectX',methods:['machines.list']});
 });
 it('fails closed for unsupported workers while preserving the legacy single-project request body',async()=>{
  const a=multiApi(false);await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn()}));});
  await act(async()=>{button('projectB · /fixture/b').props.onPress();});expect(button('创建申请并审查权限').props.disabled).toBe(true);expect(JSON.stringify(renderer.toJSON())).toContain('尚未报告多项目能力');expect(a.createService).not.toHaveBeenCalled();
  await act(async()=>{button('projectA · /fixture/a').props.onPress();});
  await act(async()=>{button('创建申请并审查权限').props.onPress();});
  const scope=(a.createService as any).mock.calls[0][0];expect(scope.projectID).toBe('projectB');expect(scope.scopeVersion).toBeUndefined();expect(scope.projectIDs).toBeUndefined();
 });
});

describe('owner browses directories then explicitly approves a v3 scope',()=>{
 function directoryApi(){
  const a=api();a.serviceOptions=vi.fn(async():Promise<ServiceConnectionOptions>=>({protocol:1,maxGrantMs:86400000,projectScopes:1,directoryScopes:1,maxProjects:32,clients:[{id:'service',name:'Fixture backend',fingerprint:'fixture'}],workers:[{id:'worker',name:'Fixture worker',machineID:'machine',methods:['machines.list'],projectScopes:1,directoryScopes:1,directorySelection:{roots:['/fixture']},projects:[{id:'project',directory:'/fixture/project',sessionIDs:[]}]}]}));
  a.resolveDirectories=vi.fn(async()=>({selectionID:'selection',expiresAt:Date.now()+120000,projects:[{id:'project',directory:'/fixture/project'},{id:'dynamic',directory:'/fixture/new'}]}));return a;
 }
 it('reuses the machine directory picker, requires worker verification and submits only its frozen canonical bindings',async()=>{
  const a=directoryApi(),created=vi.fn();await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:created}));});
  const picker=renderer.root.findByType('DirectoryPicker');expect(picker.props.machineId).toBe('machine');
  await act(async()=>{picker.props.onSelectDirectory('/fixture/new');});
  expect(button('创建申请并审查权限').props.disabled).toBe(true);expect(a.resolveDirectories).not.toHaveBeenCalled();
  await act(async()=>{button('让 Worker 核实所选目录').props.onPress();});
  expect(a.resolveDirectories).toHaveBeenCalledWith({clientID:'service',workerID:'worker',machineID:'machine',directories:['/fixture/project','/fixture/new']});
  expect(button('创建申请并审查权限').props.disabled).toBe(false);expect(a.createService).not.toHaveBeenCalled();
  await act(async()=>{button('创建申请并审查权限').props.onPress();});
  expect(a.createService).toHaveBeenCalledWith(expect.objectContaining({scopeVersion:3,projectIDs:['project','dynamic'],projects:[{id:'project',directory:'/fixture/project'},{id:'dynamic',directory:'/fixture/new'}],selectionID:'selection',sessionIDs:[]}));expect(created).toHaveBeenCalledWith('created_connection');expect(a.issueServiceToken).not.toHaveBeenCalled();
 });
 it('rejects root/outside/traversal, invalidates verification after selection change and discards late replies',async()=>{
  const a=directoryApi();let finish!:(v:any)=>void;a.resolveDirectories=vi.fn(()=>new Promise<Awaited<ReturnType<typeof a.resolveDirectories>>>(resolve=>{finish=resolve;}));
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn()}));});
  const picker=()=>renderer.root.findByType('DirectoryPicker');
  for(const path of ['/fixture','/fixture-other/repo','/fixture/../outside'])await act(async()=>{picker().props.onSelectDirectory(path);});
  expect(button('让 Worker 核实所选目录')).toBeUndefined();
  await act(async()=>{picker().props.onSelectDirectory('/fixture/new');});await act(async()=>{button('让 Worker 核实所选目录').props.onPress();});
  await act(async()=>{picker().props.onSelectDirectory('/fixture/another');});
  await act(async()=>{finish({selectionID:'old',projects:[{id:'old',directory:'/fixture/new'}],expiresAt:Date.now()+120000});});
  expect(button('创建申请并审查权限').props.disabled).toBe(true);
 });
 it('keeps a directory error retryable without creating grants and hides browsing for an old/offline worker',async()=>{
  const a=directoryApi();a.resolveDirectories=vi.fn(async()=>{throw Error('fixture-sensitive-internals');});
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn()}));});await act(async()=>{renderer.root.findByType('DirectoryPicker').props.onSelectDirectory('/fixture/new');});await act(async()=>{button('让 Worker 核实所选目录').props.onPress();});
  expect(a.createService).not.toHaveBeenCalled();expect(button('让 Worker 核实所选目录').props.disabled).toBe(false);expect(JSON.stringify(renderer.toJSON())).not.toContain('fixture-sensitive-internals');
  const b=api();await act(async()=>{renderer.update(React.createElement(ServiceConnectionForm,{api:b,onCreated:vi.fn()}));});expect(renderer.root.findAllByType('DirectoryPicker')).toHaveLength(0);
 });
});

const DAY=24*3600000;
function editableConsent(overrides:Partial<AutomationConsent>={}):AutomationConsent{
 const createdAt=Date.now();
 return{id:'old_connection',userID:'owner',clientID:'service',clientName:'Fixture backend',clientFingerprint:'fixture',workerFingerprint:'worker-fingerprint',workerID:'worker',workerName:'Fixture worker',machineID:'machine',projectID:'projectA',projectDirectory:'/fixture/a',methods:['machines.list'],sessionIDs:[],createdAt,expiresAt:createdAt+10*DAY,pendingUntil:createdAt+300000,credentialMode:'service-token-v1',state:'approved',digest:'d'.repeat(64),challenge:'fixture-challenge',disclosure:'fixture disclosure',...overrides};
}
function editApi(previous:AutomationConsent){
 const a=multiApi();a.consent=vi.fn(async()=>previous);a.revoke=vi.fn(async()=>previous);return a;
}
function directoryEditApi(previous:AutomationConsent){
 const a=editApi(previous);
 a.serviceOptions=vi.fn(async():Promise<ServiceConnectionOptions>=>({protocol:1,maxGrantMs:30*DAY,projectScopes:1,directoryScopes:1,maxProjects:32,clients:[{id:'service',name:'Fixture backend',fingerprint:'fixture'}],workers:[{id:'worker',name:'Fixture worker',machineID:'machine',methods:['machines.list','tasks.create'],projectScopes:1,directoryScopes:1,directorySelection:{roots:['/fixture']},projects:[{id:'project',directory:'/fixture/project',sessionIDs:[]}]}]}));
 a.resolveDirectories=vi.fn(async(input:{directories:string[]})=>({selectionID:'fresh_selection',expiresAt:Date.now()+120000,projects:input.directories.map(directory=>({id:directory==='/fixture/project'?'project':'dir_dynamic',directory}))}));return a;
}
const durationInput=()=>renderer.root.findAllByType('TextInput').find((n:any)=>n.props.accessibilityLabel==='服务授权有效天数');

describe('service authorization edit mode',()=>{
 it('prefills v1 exactly, including methods, original duration and options, then revokes only after creation',async()=>{
  const launchOptions={agents:[{agent:'fixture-agent',models:['fixture-model'],permissionModes:['fixture-mode']}]};
  const createdAt=Date.now(),previous=editableConsent({createdAt,expiresAt:createdAt+12.5*DAY,methods:['tasks.create','machines.list'],options:launchOptions});const a=editApi(previous),created=vi.fn();
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:created,sourceID:previous.id}));});
  expect(button('projectA · /fixture/a').props.accessibilityState.checked).toBe(true);expect(durationInput().props.value).toBe('12.5');
  expect(renderer.root.findAllByType('Pressable').find((n:any)=>n.props.accessibilityLabel?.includes('tasks.create')).props.accessibilityState.checked).toBe(true);
  await act(async()=>{button('创建申请并审查权限').props.onPress();});
  const scope=(a.createService as any).mock.calls[0][0];expect(scope).toMatchObject({projectID:'projectA',methods:['tasks.create','machines.list'],sessionIDs:[],options:launchOptions,expiresInMs:12.5*DAY});
  expect(scope).not.toHaveProperty('digest');expect(scope).not.toHaveProperty('clientFingerprint');expect(a.revoke).toHaveBeenCalledWith(previous.id);expect(created).toHaveBeenCalledWith('created_connection');
 });
 it('normalizes the gateway timestamp gap instead of prefilling a noisy fractional duration',async()=>{
  const createdAt=Date.now(),previous=editableConsent({createdAt,expiresAt:createdAt+30*DAY-1});const a=editApi(previous),created=vi.fn();
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:created,sourceID:previous.id}));});
  expect(durationInput().props.value).toBe('30');await act(async()=>{button('创建申请并审查权限').props.onPress();});
  expect((a.createService as any).mock.calls[0][0].expiresInMs).toBe(30*DAY);
 });
 it('restores every v2 project and keeps the v2 request shape',async()=>{
  const previous=editableConsent({scopeVersion:2,projectID:undefined,projectDirectory:undefined,projectIDs:['projectA','projectB'],projects:[{id:'projectA',directory:'/fixture/a'},{id:'projectB',directory:'/fixture/b'}],methods:['sessions.send']});const a=editApi(previous);
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn(),sourceID:previous.id}));});
  expect(button('projectA · /fixture/a').props.accessibilityState.checked).toBe(true);expect(button('projectB · /fixture/b').props.accessibilityState.checked).toBe(true);expect(button('projectC · /fixture/c').props.accessibilityState.checked).toBe(false);
  await act(async()=>{button('创建申请并审查权限').props.onPress();});
  expect((a.createService as any).mock.calls[0][0]).toMatchObject({scopeVersion:2,projectIDs:['projectA','projectB'],methods:['sessions.send']});
 });
 it('shows an over-limit original duration without clamping and allows the owner to shorten it',async()=>{
  const createdAt=Date.now(),previous=editableConsent({createdAt,expiresAt:createdAt+45*DAY});const a=editApi(previous);
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn(),sourceID:previous.id}));});
  expect(durationInput().props.value).toBe('45');expect(button('创建申请并审查权限').props.disabled).toBe(true);expect(JSON.stringify(renderer.toJSON())).toContain('settings.automation.serviceEditDurationTooLong');
  await act(async()=>{durationInput().props.onChangeText('30');});expect(button('创建申请并审查权限').props.disabled).toBe(false);
  await act(async()=>{button('创建申请并审查权限').props.onPress();});expect((a.createService as any).mock.calls[0][0].expiresInMs).toBe(30*DAY);
 });
 it('retains old sessionIDs/options and blocks project changes that would strand an existing session',async()=>{
  const launchOptions={agents:[{agent:'fixture-agent',models:[],permissionModes:[]}]};const previous=editableConsent({sessionIDs:['existing_a'],options:launchOptions});const a=editApi(previous);const current=await a.serviceOptions();
  current.workers[0].projects[0].sessionIDs=['existing_a'];a.serviceOptions=vi.fn(async()=>current);
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn(),sourceID:previous.id}));});
  expect(JSON.stringify(renderer.toJSON())).toContain('settings.automation.serviceEditSessionsRetained');
  await act(async()=>{button('projectA · /fixture/a').props.onPress();button('projectB · /fixture/b').props.onPress();});
  expect(button('创建申请并审查权限').props.disabled).toBe(true);expect(JSON.stringify(renderer.toJSON())).toContain('settings.automation.serviceEditSessionsInvalid');expect(a.createService).not.toHaveBeenCalled();
  await act(async()=>{button('projectB · /fixture/b').props.onPress();button('projectA · /fixture/a').props.onPress();});await act(async()=>{button('创建申请并审查权限').props.onPress();});
  expect((a.createService as any).mock.calls[0][0]).toMatchObject({projectID:'projectA',sessionIDs:['existing_a'],options:launchOptions});
 });
 it('never combines a v3 directory selection with retained existing sessionIDs',async()=>{
  const previous=editableConsent({projectID:'project',projectDirectory:'/fixture/project',sessionIDs:['existing']});const a=directoryEditApi(previous);const current=await a.serviceOptions();current.workers[0].projects[0].sessionIDs=['existing'];a.serviceOptions=vi.fn(async()=>current);
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn(),sourceID:previous.id}));});expect(button('创建申请并审查权限').props.disabled).toBe(false);
  await act(async()=>{renderer.root.findByType('DirectoryPicker').props.onSelectDirectory('/fixture/new');});await act(async()=>{button('让 Worker 核实所选目录').props.onPress();});
  expect(button('创建申请并审查权限').props.disabled).toBe(true);expect(JSON.stringify(renderer.toJSON())).toContain('settings.automation.serviceEditSessionsInvalid');expect(a.createService).not.toHaveBeenCalled();expect(a.revoke).not.toHaveBeenCalled();
 });
 it('partitions v3 into registered projects/custom directories and requires a fresh directory selection',async()=>{
  const previous=editableConsent({scopeVersion:3,projectID:undefined,projectDirectory:undefined,projectIDs:['project','dir_dynamic'],projects:[{id:'project',directory:'/fixture/project'},{id:'dir_dynamic',directory:'/fixture/new'}]});const a=directoryEditApi(previous);
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn(),sourceID:previous.id}));});
  expect(button('project · /fixture/project').props.accessibilityState.checked).toBe(true);expect(button('移除已选目录 · /fixture/new')).toBeDefined();expect(button('创建申请并审查权限').props.disabled).toBe(true);expect(a.resolveDirectories).not.toHaveBeenCalled();
  await act(async()=>{button('让 Worker 核实所选目录').props.onPress();});expect(a.resolveDirectories).toHaveBeenCalledWith({clientID:'service',workerID:'worker',machineID:'machine',directories:['/fixture/project','/fixture/new']});
  await act(async()=>{button('创建申请并审查权限').props.onPress();});
  expect((a.createService as any).mock.calls[0][0]).toMatchObject({scopeVersion:3,projectIDs:['project','dir_dynamic'],projects:[{id:'project',directory:'/fixture/project'},{id:'dir_dynamic',directory:'/fixture/new'}],selectionID:'fresh_selection',sessionIDs:[]});
 });
 it('does not downgrade an all-registered v3 scope to v1 and resets verification on API change',async()=>{
  const previous=editableConsent({scopeVersion:3,projectID:undefined,projectDirectory:undefined,projectIDs:['project'],projects:[{id:'project',directory:'/fixture/project'}]});const a=directoryEditApi(previous);
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn(),sourceID:previous.id}));});
  expect(button('移除已选目录 · /fixture/project')).toBeUndefined();expect(button('创建申请并审查权限').props.disabled).toBe(true);await act(async()=>{button('让 Worker 核实所选目录').props.onPress();});expect(button('创建申请并审查权限').props.disabled).toBe(false);
  const b=directoryEditApi(previous);await act(async()=>{renderer.update(React.createElement(ServiceConnectionForm,{api:b,onCreated:vi.fn(),sourceID:previous.id}));});expect(button('创建申请并审查权限').props.disabled).toBe(true);expect(b.resolveDirectories).not.toHaveBeenCalled();
  await act(async()=>{button('让 Worker 核实所选目录').props.onPress();});await act(async()=>{button('创建申请并审查权限').props.onPress();});expect((b.createService as any).mock.calls[0][0]).toMatchObject({scopeVersion:3,selectionID:'fresh_selection'});
 });
 it.each([
  ['ordinary signed connection',{credentialMode:undefined}],
  ['client fingerprint mismatch',{clientFingerprint:'changed'}],
  ['worker/machine mismatch',{machineID:'changed'}],
  ['registered directory mismatch',{projectDirectory:'/fixture/changed'}],
  ['method no longer registered',{methods:['sessions.cancel']}],
 ])('fails closed instead of showing default create values for %s',async(_name,overrides)=>{
  const previous=editableConsent(overrides);const a=editApi(previous);await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn(),sourceID:previous.id}));});
  expect(button('创建申请并审查权限')).toBeUndefined();expect(JSON.stringify(renderer.toJSON())).toContain('settings.automation.serviceEditLoadFailed');expect(a.createService).not.toHaveBeenCalled();expect(a.revoke).not.toHaveBeenCalled();
 });
 it.each(['options','consent'])('fails closed when %s loading fails',async(which)=>{
  const previous=editableConsent();const a=editApi(previous);if(which==='options')a.serviceOptions=vi.fn(async()=>{throw Error('fixture-private-options');});else a.consent=vi.fn(async()=>{throw Error('fixture-private-consent');});
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn(),sourceID:previous.id}));});expect(button('创建申请并审查权限')).toBeUndefined();expect(JSON.stringify(renderer.toJSON())).toContain('settings.automation.serviceEditLoadFailed');expect(JSON.stringify(renderer.toJSON())).not.toContain('fixture-private');
 });
 it('does not revoke the old grant when replacement creation fails',async()=>{
  const previous=editableConsent();const a=editApi(previous),created=vi.fn();a.createService=vi.fn(async()=>{throw Error('SCOPE_DENIED');});
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:created,sourceID:previous.id}));});await act(async()=>{button('创建申请并审查权限').props.onPress();});expect(a.revoke).not.toHaveBeenCalled();expect(created).not.toHaveBeenCalled();
 });
 it('waits for confirmed creation before revoking and confirmed revocation before navigating',async()=>{
  const previous=editableConsent();const a=editApi(previous),created=vi.fn();let finishCreate!:(value:any)=>void,finishRevoke!:(value:any)=>void;
  a.createService=vi.fn(()=>new Promise<any>(resolve=>{finishCreate=resolve;}));a.revoke=vi.fn(()=>new Promise<any>(resolve=>{finishRevoke=resolve;}));
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:created,sourceID:previous.id}));});await act(async()=>{button('创建申请并审查权限').props.onPress();});expect(a.revoke).not.toHaveBeenCalled();
  await act(async()=>{finishCreate({id:'replacement_connection'});});expect(a.revoke).toHaveBeenCalledWith(previous.id);expect(created).not.toHaveBeenCalled();
  await act(async()=>{finishRevoke(previous);});expect(created).toHaveBeenCalledWith('replacement_connection');
 });
 it('keeps an unknown revocation result submitted, exposes the new ID, and never retries automatically',async()=>{
  const previous=editableConsent();const a=editApi(previous),created=vi.fn();a.createService=vi.fn(async()=>({id:'replacement_connection'})) as any;a.revoke=vi.fn(async()=>{throw Error('fixture-revoke-private');});
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:created,sourceID:previous.id}));});await act(async()=>{button('创建申请并审查权限').props.onPress();});
  const text=JSON.stringify(renderer.toJSON());expect(text).toContain('settings.automation.serviceEditRevokeUnknown:replacement_connection');expect(text).not.toContain('fixture-revoke-private');expect(created).not.toHaveBeenCalled();expect(button('创建申请并审查权限').props.disabled).toBe(true);
  await act(async()=>{button('创建申请并审查权限').props.onPress();});expect(a.createService).toHaveBeenCalledTimes(1);expect(a.revoke).toHaveBeenCalledTimes(1);
 });
 it('uses the server state rather than the local wall clock when revoking the old source',async()=>{
  const createdAt=Date.now()-2*DAY,previous=editableConsent({createdAt,expiresAt:Date.now()-1000,state:'approved'});const a=editApi(previous),created=vi.fn();
  await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:created,sourceID:previous.id}));});await act(async()=>{button('创建申请并审查权限').props.onPress();});
  expect(a.revoke).toHaveBeenCalledWith(previous.id);expect(created).toHaveBeenCalledWith('created_connection');
 });
 it.each(['revoked','expired'])('does not revoke an already %s source again',async(state)=>{
  const previous=editableConsent({state});const a=editApi(previous),created=vi.fn();await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:created,sourceID:previous.id}));});await act(async()=>{button('创建申请并审查权限').props.onPress();});expect(a.revoke).not.toHaveBeenCalled();expect(created).toHaveBeenCalledWith('created_connection');
 });
 it('resets submission locks and discards late initialization when source/API changes',async()=>{
  const first=editableConsent();const a=editApi(first);a.createService=vi.fn(async()=>{throw Error('SCOPE_DENIED');});await act(async()=>{renderer=create(React.createElement(ServiceConnectionForm,{api:a,onCreated:vi.fn(),sourceID:first.id}));});await act(async()=>{button('创建申请并审查权限').props.onPress();});expect(button('创建申请并审查权限').props.disabled).toBe(true);
  let finishOld!:(value:AutomationConsent)=>void;const old=editApi(first);old.consent=vi.fn(()=>new Promise<AutomationConsent>(resolve=>{finishOld=resolve;}));
  const second=editableConsent({id:'second_connection',projectID:'projectB',projectDirectory:'/fixture/b'});const b=editApi(second);
  await act(async()=>{renderer.update(React.createElement(ServiceConnectionForm,{api:old,onCreated:vi.fn(),sourceID:first.id}));});await act(async()=>{renderer.update(React.createElement(ServiceConnectionForm,{api:b,onCreated:vi.fn(),sourceID:second.id}));});
  expect(button('projectB · /fixture/b').props.accessibilityState.checked).toBe(true);expect(button('创建申请并审查权限').props.disabled).toBe(false);await act(async()=>{finishOld(first);});expect(button('projectB · /fixture/b').props.accessibilityState.checked).toBe(true);
 });
});
