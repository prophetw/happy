import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existingAutomationAuth, bundleReplacementAction, assertNoAutomationDaemonState, acquireAutomationDaemonLock, clearOwnedAutomationState, releaseOwnedAutomationLock } from './automationBootstrap';
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
