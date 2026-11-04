import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGateway } from '../src/automation/rest/gateway';
import { ProofClient } from '../src/automation/rest/client';
import { HTTPWorkerRunner } from '../src/automation/rest/worker';
import { methods } from '../src/automation/control';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '../src/encryption';
import { createAutomationControl } from '../../happy-cli/src/daemon/automationControl';
import type { LaunchOptionsPolicy, OptionCatalogEntry } from '../src/automation/rest/options';

/** Synthetic keys-only catalog; no real Codex/Claude installation is consulted. */
const fixtureCatalog: OptionCatalogEntry[] = [
    { agent: 'codex', models: ['gpt-6.1-sol', 'gpt-6-sol'], permissionModes: ['default', 'auto', 'safe-yolo', 'read-only', 'yolo'],
        efforts: ['low', 'medium', 'high'], defaultModel: 'gpt-6.1-sol', defaultPermissionMode: 'default', defaultEffort: 'high' },
    { agent: 'claude', models: ['default', 'claude-opus-5'], permissionModes: ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'],
        efforts: ['low', 'medium', 'high'], defaultModel: 'default', defaultPermissionMode: 'default', defaultEffort: '' },
];
import type { Transport } from '../src/automation/relay';
import type { DecryptedSession, DecryptedMachine } from '../src/api';

