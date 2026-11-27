import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostedTaskInbox } from './hostedTaskInbox';
import { HostedDotConfig, addOutput, hash, loadHostedState, type HostedState } from './hostedDotState';
import { createHostedStorageWriter, hostedHistoryEvent, hostedHistoryOutput, readHostedStorage, saveHostedStorage } from './hostedDotStorage';
import { checkpointHostedTaskInputs, checkpointHostedUserInputs } from './hostedInputCheckpoint';
import { createEnvelope } from '@slopus/happy-wire';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const id = (n: number) => 'task-' + createHash('sha256').update(String(n)).digest('hex');
const eventText = 'isolated notification';
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'happy-retention-')); roots.push(directory);
    const config = HostedDotConfig.parse({ version: 1, dotId: randomUUID(), sessionId: 'isolated', directory,
        happyHome: join(directory, 'happy'), serverUrl: 'http://127.0.0.1:1', executable: process.execPath, args: [],
        model: 'scripted', provider: 'openai', instruction: 'fixture', codexHome: join(directory, 'codex') });
    const file = join(directory, 'state.json');
    const state: HostedState = { version: 1, epoch: 2, threadId: 'existing-thread', creating: false, afterSeq: 10000,
        status: 'ready', error: null, binding: hash(config), inputs: [], outputs: [], controls: [], outputReceipts: [],
        authority: {version:1,producer:{pid:1,start:'1',boot:randomUUID()},revision:1} };
    saveHostedStorage(file, state);
    const folder = join(directory, 'events'); mkdirSync(folder);
    const publish = (n: number, epoch = 2, text = eventText) => {
        const path = join(folder,id(n)+'.json');
        writeFileSync(path, JSON.stringify({version:1,id:id(n),dotId:config.dotId,sessionId:config.sessionId,epoch,createdAt:new Date().toISOString(),text}));
        return path;
    };
    return { directory, config, file, state, publish, folder };
}

it('takes a notification durably before removing the file, then deduplicates a late copy after reopen', () => {
    const f = fixture(), inbox = new HostedTaskInbox(f.config), failed = f.publish(1);
    expect(() => inbox.sweep(f.state,128,10000,()=>{throw Error('fixture_crash');},()=>false)).toThrow('fixture_crash');
    expect(existsSync(failed)).toBe(true); inbox.close();
    const reopened = loadHostedState(f.file,f.config), write = createHostedStorageWriter(f.file,reopened);
    expect(inbox.sweep(reopened,128,10000,()=>write(),()=>false).removed).toBe(1);
    expect(readHostedStorage(f.file)?.inputs).toHaveLength(1); expect(existsSync(failed)).toBe(false);
    f.publish(1); f.publish(2,1); f.publish(3,3);
    const result = inbox.sweep(reopened,128,10000,()=>write(),()=>false);
    expect(result).toMatchObject({removed:2,suppressed:1,deferred:1,taken:0});
    expect(readHostedStorage(f.file)?.inputs).toHaveLength(1);
    expect(existsSync(join(f.folder,id(3)+'.json'))).toBe(true);
    inbox.close();
});

it('continues draining a legacy directory past the former 4,000-entry cap in bounded slices', () => {
    const f = fixture();
    for (let i=0;i<4001;i++) writeFileSync(join(f.folder,'unrelated-'+i),'');
    const pending=f.publish(1), inbox=new HostedTaskInbox(f.config), writer=createHostedStorageWriter(f.file,f.state);
    let count=0;
    for (let sweep=0;sweep<70 && existsSync(pending);sweep++) count += inbox.sweep(f.state,128,10000,()=>writer(),()=>false).removed;
    expect(count).toBe(1); expect(existsSync(pending)).toBe(false);
    expect(existsSync(join(f.folder,'unrelated-4000'))).toBe(true);
    inbox.close();
});

it('runs two real 8k checkpoint-and-spill cycles with exact indexed cold proofs after reopen', () => {
    const f=fixture();
    for (const cycle of [0,1]) {
        const previous = loadHostedState(f.file,f.config), write = createHostedStorageWriter(f.file,previous);
        const base=cycle*10000;
        previous.afterSeq=base+8001;
        previous.inputs=Array.from({length:8000},(_,i)=>({epoch:2,seq:base+i+1,id:'u-'+(base+i+1),
            text:'fixture input',status:'completed',delivery:'queue',turnId:'turn',beforeTurns:[]}));
        const taskId=id(20+cycle);
        previous.inputs.unshift({epoch:2,id:taskId,origin:'task-result',text:eventText,status:'completed',
            delivery:'queue',acceptedAt:123,turnId:'notice-turn',beforeTurns:[]});
        for (let i=0;i<8192;i++) previous.outputReceipts.push(`hosted:2:event-${base+i}`);
        const events=checkpointHostedTaskInputs(previous,0), users=checkpointHostedUserInputs(previous,0);
        expect(events).toHaveLength(1); expect(users.length).toBeGreaterThan(3900);
        write(users,events);
        const next=loadHostedState(f.file,f.config);
        expect(next.threadId).toBe(f.state.threadId);expect(next.epoch).toBe(2);expect(next.afterSeq).toBe(base+8001);
        expect(next.inputs).toHaveLength(4000); expect(next.outputReceipts).toHaveLength(2048);
        expect(hostedHistoryOutput(f.directory,`hosted:2:event-${base}`)).toBe(true);
        expect(addOutput(next,createEnvelope('agent',{ t:'service',text:'duplicate' },{ id:`event-${base}` }))).toBe(false);
        expect(hostedHistoryEvent(f.directory,2,taskId)?.acceptedAt).toBe(123);
        const archived = readHostedStorage(f.file, ['inputs'], [{seq:base+1,id:'u-'+(base+1)}]);
        expect(archived?.archivedInputs).toHaveLength(1);
        expect(readFileSync(f.file,'utf8')).toContain('hosted_sqlite_history_reader_required');
    }
});
