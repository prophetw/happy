import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { createServer, request as proxyRequest } from 'node:http';
import { SignJWT, exportJWK } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EncryptedCredentialProvider } from './secrets';
import { hostConfigSchema, workerConfigSchema } from './config';
import { prepareHost } from './host';
import { mountHttpMcp } from './httpMcp';
import { oauthVerifier, type OAuthConfig } from './oauth';
import { ProofClient } from '../rest/client';
import { MetadataStore } from '../rest/store';
import { methods } from '../control';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'happy-production-fixture-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const principal = { issuer: 'https://issuer.fixture.invalid', subject: 'fixture-subject', tenant: 'fixture-tenant', oauthClientID: 'fixture-client' };
const oauth: OAuthConfig = { issuer: principal.issuer, resource: 'https://control.fixture.invalid/happy-control/mcp', jwksURL: principal.issuer + '/jwks', scope: 'happy:control', tenantClaim: 'tenant_id', algorithms: ['EdDSA'] };
async function tokens() {
    const keys = generateKeyPairSync('ed25519');
    const jwk = await exportJWK(keys.publicKey); jwk.kid = 'fixture'; jwk.alg = 'EdDSA';
    const mint = (claims: Record<string, unknown> = {}) => new SignJWT({ scope: 'happy:control', client_id: principal.oauthClientID, tenant_id: principal.tenant,
        iss: principal.issuer, aud: oauth.resource, sub: principal.subject, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+60, ...claims }).setProtectedHeader({ alg: 'EdDSA', kid: 'fixture' }).sign(keys.privateKey);
    return { verify: oauthVerifier(oauth, { keys: [jwk] }), mint };
}
async function rig() { const module = await import(resolve('examples/rest-fixture.ts')); const r = await module.fixtureRig({ externalIdentity: principal }); cleanup.push(() => r.close()); return r; }
async function mcp(r: any, grantID?: string, maxMethods = [...methods]) {
    const auth = await tokens(), app = Fastify({ logger: false }), scope = { workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: maxMethods, sessionIDs: [], expiresAt: Date.now()+120000 };
    // Fixture issuer uses HTTPS audience; listener itself is explicitly temporary loopback.
    mountHttpMcp(app, { resource: 'http://127.0.0.1/happy-control/mcp', issuer: oauth.issuer, oauthScope: oauth.scope, allowLoopback: true,
        verify: auth.verify, bindings: [{ principal, registration: r.clientRegistration, client: r.client, grantID, scope }] });
    const address = await app.listen({ port: 0, host: '127.0.0.1' }); cleanup.push(() => app.close());
    async function sdk(token: string) {
        const client = new Client({ name: 'isolated-http-fixture', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(address+'/happy-control/mcp'), { requestInit: { headers: { authorization: 'Bearer '+token } } }));
        cleanup.push(() => client.close()); return client;
    }
    return { ...auth, app, address, sdk };
}
function result(value: any) { return value.structuredContent ?? JSON.parse(value.content[0].text); }

