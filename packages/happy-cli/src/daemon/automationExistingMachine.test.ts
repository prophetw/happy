import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),decrypt:vi.fn()}));
vi.mock('axios',()=>({default:{get:mocks.get,post:mocks.post}}));
vi.mock('@/ui/logger',()=>({logger:{debug:vi.fn()}}));
vi.mock('@/configuration',()=>({configuration:{serverUrl:'https://relay.fixture.invalid',currentCliVersion:'fixture'}}));
vi.mock('@/utils/serverConnectionErrors',()=>({connectionState:{},isNetworkError:()=>false}));
vi.mock('../api/apiSession',()=>({ApiSessionClient:class{}}));
vi.mock('../api/apiMachine',()=>({ApiMachineClient:class{}}));
vi.mock('../api/pushNotifications',()=>({PushNotificationClient:class{}}));
vi.mock('../api/encryption',()=>({decodeBase64:(s:string)=>s,decrypt:mocks.decrypt}));
import { ApiClient } from '../api/api';
const credentials={token:'fixture-only-bearer',encryption:{type:'dataKey' as const,publicKey:new Uint8Array(32),machineKey:new Uint8Array(32)}};
beforeEach(()=>{vi.resetAllMocks();mocks.decrypt.mockReturnValue({host:'fixture-machine'});});
describe('existing machine production GET-only preflight',()=>{
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
