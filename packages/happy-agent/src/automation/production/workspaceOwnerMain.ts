import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createWorkspaceOwnerApi } from './workspaceOwnerApi';
import { readWorkspaceOwnerConfig } from './workspaceOwner';
import { readProductionConfig } from './config';
import { privateRead } from '../rest/privateFs';

export async function workspaceOwnerMain(argv: string[]) {
    if(argv.length!==2||argv[0]!=='--config')throw Error('WORKSPACE_OWNER_CONFIG_REQUIRED');
    const config=readWorkspaceOwnerConfig(argv[1]);
    const app=createWorkspaceOwnerApi({configFile:argv[1],jobEntry:fileURLToPath(new URL('./workspaceOwnerJob.mjs',import.meta.url)),
        reclaimCredential:()=>{
            const worker = readProductionConfig(readWorkspaceOwnerConfig(argv[1]).workerConfig);
            if (worker.role !== 'worker') return;
            const {token,serverUrl} = JSON.parse(privateRead(join(worker.happyHomeDirectory,'access.key'),32*1024).toString('utf8'));
            if (typeof token === 'string' && token && typeof serverUrl === 'string'
                && serverUrl.replace(/\/$/,'') === worker.relayURL.replace(/\/$/,'')) return 'Bearer ' + token;
            return undefined;
        },
    });
    let stopping=false;
    const stop=()=>{if(!stopping){stopping=true;void app.close().catch(()=>{process.exitCode=1;});}};
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
    try {await app.listen(config.listen);process.stdout.write(JSON.stringify({event:'workspace-owner-ready',contractVersion:1,sourceSHA:process.env.HAPPY_WORKSPACE_SOURCE_SHA??'development'})+'\n');}
    catch(e){process.off('SIGTERM',stop);process.off('SIGINT',stop);await app.close();throw e;}
    return app;
}