describe('production configuration and safe secret provider', () => {
    it('rejects public listeners, unknown secret fields and unencrypted/default providers', () => {
        expect(() => hostConfigSchema.parse({ version: 1, role: 'host', listen: { host: '0.0.0.0', port: 9010 } })).toThrow();
        expect(() => workerConfigSchema.parse({ version: 1, role: 'worker', token: 'fixture-never-valid' })).toThrow();
    });
    it('loads only encrypted private PKCS8 via a private service credential and returns a signer; rotation/pin failures close access', async () => {
        const dir = temp(), creds = join(dir, 'credentials'); mkdirSync(creds, { mode: 0o700 });
        const keys = generateKeyPairSync('ed25519'), pass = Buffer.from('fixture-only-short-lived-passphrase');
        const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: pass });
        writeFileSync(join(dir,'key.pem'),pem,{mode:0o600}); writeFileSync(join(creds,'pass'),pass,{mode:0o400});
        const provider = new EncryptedCredentialProvider({ fixture: { encryptedPKCS8: join(dir,'key.pem'), passphraseCredential: 'pass' } },creds);
        const pub = keys.publicKey.export({type:'spki',format:'pem'}).toString();
        const signer = await provider.identity('fixture','assistant',pub);
        expect('privateKey' in signer).toBe(false); expect(JSON.stringify(signer)).not.toContain('PRIVATE');
        await expect(provider.identity('missing','assistant',pub)).rejects.toThrow('SECRET_PROVIDER_UNAVAILABLE');
        const other = generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
        await expect(provider.identity('fixture','assistant',other)).rejects.toThrow('SECRET_PROVIDER_UNAVAILABLE');
        writeFileSync(join(dir,'plain.pem'), keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
        const plain = new EncryptedCredentialProvider({fixture:{encryptedPKCS8:join(dir,'plain.pem'),passphraseCredential:'pass'}},creds);
        await expect(plain.identity('fixture','assistant',pub)).rejects.toThrow('SECRET_PROVIDER_UNAVAILABLE');
        await provider.close(); if ('sign' in signer) await expect(signer.sign(Buffer.from('test'))).rejects.toThrow('SECRET_PROVIDER_CLOSED'); pass.fill(0);
    });
    it('rejects permissive, symlinked or hardlinked encrypted material and credential files', async () => {
        const dir=temp(), creds=join(dir,'credentials');mkdirSync(creds,{mode:0o700});
        const keys=generateKeyPairSync('ed25519'), path=join(dir,'encrypted.pem'), pass=join(creds,'pass');
        writeFileSync(path,keys.privateKey.export({type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase:'fixture-only'}),{mode:0o600});
        writeFileSync(pass,'fixture-only',{mode:0o400});const pub=keys.publicKey.export({type:'spki',format:'pem'}).toString();
        const load=(keyPath=path)=>new EncryptedCredentialProvider({fixture:{encryptedPKCS8:keyPath,passphraseCredential:'pass'}},creds).identity('fixture','worker',pub);
        chmodSync(pass,0o644);await expect(load()).rejects.toThrow('SECRET_PROVIDER_UNAVAILABLE');chmodSync(pass,0o400);
        chmodSync(path,0o644);await expect(load()).rejects.toThrow('SECRET_PROVIDER_UNAVAILABLE');chmodSync(path,0o600);
        const alias=join(dir,'alias.pem');symlinkSync(path,alias);await expect(load(alias)).rejects.toThrow('SECRET_PROVIDER_UNAVAILABLE');
        linkSync(path,join(dir,'hardlink.pem'));await expect(load()).rejects.toThrow('SECRET_PROVIDER_UNAVAILABLE');
    });
    it('denies unsafe/symlinked metadata and startup failures never listen or create grants', async () => {
        const dir=temp(), unsafe=join(dir,'unsafe');mkdirSync(unsafe,{mode:0o755});
        expect(()=>new MetadataStore(unsafe)).toThrow('UNSAFE_PRIVATE_DIRECTORY');
        symlinkSync(unsafe,join(dir,'alias'));expect(()=>new MetadataStore(join(dir,'alias'))).toThrow();
        const closed=vi.fn(async()=>{});
        await expect(prepareHost({ version:1,role:'host',listen:{host:'127.0.0.1',port:9010},origin:'https://fixture.invalid',relayURL:'https://fixture.invalid/home-relay',stateDirectory:unsafe,clients:[],workers:[],maxGrantMs:60000,ipRateLimit:12000 },()=>{}, {identity:vi.fn(),close:closed})).rejects.toThrow('CONTROL_STARTUP_REJECTED');
        expect(closed).toHaveBeenCalled();
    });
    it('reports ready before grant bootstrap, but fails closed after state directory loss/audit failure', async () => {
        const r=await rig();expect((await r.gateway.app.inject('/readyz')).statusCode).toBe(200);
        const grant=await r.connect(); expect(grant).toBeTruthy();
        r.gatewayOptions.audit=()=>{throw new Error('fixture sink failure');};
        expect((await r.gateway.app.inject('/livez')).statusCode).toBe(200);
        expect((await r.gateway.app.inject('/readyz')).statusCode).toBe(503);
        rmSync(join(r.dir,'gateway/state'),{recursive:true});expect((await r.gateway.app.inject('/readyz')).statusCode).toBe(503);
    });
});

