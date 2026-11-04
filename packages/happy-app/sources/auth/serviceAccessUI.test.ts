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
  expect(a.createService).toHaveBeenCalledTimes(1);const scope=(a.createService as any).mock.calls[0][0];expect(scope).toMatchObject({clientID:'service',workerID:'worker',machineID:'machine',projectID:'project',methods:['machines.list'],sessionIDs:[],expiresInMs:30*24*3600000});expect(scope.expiresAt).toBeUndefined();expect(created).toHaveBeenCalledWith('created_connection');
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
