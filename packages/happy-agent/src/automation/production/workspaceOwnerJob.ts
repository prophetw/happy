import { executeWorkspaceOwnerJob, workspaceOwnerControlProjects } from './workspaceOwner';
import { ApiError } from '../rest/schema';

// Only a fixed fork entry, not a shell/CLI command assembled by the browser.
if (process.env.HAPPY_WORKSPACE_OWNER_JOB === '1') process.once('message', async (message: unknown) => {
    const input = message as { configFile: string; ownerID: string; request: {projectID:string}; plan?: unknown;authorization?:string };
    let result: unknown;
    try { result = { ok: true, data: await executeWorkspaceOwnerJob(input.configFile, input.ownerID, input.request, input.plan,{authorize:async()=>{
        if(!(await workspaceOwnerControlProjects(input.configFile,input.authorization,input.ownerID)).includes(input.request.projectID))throw new ApiError('WORKSPACE_SCOPE_DENIED',403);
    }}) }; }
    catch (error) { result = { ok: false, error: { code: error instanceof ApiError ? error.code : 'WORKSPACE_INSPECTION_UNCONFIRMED' } }; }
    process.send?.(result, () => process.disconnect?.());
});