describe('OAuth resource adaptation without Happy account delegation', () => {
    it('validates issuer, audience, expiry, scope, client and tenant without leaking token errors', async () => {
        const a=await tokens();expect(await a.verify(await a.mint())).toEqual(principal);
        for (const c of [{iss:'https://evil.invalid'},{aud:'https://other.invalid'},{exp:1},{scope:'unrelated'},{tenant_id:null},{client_id:null},{azp:'other'},{exp:Math.floor(Date.now()/1000)+3600}]) {
            await expect(a.verify(await a.mint(c))).rejects.toThrow('OAUTH_INVALID_TOKEN');
        }
        expect(()=>oauthVerifier({...oauth,jwksURL:'https://evil.invalid/jwks'})).toThrow('INVALID_OAUTH_CONFIG');
    });
    it('rejects cross subject/tenant/client identities before any Happy operation; publishes protected resource discovery', async () => {
        const r=await rig(),g=await r.connect(),m=await mcp(r,g);
        const meta=await m.app.inject('/.well-known/oauth-protected-resource/happy-control/mcp');expect(meta.json().authorization_servers).toEqual([oauth.issuer]);
        for (const c of [{sub:'other-user'},{tenant_id:'other-tenant'},{client_id:'other-client'}]) {
            const response=await m.app.inject({method:'POST',url:'/happy-control/mcp',headers:{authorization:'Bearer '+await m.mint(c)},payload:{}});
            expect(response.statusCode).toBe(403);
        }
        const noauth=await m.app.inject({method:'POST',url:'/happy-control/mcp',headers:{cookie:'fixture-browser-cookie'},payload:{}});
        expect(noauth.statusCode).toBe(401);expect(noauth.headers['www-authenticate']).toContain('resource_metadata=');expect(r.spawnCount).toBe(0);
    });
    it('executes real SDK HTTP MCP → signed REST → outbound worker → durable daemon receipts with concurrent idempotency/log/cancel evidence', async () => {
        const r=await rig(),g=await r.connect(),m=await mcp(r,g); await r.startWorker();
        const client=await m.sdk(await m.mint());expect((await client.listTools()).tools.map(t=>t.name)).toContain('happy_cancel');
        const args={requestID:'concurrent-create',machineID:'machineA',projectID:'projectA'};
        const calls=await Promise.all([client.callTool({name:'happy_create_task',arguments:args}),client.callTool({name:'happy_create_task',arguments:args})]);
        expect(r.spawnCount).toBe(1);const created=result(calls[0]);expect(created.ok).toBe(true);const sessionID=created.data.sessionID;
        const sent=result(await client.callTool({name:'happy_send',arguments:{sessionID,requestID:'send-one',text:'fixture-only instruction'}}));expect(sent.data.state).toBe('submitted');
        r.complete(sessionID,'fixture-turn','completed','Bearer fixture-private-value');
        const logs=result(await client.callTool({name:'happy_events',arguments:{sessionID,after_seq:1,limit:2}}));expect(logs.data.nextCursor).toBe(3);expect(logs.data.hasMore).toBe(true);
        const completed=result(await client.callTool({name:'happy_result',arguments:{sessionID,turnID:'fixture-turn',after_seq:0}}));expect(completed.data.outcome).toBe('completed');expect(JSON.stringify(completed)).not.toContain('fixture-private-value');
        const cancel=result(await client.callTool({name:'happy_cancel',arguments:{sessionID,requestID:'cancel-one'}}));expect(cancel.data.state).toBe('cancel_requested');expect(cancel.data.process).toBe('unknown');
        const status=result(await client.callTool({name:'happy_request_status',arguments:{requestID:'concurrent-create'}}));expect(status.data.sessionID).toBe(sessionID);
        for(const foreign of [{machineID:'other-machine'},{projectID:'other-project'}])expect(result(await client.callTool({name:'happy_create_task',arguments:{...args,requestID:'denied',...foreign}})).error.code).toBe('SCOPE_DENIED');
    });
    it('denies scope widening and revocation during in-flight execution; reconnect never restores revoked access', async () => {
        const r=await rig(),g=await r.connect(),m=await mcp(r,g); await r.startWorker(); const client=await m.sdk(await m.mint());
        const release=r.pauseSpawn();const call=client.callTool({name:'happy_create_task',arguments:{requestID:'revoke-pending',machineID:'machineA',projectID:'projectA'}});
        await vi.waitFor(()=>expect(r.spawnCount).toBe(1));await r.ownerRequest(`/connections/${g}`,'DELETE');release();expect(result(await call).ok).toBe(false);
        await r.stopWorker();await r.startWorker(); const another=await m.sdk(await m.mint());
        expect(result(await another.callTool({name:'happy_machines',arguments:{}})).error.code).toBe('GRANT_UNAVAILABLE');
        const wide=result(await another.callTool({name:'happy_request_connection',arguments:{workerID:'worker',machineID:'machineA',projectID:'other-project',methods:['machines.list'],sessionIDs:[],expiresAt:Date.now()+60000}}));expect(wide.isError??wide.ok).not.toBe(true);
    });
    it('binds new connection approval to external identity and invalidates previously approved grants on mapping changes', async () => {
        const r=await rig(),g=await r.connect();const consent=await r.ownerRequest(`/connections/${g}/consent`);expect(consent.body.data.externalIdentity).toEqual(principal);
        r.gatewayOptions.clients[0].externalIdentity={...principal,tenant:'other-tenant'};
        expect((await r.client.request('GET','/machines',undefined,g)).error.code).toBe('CLIENT_IDENTITY_CHANGED');
    });
});

