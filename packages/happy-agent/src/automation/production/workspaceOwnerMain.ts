import { fileURLToPath } from 'node:url';
import { createWorkspaceOwnerApi } from './workspaceOwnerApi';
import { readWorkspaceOwnerConfig } from './workspaceOwner';

export async function workspaceOwnerMain(argv: string[]) {
    if(argv.length!==2||argv[0]!=='--config')throw Error('WORKSPACE_OWNER_CONFIG_REQUIRED');
    const config=readWorkspaceOwnerConfig(argv[1]);
    const app=createWorkspaceOwnerApi({configFile:argv[1],jobEntry:fileURLToPath(new URL('./workspaceOwnerJob.mjs',import.meta.url))});
    let stopping=false;
    const stop=()=>{if(!stopping){stopping=true;void app.close().catch(()=>{process.exitCode=1;});}};
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
    try {await app.listen(config.listen);process.stdout.write(JSON.stringify({event:'workspace-owner-ready',contractVersion:1,sourceSHA:process.env.HAPPY_WORKSPACE_SOURCE_SHA??'development'})+'\n');}
    catch(e){process.off('SIGTERM',stop);process.off('SIGINT',stop);await app.close();throw e;}
    return app;
}
