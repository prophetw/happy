import { afterEach, expect, it, vi } from 'vitest';
import { workspaceManagerClient, WorkspaceManagerError } from './workspaceManagement';
afterEach(()=>vi.unstubAllGlobals());
it('checks schemas, target scope and operation identity rather than treating HTTP acceptance as success',async()=>{
    const fetch=vi.fn().mockResolvedValue({ok:true,status:200,json:async()=>({version:1,ok:true,data:{operationID:'wrong-id',status:'settled',error:'WORKSPACE_PLAN_CHANGED'}})});vi.stubGlobal('fetch',fetch);
    const client=workspaceManagerClient('fixture-only',()=>true);
    await expect(client.mutate({action:'apply',machineID:'machine',projectID:'project',workspaceID:'a'.repeat(64),operationID:'correct-id',ticket:'ticket',confirmedPlanID:'b'.repeat(64)})).rejects.toThrow('WORKSPACE_RESULT_UNKNOWN');
    expect(JSON.parse(fetch.mock.calls[0][1].body).operationID).toBe('correct-id');
});
it('distinguishes confirmed precondition rejection from unavailable/unknown responses',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:409,json:async()=>({version:1,ok:false,error:{code:'WORKSPACE_PLAN_EXPIRED_OR_BLOCKED'},dispatch:'not_started'})}));
    const client=workspaceManagerClient('fixture-only',()=>true);
    const failure=await client.plan({action:'plan',machineID:'machine',projectID:'project',workspaceID:'a'.repeat(64)}).catch(e=>e);
    expect(failure).toBeInstanceOf(WorkspaceManagerError);expect(failure.rejected).toBe(true);
});
it('keeps post-dispatch authorization failures unknown instead of declaring no side effects',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:403,json:async()=>({version:1,ok:false,error:{code:'WORKSPACE_SCOPE_DENIED'},dispatch:'unknown'})}));
    const failure=await workspaceManagerClient('fixture-only',()=>true).plan({action:'plan',machineID:'machine',projectID:'project',workspaceID:'a'.repeat(64)}).catch(e=>e);
    expect(failure.rejected).toBe(false);
});
it('does not display another account response after the active account changes',async()=>{
    let current=true;vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>{current=false;return {ok:true,status:200,json:async()=>({})};}));
    await expect(workspaceManagerClient('fixture-only',()=>current).catalog()).rejects.toThrow('WORKSPACE_SCOPE_CHANGED');
});
