import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existingAutomationAuth, bundleReplacementAction, assertNoAutomationDaemonState, acquireAutomationDaemonLock, clearOwnedAutomationState, releaseOwnedAutomationLock, verifyManagedStartupMachine } from './automationBootstrap';
import { launchAutomationWorker } from './automationMain';
import type { WorkerConfig, SecretProvider } from 'happy-agent/automation/production';
const dirs: string[]=[];
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function fixture() {
    const dir=mkdtempSync(join(tmpdir(),'happy-worker-boot-'));dirs.push(dir);const project=join(dir,'project');mkdirSync(project);
    const config={version:1,role:'worker',endpoint:'https://control.invalid/happy-control/v1',relayURL:'https://relay.invalid',happyHomeDirectory:join(dir,'unused-home'),identityRef:'worker',
        registration:{id:'worker',userID:'u',machineID:'m',name:'fixture',publicKey:'fixture-unused',projects:[{id:'p',directory:project,sessionIDs:[]}],methods:['machines.list'],protocol:1},
        secrets:{type:'encrypted-pkcs8-credentials',credentialsDirectory:join(dir,'unused-credentials'),keys:{}}} as WorkerConfig;
    const provider:SecretProvider={identity:vi.fn(async()=>({id:'worker',sign:async()=>Buffer.from('fixture')})),close:vi.fn(async()=>{})};
    return{config,provider,dir};
}
describe('production worker boot without auth material access',()=>{
    it('passes only a provider signer to the explicit daemon seam and closes provider',async()=>{
        const f=fixture(),boot=vi.fn(async()=>{});await launchAutomationWorker(f.config,f.provider,boot);expect(boot).toHaveBeenCalledOnce();expect(f.provider.close).toHaveBeenCalledOnce();
    });
    it('fails closed before daemon startup if provider fails or project realpath changes',async()=>{
        const f=fixture(),boot=vi.fn(async()=>{});vi.mocked(f.provider.identity).mockRejectedValueOnce(new Error('SECRET_PROVIDER_UNAVAILABLE'));
        await expect(launchAutomationWorker(f.config,f.provider,boot)).rejects.toThrow('SECRET_PROVIDER_UNAVAILABLE');expect(boot).not.toHaveBeenCalled();expect(f.provider.close).toHaveBeenCalledOnce();
        const alias=join(f.dir,'alias');symlinkSync(f.config.registration.projects[0].directory,alias);f.config.registration.projects[0].directory=alias;
        await expect(launchAutomationWorker(f.config,f.provider,boot)).rejects.toThrow('AUTOMATION_PROJECT_REALPATH_REQUIRED');expect(boot).not.toHaveBeenCalled();
    });
});


describe('existing-only authentication and supervised upgrade policy',()=>{
    it('never falls back to login/machine creation for missing, legacy or mismatched identity',async()=>{
        const valid={token:'fixture-bearer',encryption:{type:'dataKey' as const,publicKey:new Uint8Array(32),machineKey:new Uint8Array(32)}};
        for(const value of [null,{...valid,encryption:{type:'legacy' as const,secret:new Uint8Array(32)}}]) {
            await expect(existingAutomationAuth('m',{credentials:async()=>value,settings:async()=>({machineId:'m'})})).rejects.toThrow('AUTOMATION_EXISTING_AUTH_REQUIRED');
        }
        await expect(existingAutomationAuth('other',{credentials:async()=>valid,settings:async()=>({machineId:'m'})})).rejects.toThrow('AUTOMATION_EXISTING_AUTH_REQUIRED');
        expect((await existingAutomationAuth('m',{credentials:async()=>valid,settings:async()=>({machineId:'m'})})).machineId).toBe('m');
    });
    it('keeps managed worker config under service supervision instead of silently handing off to an ordinary daemon',()=>{
        expect(bundleReplacementAction(true)).toBe('supervisor');expect(bundleReplacementAction(false)).toBe('legacy-handoff');
    });
});

it('treats malformed daemon state as present instead of permission to start',async()=>{
    const f=fixture(),path=join(f.dir,'daemon.state.json');await expect(assertNoAutomationDaemonState(path)).resolves.toBeUndefined();
    writeFileSync(path,'{broken');await expect(assertNoAutomationDaemonState(path)).rejects.toThrow('AUTOMATION_DAEMON_ALREADY_PRESENT');
});

it('never steals a preexisting corrupt lock in managed worker startup',async()=>{
    const f=fixture(),path=join(f.dir,'daemon.lock');const fd=await acquireAutomationDaemonLock(path);await fd.close();
    await expect(acquireAutomationDaemonLock(path)).rejects.toThrow('AUTOMATION_DAEMON_LOCK_UNAVAILABLE');
});