describe('proxy and payload contracts', () => {
    it('preserves complete signed path/query through a real loopback proxy and rejects path rewriting', async () => {
        const r=await rig(),g=await r.connect();await r.startWorker();let rewrite=false;
        const proxy=createServer((req,res)=>{const upstream=proxyRequest(r.address+(rewrite?req.url!.replace('?limit=1','?limit=2'):req.url!),{method:req.method,headers:req.headers},incoming=>{res.writeHead(incoming.statusCode!,incoming.headers);incoming.pipe(res);});req.pipe(upstream);upstream.on('error',()=>{res.statusCode=502;res.end();});});
        await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));cleanup.push(()=>new Promise<void>(resolve=>proxy.close(()=>resolve())));
        const port=(proxy.address() as {port:number}).port,c=new ProofClient(`http://127.0.0.1:${port}/happy-control/v1`,r.clientIdentity,'client',{allowLoopback:true});
        expect((await c.request('GET','/machines?limit=1',undefined,g)).ok).toBe(true);rewrite=true;expect((await c.request('GET','/machines?limit=1',undefined,g)).error.code).toBe('INVALID_PROOF');
    });
    it('returns bounded large log pages without silently losing cursor or ciphertext', async () => {
        const r=await rig(),g=await r.connect();await r.startWorker();const created=await r.client.request('POST','/tasks',{requestID:'large',machineID:'machineA',projectID:'projectA'},g),id=created.data.sessionID;
        for(let n=0;n<24;n++)r.complete(id,`turn_${n}`,'completed','汉'.repeat(16000));
        const result=await r.client.request('GET',`/sessions/${id}/events?after_seq=0&limit=100`,undefined,g);
        expect(result.ok).toBe(true);expect(result.data.messages).toHaveLength(72);expect(result.data.nextCursor).toBe(72);expect(JSON.stringify(result)).not.toMatch(/dataEncryptionKey|encryptionKey|ciphertext/);
    });
});
