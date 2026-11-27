import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readlinkSync,
    readSync, renameSync, realpathSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { ApiError } from './schema';
import { privateRead } from './privateFs';

export function archiveTree(path:string,indexFence?:string):string|undefined {
    const initial=lstatSync(path,{bigint:true,throwIfNoEntry:false});
    if(!initial) return;
    const dev=initial.dev, uid=BigInt(process.getuid!());
    const hash=createHash('sha256'), buffer=Buffer.alloc(128*1024);
    let count=0, total=0;
    const hardlinks=new Map<bigint,{first:string;expected:bigint;seen:bigint}>();
    const start=Date.now();
    const changed=()=>{throw new ApiError('WORKSPACE_ARCHIVE_CHANGED',409);};
    const add=(value:unknown)=>hash.update(JSON.stringify(value)+'\n');
    const verify=(a:BigIntStats,b:BigIntStats)=>{
        if(a.ino!==b.ino||a.dev!==b.dev||a.mode!==b.mode||a.size!==b.size||a.nlink!==b.nlink||a.ctimeNs!==b.ctimeNs||a.mtimeNs!==b.mtimeNs) changed();
    };
    const walk=(physical:string,name:string,depth:number)=>{
        const before=lstatSync(physical,{bigint:true});
        if(++count>80_000 || depth>80 || total>2_147_483_648 || Date.now()-start>25_000)
            throw new ApiError('WORKSPACE_ARCHIVE_LIMIT',409);
        if(before.dev!==dev||before.uid!==uid) throw new ApiError('WORKSPACE_ARCHIVE_UNSUPPORTED_FILE',409);
        add([name,Number(before.mode),name||!indexFence?before.mtimeNs.toString():'git-admin']);
        if(before.isSymbolicLink()) {
            add(readlinkSync(physical,{encoding:'buffer'}).toString('base64'));
            verify(before,lstatSync(physical,{bigint:true}));return;
        }
        if (!before.isDirectory()&&!before.isFile()) throw new ApiError('WORKSPACE_ARCHIVE_UNSUPPORTED_FILE',409);
        if(before.isFile()&&before.nlink!==1n){
            if(indexFence) throw new ApiError('WORKSPACE_ARCHIVE_UNSUPPORTED_FILE',409);
            const group=hardlinks.get(before.ino)??{first:name,expected:before.nlink,seen:0n};
            if(group.expected!==before.nlink)changed();
            group.seen++;
            hardlinks.set(before.ino,group);
            add(['hardlink',group.first]);
        }
        const fd=openSync(physical,constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_RDONLY|(before.isDirectory()?constants.O_DIRECTORY:0));
        try {
            verify(before,fstatSync(fd,{bigint:true}));
            if (before.isDirectory()) {
                const handle='/proc/self/fd/'+fd;
                for(const entry of readdirSync(handle,{encoding:'buffer'}).sort(Buffer.compare)) {
                    const text=entry.toString();
                    if(!Buffer.from(text).equals(entry)) throw new ApiError('WORKSPACE_ARCHIVE_UNSUPPORTED_FILE',409);
                    if(indexFence && !name && text==='index.lock' && privateRead(join(path,text),256).toString()===indexFence)continue;
                    walk(join(handle,text),name+'/'+text,depth+1);
                }
            } else {
                total+=Number(before.size);
                if(total>2_147_483_648) throw new ApiError('WORKSPACE_ARCHIVE_LIMIT',409);
                const content=createHash('sha256');
                let length=0, n:number;
                while((n=readSync(fd,buffer))>0) {
                    length+=n;
                    if(BigInt(length)>before.size || Date.now()-start>25_000) changed();
                    content.update(buffer.subarray(0,n));
                }
                if(BigInt(length)!==before.size) changed();
                add(content.digest('hex'));
            }
            verify(before,fstatSync(fd,{bigint:true}));
        } finally { closeSync(fd); }
        verify(before,lstatSync(physical,{bigint:true}));
    };
    if(!initial.isDirectory()||realpathSync(path)!==path) throw new ApiError('WORKSPACE_ARCHIVE_UNSUPPORTED_FILE',409);
    walk(path,'',0);
    // An alias outside this tree could change the archive after retirement.
    for(const group of hardlinks.values()){
        if(group.seen!==group.expected)throw new ApiError('WORKSPACE_ARCHIVE_UNSUPPORTED_FILE',409);
    }
    // An atomic move must preserve object identity as well as bytes.
    return initial.dev+':'+initial.ino+':'+hash.digest('hex');
}

function syncParent(path:string) {
    const fd=openSync(dirname(path),constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** No overwrite and no deletion of the material. A partially moved archive is
 * recovered against the same manifest; an unexpected tree is always retained. */
export function archiveMove(source:string,destination:string,expected:string|undefined) {
    const present=lstatSync(source,{throwIfNoEntry:false}), retained=lstatSync(destination,{throwIfNoEntry:false});
    if (!expected && !present && !retained) return;
    if (!expected || present && retained || !present && !retained) throw new ApiError('WORKSPACE_ARCHIVE_CHANGED',409);
    if (present) {
        if(archiveTree(source)!==expected) throw new ApiError('WORKSPACE_ARCHIVE_CHANGED',409);
        const targetParent=lstatSync(dirname(destination));
        if (!targetParent.isDirectory() || targetParent.dev!==present.dev) throw new ApiError('WORKSPACE_ARCHIVE_FILESYSTEM',409);
        renameSync(source,destination);
        syncParent(destination);syncParent(source);
    }
    // The verified rename stays on the same filesystem. A single kernel
    // durability barrier avoids an fsync round trip for every archived file.
    const directory=openSync(destination,constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_RDONLY);
    try {
        execFileSync('/usr/bin/sync',['--file-system','--','/proc/self/fd/3'],{timeout:30_000,
            stdio:['ignore','ignore','ignore',directory]});
    } catch {throw new ApiError('WORKSPACE_ARCHIVE_UNAVAILABLE',409);}
    finally {closeSync(directory);}
    if(archiveTree(destination)!==expected || lstatSync(source,{throwIfNoEntry:false}))
        throw new ApiError('WORKSPACE_ARCHIVE_CHANGED',409);
}

/** A normal Git index writer cannot replace the captured index through our
 * durable lock. An existing lock with a different owner is never removed. */
export async function withArchiveIndexFence<T>(directory:string, fingerprint:string, operationID:string, action:()=>Promise<T>) {
    const path=join(directory,'index.lock'), marker='happy-reclaim:'+operationID;
    const owns=()=>!!lstatSync(path,{throwIfNoEntry:false})&&privateRead(path,256).toString()===marker;
    if(!lstatSync(path,{throwIfNoEntry:false})) {
        const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try {writeFileSync(fd,marker);fsyncSync(fd);} finally {closeSync(fd);}
        syncParent(path);
    }
    if(!owns()) throw new ApiError('WORKSPACE_ARCHIVE_CHANGED',409);
    try {
        if(archiveTree(directory,marker)!==fingerprint) throw new ApiError('WORKSPACE_ARCHIVE_CHANGED',409);
        return await action();
    } finally {
        if(owns()){unlinkSync(path);syncParent(path);}
    }
}