/** Isolated real loopback HTTP + real receipts + synthetic encrypted relay. Never reads Happy home. */
export async function fixtureRig(options: { timeoutMs?: number; clock?: () => number; externalIdentity?: import('../src/automation/rest/schema').ExternalIdentity;
    origin?: string; workerIntervalMs?: number; multipleProjects?: boolean; directorySelection?: boolean; serviceTokens?: import('../src/automation/rest/schema').ServiceTokensConfig;
    launchOptions?: LaunchOptionsPolicy } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'happy-rest-fixture-')), project = join(dir, 'project'); mkdirSync(project);
    const projectB = join(dir, 'project-b'), projectC = join(dir, 'project-c'); mkdirSync(projectB); mkdirSync(projectC);
    const now = options.clock ?? Date.now;
    const identity = (id: string) => { const pair = generateKeyPairSync('ed25519'); return { id, privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }; };
    const clientIdentity = identity('assistant'), workerIdentity = identity('worker'), otherIdentity = identity('other');
    const clientRegistration = { id: clientIdentity.id, userID: 'userA', name: 'Fixture assistant', publicKey: clientIdentity.publicKey, ...(options.externalIdentity ? { externalIdentity: options.externalIdentity } : {}) };
    const registration = { id: workerIdentity.id, userID: 'userA', name: 'Fixture worker', publicKey: workerIdentity.publicKey, machineID: 'machineA',
        projects: [{ id: 'projectA', directory: project, sessionIDs: ['existing'] }, ...(options.multipleProjects ? [
            { id: 'projectB', directory: projectB, sessionIDs: ['existingB'] }, { id: 'projectC', directory: projectC, sessionIDs: ['existingC'] },
        ] : [])], ...(options.directorySelection ? { directorySelection: { roots: [dir] } } : {}), methods: [...methods], protocol: 1 as const,
        ...(options.launchOptions ? { launchOptions: options.launchOptions } : {}) };
    const audit: unknown[] = [];
    const gatewayOptions = { directory: join(dir, 'gateway'), origin: options.origin ?? 'http://127.0.0.1', clients: [clientRegistration,
        { id: otherIdentity.id, userID: 'userB', name: 'Other user', publicKey: otherIdentity.publicKey }], workers: [registration],
        now, timeoutMs: options.timeoutMs ?? 5000, serviceTokens: options.serviceTokens, audit: (e: unknown) => { audit.push(e); },
        verifyOwner: async (authorization: string | undefined) => {
            if (authorization === 'Bearer fixture-owner-A') return 'userA';
            if (authorization === 'Bearer fixture-owner-B') return 'userB';
            throw new Error('owner rejected');
        } };
    let gateway = createGateway(gatewayOptions);
    let address = await gateway.app.listen({ port: 0, host: '127.0.0.1' });
    const makeClient = (id: typeof clientIdentity, kind: 'client' | 'worker' = 'client') => new ProofClient(`${address}/happy-control/v1`, id, kind, { allowLoopback: true, now, timeoutMs: 10000 });
    let client = makeClient(clientIdentity), workerClient = makeClient(workerIdentity, 'worker');
    const key = new Uint8Array(32).fill(31), encryption = { key, variant: 'dataKey' as const };
    const machine = { id: 'machineA', encryption, active: true, activeAt: now(), metadata: {} } as DecryptedMachine;
    const sessions: DecryptedSession[] = [];
    const ciphertext = new Map<string, { id: string; seq: number; localId: string | null; c: string }[]>();
    let spawnCount = 0, sendCount = 0, processState = 'running', spawnDelay = 0, loseAck = false;
    const launches: { directory: string; options: unknown }[] = [];
    let spawnBarrier: Promise<void> | undefined, releaseSpawn: (() => void) | undefined;
    function addSession(id: string, directory = project, flavor = 'codex') {
        const s = { id, metadata: { machineId: 'machineA', path: directory, flavor }, agentState: {}, encryption, active: true } as DecryptedSession;
        sessions.push(s); ciphertext.set(id, []); return s;
    }
    addSession('existing'); addSession('foreign', join(dir, 'different-project'));
    if (options.multipleProjects) { addSession('existingB', projectB); addSession('existingC', projectC); }
    function append(sessionID: string, content: unknown, localId: string | null = null) {
        const list = ciphertext.get(sessionID)!;
        const m = { id: `message_${list.length+1}`, seq: list.length+1, localId, c: encodeBase64(encrypt(key, 'dataKey', content)) }; list.push(m); return m;
    }
    const control = createAutomationControl({ directory: join(dir, 'daemon'),
        spawn: async (directory, launch) => { launches.push({ directory, options: launch }); const number = ++spawnCount; if (spawnBarrier) await spawnBarrier; if (spawnDelay) await new Promise(r => setTimeout(r, spawnDelay)); return { type: 'success', sessionId: addSession(`session_${number}`, directory, launch.agent).id }; },
        options: () => ({ defaultAgent: 'codex', catalog: fixtureCatalog, policy: options.launchOptions }),
        stop: () => { processState = 'unknown'; return true; }, observe: () => processState as 'running' | 'stopping' | 'stopped' | 'unknown' });
    const transport: Transport = {
        machines: async () => [machine], sessions: async () => ({ sessions, nextCursor: null }),
        rpc: async (_machine, command) => await control(command) as Record<string, unknown>,
        messages: async (s, after, limit) => { const all = ciphertext.get(s.id)!.filter(m => m.seq > after); return { hasMore: all.length > limit,
            messages: all.slice(0,limit).map(m => ({ id: m.id, seq: m.seq, localId: m.localId, content: decrypt(key, 'dataKey', decodeBase64(m.c)) })) }; },
        send: async (s, requestID, text) => {
            const previous = ciphertext.get(s.id)!.find(m => m.localId === `automation:${requestID}`);
            const message = previous ?? append(s.id, { role: 'user', content: { type: 'text', text } }, `automation:${requestID}`);
            if (!previous) sendCount++;
            if (loseAck) { loseAck = false; throw new Error('fixture relay ack lost'); }
            return { id: message.id, seq: message.seq };
        },
    };
    let abort: AbortController | undefined, running: Promise<void> | undefined;
    const statuses: unknown[] = [];
    async function startWorker() {
        abort = new AbortController();
        const runner = new HTTPWorkerRunner(workerClient, registration, transport, join(dir, 'worker'), now);
        await runner.pollOnce(); running = runner.run(abort.signal, options.workerIntervalMs ?? 2, s => { statuses.push(s); });
    }
    async function stopWorker() { abort?.abort(); await running; abort = undefined; running = undefined; }
    async function ownerRequest(route: string, method = 'GET', body?: unknown, user = 'A') {
        const response = await gateway.app.inject({ method: method as any, url: `/happy-control/v1${route}`, headers: {
            origin: gatewayOptions.origin, authorization: `Bearer fixture-owner-${user}`,
        }, ...(body === undefined ? {} : { payload: body }) }); return { status: response.statusCode, body: response.json() };
    }
    async function connect(scope: Partial<{ methods: typeof methods[number][]; expiresAt: number; sessionIDs: string[]; options: import('../src/automation/rest/options').ConnectionOptions }> = {}) {
        const pending = await client.request('POST', '/connections', { workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: [...methods], sessionIDs: [], expiresAt: now()+60000, ...scope });
        if (!pending.ok) throw new Error(`fixture setup: ${pending.error.code}`);
        const consent = await ownerRequest(`/connections/${pending.data.id}/consent`);
        const approved = await ownerRequest(`/connections/${pending.data.id}/approve`, 'POST', { digest: consent.body.data.digest, challenge: consent.body.data.challenge });
        if (!approved.body.ok) throw new Error('fixture approval failed'); return pending.data.id as string;
    }
    return {
        dir, project, projectB, projectC, registration, gatewayOptions, clientIdentity, workerIdentity, otherIdentity, clientRegistration, transport, ciphertext, audit, statuses, addSession,
        get gateway() { return gateway; }, get client() { return client; }, get workerClient() { return workerClient; }, get address() { return address; },
        get spawnCount() { return spawnCount; }, get sendCount() { return sendCount; }, get launches() { return launches; },
        pauseSpawn() { spawnBarrier = new Promise<void>(resolve => { releaseSpawn = resolve; }); return () => { releaseSpawn?.(); spawnBarrier = undefined; }; },
        delaySpawn(ms: number) { spawnDelay = ms; }, loseSendAck() { loseAck = true; }, setProcess(state: string) { processState = state; },
        complete(sessionID: string, turnID = 'turn1', outcome = 'completed', text = 'fixture result') {
            append(sessionID, { role: 'session', content: { role: 'agent', turn: turnID, ev: { t: 'turn-start' } } });
            append(sessionID, { role: 'session', content: { role: 'agent', turn: turnID, ev: { t: 'text', text } } });
            append(sessionID, { role: 'session', content: { role: 'agent', turn: turnID, ev: { t: 'turn-end', status: outcome } } });
        },
        startWorker, stopWorker, connect, ownerRequest,
        async restartGateway() { await stopWorker(); await gateway.app.close(); gateway = createGateway(gatewayOptions); address = await gateway.app.listen({ port: 0, host: '127.0.0.1' }); client = makeClient(clientIdentity); workerClient = makeClient(workerIdentity, 'worker'); },
        async close() { releaseSpawn?.(); await stopWorker(); await gateway.app.close(); rmSync(dir, { recursive: true, force: true }); },
    };
}