it('managed cleanup retains metadata replaced by another owner', async()=>{
 const f=fixture(),state=join(f.dir,'state.json'),lock=join(f.dir,'owner.lock'),fd=await acquireAutomationDaemonLock(lock);
 try {writeFileSync(state,JSON.stringify({pid:process.pid+1}));await expect(clearOwnedAutomationState(state,lock,fd)).rejects.toThrow();expect((await import('node:fs')).existsSync(state)).toBe(true);await expect(releaseOwnedAutomationLock(state,lock,fd)).rejects.toThrow();}
 finally {await fd.close();}
});
it('managed cleanup clears only its own state and original lock inode', async()=>{
 const f=fixture(),state=join(f.dir,'state.json'),lock=join(f.dir,'owner.lock'),fd=await acquireAutomationDaemonLock(lock);
 writeFileSync(state,JSON.stringify({pid:process.pid}));await clearOwnedAutomationState(state,lock,fd);await releaseOwnedAutomationLock(state,lock,fd);
 expect((await import('node:fs')).existsSync(lock)).toBe(false);
});
it('managed cleanup rejects a replacement lock even when its PID matches', async()=>{
 const f=fixture(),state=join(f.dir,'state.json'),lock=join(f.dir,'owner.lock'),fd=await acquireAutomationDaemonLock(lock);
 try {(await import('node:fs')).renameSync(lock,lock+'.old');writeFileSync(lock,String(process.pid));writeFileSync(state,JSON.stringify({pid:process.pid}));await expect(clearOwnedAutomationState(state,lock,fd)).rejects.toThrow();expect((await import('node:fs')).existsSync(state)).toBe(true);}
 finally {await fd.close();}
});

describe('managed machine verification after local state creation', () => {
    async function startup() {
        const f = fixture(), statePath = join(f.dir, 'daemon.state.json'), lockPath = statePath + '.lock';
        const handle = await acquireAutomationDaemonLock(lockPath);
        writeFileSync(statePath, JSON.stringify({ pid: process.pid }));
        return { statePath, lockPath, handle,
            stopControl: vi.fn(async () => { expect(existsSync(statePath)).toBe(true); }),
            closeCredentials: vi.fn(async () => {}), stopCaffeinate: vi.fn(async () => {}), report: vi.fn() };
    }
    it('releases only this startup ownership after a failed read so the next supervised attempt can start', async () => {
        const f = await startup(), error = new Error('AUTOMATION_EXISTING_MACHINE_UNVERIFIED');
        await expect(verifyManagedStartupMachine(async () => { throw error; }, f)).rejects.toBe(error);
        expect(f.stopControl).toHaveBeenCalledOnce(); expect(f.closeCredentials).toHaveBeenCalledOnce();
        expect(f.stopCaffeinate).toHaveBeenCalledOnce();
        expect(existsSync(f.statePath)).toBe(false); expect(existsSync(f.lockPath)).toBe(false);
        await expect(assertNoAutomationDaemonState(f.statePath)).resolves.toBeUndefined();
        const retry = await acquireAutomationDaemonLock(f.lockPath);
        await releaseOwnedAutomationLock(f.statePath, f.lockPath, retry);
    });
    it('keeps live ownership after successful verification', async () => {
        const f = await startup(), machine = { id: 'fixture-machine' };
        try {
            await expect(verifyManagedStartupMachine(async () => machine, f)).resolves.toBe(machine);
            expect(f.stopControl).not.toHaveBeenCalled(); expect(f.closeCredentials).not.toHaveBeenCalled();
            expect(existsSync(f.statePath)).toBe(true); expect(existsSync(f.lockPath)).toBe(true);
        } finally { await f.handle.close(); }
    });
    it('retains another PID state and the owner lock when verification fails', async () => {
        const f = await startup();
        try {
            writeFileSync(f.statePath, JSON.stringify({ pid: process.pid + 1 }));
            await expect(verifyManagedStartupMachine(async () => { throw Error('fixture-read-failed'); }, f)).rejects.toThrow('fixture-read-failed');
            expect(JSON.parse(readFileSync(f.statePath, 'utf8')).pid).toBe(process.pid + 1);
            expect(existsSync(f.lockPath)).toBe(true);
            expect(f.report).toHaveBeenCalledWith('state-clear', 'unconfirmed');
        } finally { await f.handle.close(); }
    });
    it('does not unlink a replacement lock even when its PID matches', async () => {
        const f = await startup();
        try {
            renameSync(f.lockPath, f.lockPath + '.original'); writeFileSync(f.lockPath, String(process.pid));
            await expect(verifyManagedStartupMachine(async () => { throw Error('fixture-read-failed'); }, f)).rejects.toThrow('fixture-read-failed');
            expect(existsSync(f.statePath)).toBe(true); expect(existsSync(f.lockPath)).toBe(true);
            expect(f.report).toHaveBeenCalledWith('state-clear', 'unconfirmed');
        } finally { await f.handle.close(); }
    });
    it('keeps ownership if the local control listener cannot be confirmed closed', async () => {
        const f = await startup();
        try {
            f.stopControl.mockRejectedValueOnce(Error('fixture-close-failed'));
            await expect(verifyManagedStartupMachine(async () => { throw Error('fixture-read-failed'); }, f)).rejects.toThrow('fixture-read-failed');
            expect(existsSync(f.statePath)).toBe(true); expect(existsSync(f.lockPath)).toBe(true);
            expect(f.report).toHaveBeenCalledWith('control-close', 'unconfirmed');
        } finally { await f.handle.close(); }
    });
});
