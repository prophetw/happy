import { existsSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { processProbeLimit, scanWorkspaceProcesses, type ProcessScope } from '../rest/workspaceProcessScan';

function readRequest(): unknown {
    const buffer = Buffer.alloc(processProbeLimit);
    let size = 0;
    while (size < buffer.length) {
        const count = readSync(0, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        const newline = buffer.subarray(size, size + count).indexOf(10);
        if (newline >= 0) return JSON.parse(buffer.toString('utf8', 0, size + newline));
        size += count;
    }
    throw new Error('missing process probe frame');
}

const ids = (values: unknown): values is number[] => Array.isArray(values)
    && values.every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647);

async function run() {
    const root = process.argv[2], request = readRequest() as Partial<ProcessScope> & { id?: string; temporary?:true; archive?:string };
    const archiveRoot=process.argv[3];
    if (![3,4].includes(process.argv.length) || root !== realpathSync(root) || !request
        || Object.keys(request).length !== (request.temporary===true?5:4)+(request.archive!==undefined?1:0)
        || Object.keys(request).some(key=>!['id','pids','groups','sessions','temporary','archive'].includes(key))
        || request.archive!==undefined && (!archiveRoot || request.temporary!==true || !/^[a-f0-9]{64}$/.test(request.archive))
        || typeof request.id !== 'string' || !/^[a-f0-9]{64}$/.test(request.id)
        || !ids(request.pids) || !ids(request.groups) || !Array.isArray(request.sessions) || !request.sessions.length
        || !request.sessions.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('invalid probe scope');
    const cwd=join(root,request.id), temp=join(dirname(root),'temporary',request.id);
    const own=(directory:string)=>{
        if(realpathSync(directory)!==directory)throw Error('invalid scope path');
        const stat=statSync(directory);
        if(!stat.isDirectory()||stat.uid!==process.getuid?.())throw Error('invalid scope directory');
    };
    const extra=request.temporary?[temp]:[];
    if(existsSync(temp)&&request.temporary)own(temp);
    if(existsSync(cwd)||!request.archive)own(cwd);
    if(request.archive) {
        own(archiveRoot);
        const root=join(archiveRoot,request.archive), saved=join(root,'checkout'), auxiliary=join(root,'temporary');
        own(root);own(saved);
        if(existsSync(auxiliary))own(auxiliary);
        extra.push(saved,auxiliary);
    }
    return scanWorkspaceProcesses(cwd,{pids:request.pids,groups:request.groups,sessions:request.sessions},extra);
}

const result = await run().catch(() => ({ confirmed: false, blockers: ['activity_visibility_unconfirmed'], fingerprint: '' }));
process.stdout.write(JSON.stringify(result) + '\n');
