import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ScopedWorker } from '../worker';
import { hash } from '../../journal';
import type { Transport } from '../../relay';

// Actual independent session processes. Idle sessions survive dispatcher SIGKILL;
// each accepted message executes once, in the recorded cwd, behind a file gate.
const sessionProgram = `
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const [dir,cwd]=process.argv.slice(1);let current=null;const seen=new Set();
const events=()=>fs.readFileSync(path.join(dir,'events'),'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
const append=content=>{const seq=events().length+1;fs.appendFileSync(path.join(dir,'events'),JSON.stringify({id:'m'+seq,seq,content})+'\\n');};
setInterval(()=>{if(current)return;const m=events().find(m=>m.localId&&!seen.has(m.localId));if(!m)return;seen.add(m.localId);current=m;
 const turn='turn'+m.seq;append({role:'session',content:{role:'agent',turn,ev:{t:'turn-start'}}});
 const timer=setInterval(()=>{if(!fs.existsSync(path.join(dir,'release-'+m.seq)))return;clearInterval(timer);
 try{const file=m.content.content.text;fs.writeFileSync(path.join(cwd,file),'child '+process.pid);cp.execFileSync('git',['add','--',file],{cwd});cp.execFileSync('git',['commit','-m','fixture '+file],{cwd,stdio:'ignore'});
 append({role:'session',content:{role:'agent',turn,ev:{t:'text',text:'wrote '+file}}});
 append({role:'session',content:{role:'agent',turn,ev:{t:'turn-end',status:'completed'}}});}catch(e){append({role:'session',content:{role:'agent',turn,ev:{t:'turn-end',status:'failed'}}});}
 current=null;},10);
},10);setTimeout(()=>process.exit(0),60000);
`;
export function fixtureWorker(root: string, grantID = 'grant-a', workerID?: string) {
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    const registration = { ...config.registration, ...(workerID ? { id: workerID } : {}) };
    const sessionsRoot = join(root, 'sessions'); mkdirSync(sessionsRoot, { recursive: true });
    const sessions = () => readdirSync(sessionsRoot).map(id => JSON.parse(readFileSync(join(sessionsRoot, id, 'metadata'), 'utf8')));
    const messages = (id: string) => readFileSync(join(sessionsRoot, id, 'events'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const append = (id: string, localId: string, text: string) => {
        const events = messages(id), prior = events.find(m => m.localId === localId); if (prior) return prior;
        const m = { id: 'm' + (events.length + 1), seq: events.length + 1, localId, content: { role: 'user', content: { type: 'text', text } } };
        appendFileSync(join(sessionsRoot, id, 'events'), JSON.stringify(m) + '\n'); return m;
    };
    const state = (id: string) => {
        const s = sessions().find(s => s.id === id); if (!s) return 'unknown';
        try { const stat = readFileSync('/proc/' + s.metadata.hostPid + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z') ? 'stopped' : 'running'; }
        catch { return 'stopped'; }
    };
    const transport: Transport = {
        machines: async () => [{ id: registration.machineID, active: true } as any],
        sessions: async () => ({ sessions: sessions(), nextCursor: null }),
        messages: async (s, cursor = 0, limit = 100) => { const all = messages(s.id).filter(m => m.seq > cursor); return { messages: all.slice(0, limit), hasMore: all.length > limit }; },
        send: async (s, id, text) => { const sent = append(s.id, 'automation:' + id, text); const flag = join(root, 'lose-ack'); if (existsSync(flag)) { (await import('node:fs')).unlinkSync(flag); throw Error('fixture_ack_lost'); } return sent; },
        rpc: async (_m, input) => {
            if (input.operation === 'capabilities') return { version: 1, operations: ['create','request','cancel','status'] };
            if (input.operation === 'status') return { version: 1, process: state(String(input.sessionID)) };
            const receiptPath=join(root,'native-receipt-'+hash(String(input.requestID)));
            if(input.operation==='request'&&existsSync(receiptPath)){const r=JSON.parse(readFileSync(receiptPath,'utf8'));return {...r,process:state(r.sessionID)};}
            if (input.operation === 'cancel') {
                const s = sessions().find(s => s.id === input.sessionID);
                if (s && state(s.id) === 'running') process.kill(-s.metadata.hostPid, 'SIGTERM');
                const result={ version: 1, state: 'cancel_requested', process: state(String(input.sessionID)), sessionID: input.sessionID };writeFileSync(receiptPath,JSON.stringify(result));return result;
            }
            const id = hash(String(input.requestID)), dir = join(sessionsRoot, id);
            if (input.operation === 'request') return existsSync(join(dir, 'metadata')) ? { version: 1, state: 'confirmed', sessionID: id } : { version: 1, errorCode: 'NOT_FOUND' };
            if (input.operation === 'create') {
                if (!existsSync(dir)) {
                    mkdirSync(dir); writeFileSync(join(dir, 'events'), '');
                    const child = spawn(process.execPath, ['-e', sessionProgram, dir, String(input.directory)], { cwd: String(input.directory), stdio: 'ignore', detached: true }); child.unref();
                    writeFileSync(join(dir, 'metadata'), JSON.stringify({ id, metadata: { machineId: registration.machineID, path: input.directory, flavor: 'codex', hostPid: child.pid }, agentState: {}, active: true }));
                }
                return { version: 1, state: 'confirmed', sessionID: id };
            }
            throw Error('fixture_unknown_operation');
        },
    };
    const grant = (id: string) => JSON.parse(readFileSync(join(root, 'grants.json'), 'utf8'))[id];
    const worker = new ScopedWorker(registration, transport, join(root, 'worker'), async () => grant(grantID), Date.now, undefined, async id => grant(id), join(root, 'queue'));
    const call = (method: string, values: Record<string, unknown>) => worker.execute({ id: 'job', workerID: registration.id, grantID, deadline: Date.now() + 60000, command: { version: 1, method, ...values } }) as Promise<any>;
    return { worker, call, transport, sessions, messages, state, grant };
}
if (['--dispatch','--claim-only'].includes(process.argv[2])) {
    const f = fixtureWorker(process.argv[3]);
    const timer = setInterval(() => { if (process.argv[2] === '--dispatch') f.worker.scheduler.tick().catch(e => process.send?.({ error: e.message })); }, 25);
    if (process.argv[2] === '--claim-only') f.worker.queue.claim('worker');
    process.on('message', async (m: any) => { try { const result = await f.call(m.method, m.values); if (!m.drop) process.send?.({ id: m.id, result }); } catch(e) { process.send?.({ id: m.id, error: String(e) }); } });
    process.send?.({ ready: true });
    process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
}
