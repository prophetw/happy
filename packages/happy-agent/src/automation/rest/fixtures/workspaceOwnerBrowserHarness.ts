import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceOwnerFixture } from './workspaceOwnerFixture';
import { projectResponse } from '../projection';
const f=await workspaceOwnerFixture(),assets=process.argv[2];
f.app.get('/',async(_req,reply)=>reply.type('text/html').send('<!doctype html><html lang="zh"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dots workspaces · isolated fixture</title><style>html,body,#root{margin:0;min-height:100%;font-family:system-ui}body{background:#fff}</style><div id="root"></div><script src="/fixture.js"></script></html>'));
f.app.get('/fixture.js',async(_req,reply)=>reply.type('application/javascript').send(readFileSync(join(assets,'fixture.js'))));
await f.app.listen({host:'127.0.0.1',port:20082});
process.send?.({ready:true,root:f.root,repo:f.repo,workspaces:Object.fromEntries(Object.entries(f.workspaces).map(([key,w])=>[key,{id:w.id,cwd:w.cwd}]))});
process.on('message',async message=>{
    if(message==='results')process.send?.({kind:'results',tasks:f.queue.tasks().map(task=>({id:task.id,...projectResponse({version:1,ok:true,data:f.queue.receipt(task)})}))});
    if(message==='stop'){await f.app.close();rmSync(f.root,{recursive:true,force:true});process.disconnect?.();}
});
