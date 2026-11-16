import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { workspacesZh } from '@/text/workspaces';
const h=vi.hoisted(()=>({saved:new Map<string,string>()}));
vi.mock('react-native',async()=>{const R=await import('react');const host=(name:string)=>(props:any)=>R.createElement(name,props,props.children);return Object.fromEntries(['View','Text','Pressable','ScrollView','ActivityIndicator'].map(n=>[n,host(n)]));});
vi.mock('react-native-unistyles',()=>({useUnistyles:()=>({theme:{colors:{text:'#222',textSecondary:'#666',surface:'#fff',surfaceHigh:'#eee',divider:'#ddd'}}})}));
vi.mock('expo-crypto',()=>({randomUUID:()=> 'ui-operation-1'}));
vi.mock('@react-native-async-storage/async-storage',()=>({default:{getItem:async(k:string)=>h.saved.get(k)??null,setItem:async(k:string,v:string)=>{h.saved.set(k,v);}}}));
vi.mock('@/text',async()=>{const {workspacesZh}=await import('@/text/workspaces');return {t:(key:string)=>key.split('.').slice(1).reduce((v:any,k)=>v?.[k],workspacesZh)??key};});
import { WorkspaceManagerPanel } from './WorkspaceManagerPanel';
import { WorkspaceManagerError } from '@/sync/workspaceManagement';
let renderer:ReturnType<typeof create>;
beforeAll(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;const error=console.error;vi.spyOn(console,'error').mockImplementation((message?:unknown,...args:unknown[])=>{if(typeof message==='string'&&message.startsWith('react-test-renderer is deprecated'))return;error(message,...args);});});
beforeEach(()=>{h.saved.clear();});
afterEach(async()=>{if(renderer)await act(async()=>renderer.unmount());vi.useRealTimers();});
const text=()=>renderer.root.findAllByType('Text').map((n:any)=>n.props.children).flat().join(' ');
const button=(name:string)=>renderer.root.findAllByType('Pressable').find((n:any)=>n.props.accessibilityLabel===name)!;
const press=async(name:string)=>{await act(async()=>{button(name).props.onPress();});};
function data(){
    const id='a'.repeat(64),head='b'.repeat(40),plan={version:1,id:'c'.repeat(64),policy:'d'.repeat(64),workspaceID:id,revision:1,workspaceState:'active',outcome:'resolved',checkedAt:Date.now(),expiresAt:Date.now()+60000,eligible:true,reasons:[],binding:'e'.repeat(64),git:'f'.repeat(64),tasks:'1'.repeat(64),head,branch:'task',mainCommit:head};
    const item={id,projectID:'project-a',directory:'/fixture/managed',branch:'task',baseCommit:head,revision:1,state:'resolved',managed:true,reasons:[],taskCount:1,tasks:[],plan};
    const detail={item,plan,inspectedHead:head,adoptionVerified:false,result:{workspaceID:id,revision:1,workspaceState:'active',operations:[]}};
    const client={catalog:vi.fn().mockResolvedValue({ownerID:'owner',machineID:'machine',machineName:'Fixture',automaticGC:false,projects:[{id:'project-a',name:'Project A',allowApply:true,allowArchive:false,allowDiscard:false},{id:'project-b',name:'Project B',allowApply:true,allowArchive:false,allowDiscard:false}]}),
        inventory:vi.fn().mockResolvedValue({total:1,returned:1,items:[item],next:null}),detail:vi.fn().mockResolvedValue(detail),plan:vi.fn().mockResolvedValue({ticket:'ticket',plan}),mutate:vi.fn(),result:vi.fn()};
    return {client,plan,item,detail};
}
const mount=async(client:any)=>{await act(async()=>{renderer=create(<WorkspaceManagerPanel client={client} current={()=>true} contextKey="workspace" onClose={()=>{}}/>);});};
it('loads initial catalog/list without invalidating its own request and resets a selected plan on project switch',async()=>{
    const f=data();await mount(f.client);expect(text()).toContain('Project A');expect(f.client.inventory).toHaveBeenCalledOnce();
    await press(workspacesZh.inspect);await press(workspacesZh.plan);expect(text()).toContain(workspacesZh.confirmTitle);
    await press('Project B');expect(text()).not.toContain(workspacesZh.confirmTitle);expect(f.client.inventory.mock.calls.at(-1)![0].projectID).toBe('project-b');expect(f.client.mutate).not.toHaveBeenCalled();
});
it('requires explicit confirmation, persists one ID before write, blocks repeated clicks and restores unknown after refresh',async()=>{
    const f=data();f.client.mutate.mockRejectedValue(Error('network unknown'));await mount(f.client);
    await press(workspacesZh.inspect);await press(workspacesZh.plan);expect(button(workspacesZh.apply).props.disabled).toBe(true);
    await press(workspacesZh.agree);const apply=button(workspacesZh.apply);await act(async()=>{apply.props.onPress();apply.props.onPress();});
    expect(f.client.mutate).toHaveBeenCalledOnce();expect(f.client.mutate.mock.calls[0][0].operationID).toBe('ui-operation-1');expect(text()).toContain(workspacesZh.unknownRequest);
    await act(async()=>renderer.unmount());await mount(f.client);expect(text()).toContain(workspacesZh.unknownRequest);expect(f.client.mutate).toHaveBeenCalledOnce();
    f.client.result.mockResolvedValue({operationID:'ui-operation-1',status:'settled',receipt:{id:'ui-operation-1',fingerprint:'a'.repeat(64),state:'removed',revision:2}});
    await press(workspacesZh.query);expect(text()).toContain(workspacesZh.removed);expect(f.client.result.mock.calls[0][0].operationID).toBe('ui-operation-1');
});
it('does not turn a failed follow-up refresh into an unknown or successful mutation',async()=>{
    const f=data();f.client.mutate.mockResolvedValue({operationID:'ui-operation-1',status:'settled',error:'WORKSPACE_PLAN_CHANGED'});await mount(f.client);await press(workspacesZh.inspect);await press(workspacesZh.plan);await press(workspacesZh.agree);await press(workspacesZh.apply);
    expect(text()).toContain(workspacesZh.failed);expect(text()).not.toContain(workspacesZh.removed);expect(text()).not.toContain(workspacesZh.unknownRequest);
});
it('keeps an old unknown operation unknown when a same-ID retry is rejected before authentication/dispatch',async()=>{
    const f=data();f.client.mutate.mockRejectedValueOnce(Error('ack lost')).mockRejectedValueOnce(new WorkspaceManagerError('OWNER_AUTH_REQUIRED',true));
    await mount(f.client);await press(workspacesZh.inspect);await press(workspacesZh.plan);await press(workspacesZh.agree);await press(workspacesZh.apply);
    expect(text()).toContain(workspacesZh.unknownRequest);await press(workspacesZh.retry);
    expect(text()).toContain(workspacesZh.unknownRequest);expect(text()).not.toContain(workspacesZh.failed);
    expect(f.client.mutate.mock.calls.map(call=>call[0].operationID)).toEqual(['ui-operation-1','ui-operation-1']);
    f.client.result.mockResolvedValue({operationID:'ui-operation-1',status:'settled',receipt:{id:'ui-operation-1',fingerprint:'a'.repeat(64),state:'removed',revision:2}});
    await press(workspacesZh.query);expect(text()).toContain(workspacesZh.removed);
});
