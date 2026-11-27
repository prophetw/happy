import { afterEach, expect, it, vi } from 'vitest';
import { workspaceManagerClient, workspaceManagerRpcClient, WorkspaceManagerError } from './workspaceManagement';
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

it('uses the paired machine for the first catalog and the original-request inventory', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const call = vi.fn().mockResolvedValueOnce({ status: 200, body: { version: 1, ok: true,
        data: { ownerID: 'owner', machineID: 'paired', machineName: 'Host', automaticGC: false, projects: [] } } })
        .mockResolvedValueOnce({ status: 200, body: { version: 1, ok: true,
            data: { total: 0, returned: 0, items: [], next: null } } });
    const client = workspaceManagerRpcClient('paired', () => true, call);
    await expect(client.catalog()).resolves.toMatchObject({ machineID: 'paired' });
    await client.inventory({ action: 'delivery-inventory', machineID: 'paired', projectID: 'project', requestID: 'original' });
    expect(call.mock.calls).toEqual([
        ['paired', 'workspace-owner-v1', { route: 'catalog', body: {} }],
        ['paired', 'workspace-owner-v1', { route: 'read', body: {
            action: 'delivery-inventory', machineID: 'paired', projectID: 'project', requestID: 'original', view: 'pending', limit: 5,
        } }],
    ]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.inventory({ action: 'inventory', machineID: 'other', projectID: 'project' })).rejects.toThrow('WORKSPACE_SCOPE_DENIED');
    expect(call).toHaveBeenCalledTimes(2);
});

it('distinguishes an unavailable paired machine from a rejected owner request', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('RPC method not available'))
        .mockResolvedValueOnce({ status: 403, body: { version: 1, ok: false,
            error: { code: 'WORKSPACE_SCOPE_DENIED' }, dispatch: 'not_started' } });
    const client = workspaceManagerRpcClient('paired', () => true, call);
    await expect(client.catalog()).rejects.toThrow('WORKSPACE_MACHINE_UNAVAILABLE');
    await expect(client.catalog()).rejects.toMatchObject({ message: 'WORKSPACE_SCOPE_DENIED', rejected: true });
});
