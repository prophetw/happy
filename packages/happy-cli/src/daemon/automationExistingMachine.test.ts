import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),decrypt:vi.fn(),pause:vi.fn()}));
vi.mock('axios',()=>({default:{get:mocks.get,post:mocks.post,isAxiosError:(e:any)=>e?.isAxiosError===true}}));
vi.mock('node:timers/promises',async (original)=>({...await original<typeof import('node:timers/promises')>(),setTimeout:mocks.pause}));
vi.mock('@/ui/logger',()=>({logger:{debug:vi.fn()}}));
vi.mock('@/configuration',()=>({configuration:{serverUrl:'https://relay.fixture.invalid',currentCliVersion:'fixture'}}));
vi.mock('../api/apiSession',()=>({ApiSessionClient:class{}}));
vi.mock('../api/apiMachine',()=>({ApiMachineClient:class{}}));
vi.mock('../api/pushNotifications',()=>({PushNotificationClient:class{}}));
vi.mock('../api/encryption',()=>({decodeBase64:(s:string)=>s,decrypt:mocks.decrypt}));
import { ApiClient } from '../api/api';
import { verifyAutomationWorkerOwner } from '../api/automationIdentity';
const credentials={token:'fixture-only-bearer',encryption:{type:'dataKey' as const,publicKey:new Uint8Array(32),machineKey:new Uint8Array(32)}};
beforeEach(()=>{vi.resetAllMocks();mocks.decrypt.mockReturnValue({host:'fixture-machine'});});
describe('existing machine production GET-only preflight',()=>{
    it('waits through a cold relay and verifies the same machine before returning', async () => {
        const api = await ApiClient.create(credentials);
        const { signal } = new AbortController();
        mocks.get.mockRejectedValueOnce({ isAxiosError: true, code: 'ECONNRESET' })
            .mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 } })
            .mockResolvedValueOnce({data:[{id:'m',dataEncryptionKey:'fixture',metadata:'fixture'}]});
        expect(await api.getExistingAutomationMachine('m', signal)).toMatchObject({id:'m'});
        expect(mocks.pause).toHaveBeenCalledTimes(2);
        for (const [url, options] of mocks.get.mock.calls) {
            expect(url).toBe('https://relay.fixture.invalid/v1/machines');
            expect(options).toMatchObject({signal,maxRedirects:0,headers:{Authorization:'Bearer fixture-only-bearer'}});
        }
        expect(mocks.post).not.toHaveBeenCalled();
    });
    it('keeps checking the original account through a temporary failure and refuses a different owner or denial', async () => {
        const { signal } = new AbortController();
        const verify = () => verifyAutomationWorkerOwner('https://relay.fixture.invalid', credentials.token, 'owner', signal);
        mocks.get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 } }).mockResolvedValueOnce({ data: { id: 'owner' } });
        await expect(verify()).resolves.toBeUndefined();
        mocks.get.mockResolvedValueOnce({ data: { id: 'other' } }).mockRejectedValueOnce({ isAxiosError: true, response: { status: 403 } });
        await expect(verify()).rejects.toThrow('AUTOMATION_WORKER_OWNER_UNVERIFIED');
        await expect(verify()).rejects.toThrow('AUTOMATION_WORKER_OWNER_UNVERIFIED');
        expect(mocks.pause).toHaveBeenCalledTimes(1);
        for (const [url, options] of mocks.get.mock.calls) {
            expect(url).toBe('https://relay.fixture.invalid/v1/account/profile');
            expect(options).toMatchObject({ signal, maxRedirects: 0, headers: { Authorization: 'Bearer fixture-only-bearer' } });
        }
        expect(mocks.post).not.toHaveBeenCalled();
    });
    it('stops waiting on shutdown and fails closed on denial or TLS trust failure', async () => {
        const api = await ApiClient.create(credentials);
        const ctl = new AbortController();
        for (const error of [{response:{status:403}}, {code:'CERT_HAS_EXPIRED'}]) {
            mocks.get.mockRejectedValueOnce({isAxiosError:true,...error});
            await expect(api.getExistingAutomationMachine('m',ctl.signal)).rejects.toThrow('AUTOMATION_EXISTING_MACHINE_UNVERIFIED');
        }
        expect(mocks.pause).not.toHaveBeenCalled();
        mocks.get.mockRejectedValueOnce({isAxiosError:true,code:'ECONNREFUSED'});
        mocks.pause.mockImplementationOnce(async () => { ctl.abort(); throw Error('aborted'); });
        await expect(api.getExistingAutomationMachine('m',ctl.signal)).rejects.toThrow('AUTOMATION_EXISTING_MACHINE_UNVERIFIED');
        expect(ctl.signal.aborted).toBe(true);
        expect(mocks.get).toHaveBeenCalledTimes(3);
        expect(mocks.post).not.toHaveBeenCalled();
    });
    it('loads only an existing decryptable machine; no register POST/offline fallback',async()=>{
        const api=await ApiClient.create(credentials);mocks.get.mockResolvedValue({data:[{id:'m',dataEncryptionKey:'fixture-cipher',metadata:'fixture-encrypted-metadata'}]});
        expect(await api.getExistingAutomationMachine('m')).toMatchObject({id:'m',encryptionVariant:'dataKey'});
        expect(mocks.get).toHaveBeenCalledWith('https://relay.fixture.invalid/v1/machines',expect.objectContaining({maxRedirects:0,timeout:10000}));expect(mocks.post).not.toHaveBeenCalled();
    });
    it('denies absent machines, missing E2EE, bad data and network failure without exposing bearer',async()=>{
        const api=await ApiClient.create(credentials);
        for(const data of [[],[{id:'m',metadata:'fixture'}],[{id:'m',dataEncryptionKey:'fixture'}],{machines:[]}]) {
            mocks.get.mockResolvedValueOnce({data});await expect(api.getExistingAutomationMachine('m')).rejects.toThrow('AUTOMATION_EXISTING_MACHINE_UNVERIFIED');
        }
        mocks.get.mockRejectedValueOnce(new Error('fixture-only-bearer'));await expect(api.getExistingAutomationMachine('m')).rejects.toThrow('AUTOMATION_EXISTING_MACHINE_UNVERIFIED');expect(mocks.post).not.toHaveBeenCalled();
    });
});