async function main() {
    const rig = await fixtureRig();
    try {
        const grant = await rig.connect(); await rig.startWorker();
        const created = await rig.client.request('POST', '/tasks', { requestID: 'fixture_create', machineID: 'machineA', projectID: 'projectA' }, grant);
        if (!created.ok) throw new Error(`create: ${created.error?.code}`);
        const sessionID = created.data.sessionID;
        const sent = await rig.client.request('POST', `/sessions/${sessionID}/messages`, { requestID: 'fixture_send', text: 'Synthetic fixture instruction' }, grant);
        rig.complete(sessionID);
        const result = await rig.client.request('GET', `/sessions/${sessionID}/result?turnID=turn1`, undefined, grant);
        const cancelled = await rig.client.request('POST', `/sessions/${sessionID}/cancel`, { requestID: 'fixture_cancel' }, grant);
        const revoked = await rig.ownerRequest(`/connections/${grant}`, 'DELETE');
        process.stdout.write(JSON.stringify({ fixture: true, created: created.ok, sent: sent.data?.state, result: result.data?.outcome, cancel: cancelled.data?.state,
            process: cancelled.data?.process, revoked: revoked.body.data?.state, realAuth: false })+'\n');
    } finally { await rig.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`Fixture failed: ${error instanceof Error ? error.message : 'unknown'}\n`); process.exitCode = 1; });
