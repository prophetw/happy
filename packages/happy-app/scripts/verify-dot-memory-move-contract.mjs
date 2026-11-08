import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Explicit checkout only: this harness never discovers the running assistant or its data.
const testloop = process.env.TESTLOOP_MEMORY_MOVE_REPO;
if (!testloop) throw Error('Set TESTLOOP_MEMORY_MOVE_REPO to the isolated testLoop checkout with compiled dist.');
const repo = resolve(testloop), app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = relative => import(pathToFileURL(join(repo, relative)).href);

test('actual native memory client and encrypted workspace RPC share one contract', async t => {
    // Only the native transport/storage adapters are replaced. Both business implementations are real.
    const compiled = await build({
        entryPoints: [join(app, 'sources/sync/dotMemoryMove.ts')], bundle: true,
        platform: 'node', format: 'esm', write: false, logLevel: 'silent',
        plugins: [{ name: 'isolated-native-adapters', setup(bundler) {
            bundler.onResolve({ filter: /^react-native-mmkv$|^\.\/apiSocket$/ }, args => ({ path: args.path, namespace: 'fixture' }));
            bundler.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
                contents: args.path === './apiSocket'
                    ? 'export const apiSocket = { sessionRPC: (...args) => globalThis.__memoryMoveContractTransport(...args) };'
                    : 'export class MMKV { data = new Map(); getString(key) { return this.data.get(key); } set(key, value) { this.data.set(key, value); } }',
                loader: 'js',
            }));
        } }],
    });
    const bundleDirectory = mkdtempSync(join(tmpdir(), 'memory-move-client-contract-'));
    t.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
    const bundle = join(bundleDirectory, 'client.mjs');
    writeFileSync(bundle, compiled.outputFiles[0].text, { mode: 0o600 });
    const client = await import(pathToFileURL(bundle).href);
    const [{ memoryScopesEnvironment }, { attachDotsWorkspaceRPC }, codec, { digest }, { dotMemoryMoveRPC }] = await Promise.all([
        backend('test/fixtures/memory-scopes.mjs'), backend('dist/assistant-workspace-rpc.js'),
        backend('dist/happy-message-codec.js'), backend('dist/identity.js'), backend('dist/assistant-memory-move.js'),
    ]);
    const environment = await memoryScopesEnvironment(t), fixture = await environment.make();
    const sessionId = fixture.state().dots.workspace.sessionId;
    const sessions = JSON.parse(readFileSync(join(fixture.home, 'sessions.json'), 'utf8'));
    const key = Buffer.from(sessions.sessions[sessionId].encryptionKey, 'base64');
    let handler, current = true;
    const methods = [], wire = [];
    const socket = {
        on(name, callback) { assert.equal(name, 'rpc-request'); handler = callback; },
        emit(name, value) { if (name === 'rpc-register') methods.push(value.method); },
    };
    attachDotsWorkspaceRPC(socket, fixture.root, sessionId, key, () => current)();
    assert(methods.includes(`${sessionId}:testloop-dot-memory-move`));
    globalThis.__memoryMoveContractTransport = async (session, method, payload) => {
        assert.equal(session, sessionId); assert.equal(method, 'testloop-dot-memory-move');
        let ciphertext;
        await handler({ method: `${session}:${method}`, params: codec.encryptHappyMessage(payload, key) }, reply => { ciphertext = reply; });
        assert.equal(typeof ciphertext, 'string'); wire.push(payload);
        return codec.decryptHappyMessage(ciphertext, key);
    };
    t.after(() => { delete globalThis.__memoryMoveContractTransport; });
    const remember = async (keyName, scope = 'dot', value = { language: '中文' }) => fixture.invoke('dot_memory_write', {
        requestID: randomUUID(), scope, operation: { action: 'remember', key: keyName, value, kind: 'preference', revision: 0,
            expiresAt: new Date(Date.now() + 3600000).toISOString() },
    });
    const intent = (keyName, sourceScope = 'dot', sourceRevision = 1) => ({ requestID: randomUUID(), dotId: fixture.dot.id,
        keyDigest: digest(keyName), sourceScope, sourceRevision });
    const prepare = async input => ({ ...input, targetRevision: (await client.requestDotMemoryMove(sessionId, 'prepare', input)).targetExpectedRevision });

    await t.test('one native request moves both directions and preserves content and absolute expiry', async () => {
        await remember('round-trip');
        const source = (await fixture.invoke('dot_memory_read', { key: 'round-trip' })).memory;
        const first = await prepare(intent('round-trip'));
        const moved = await client.requestDotMemoryMove(sessionId, 'move', first);
        assert.equal(moved.status, 'completed_locally'); assert.equal(moved.targetRevision, 1);
        const saved = (await fixture.invoke('dot_memory_read', { scope: 'user', key: 'round-trip' })).memory;
        for (const field of ['key', 'kind', 'value', 'expiresAt']) assert.deepEqual(saved[field], source[field]);
        assert.equal((await fixture.invoke('dot_memory_read', { key: 'round-trip' })).memory, null);
        const reversed = await prepare(intent('round-trip', 'user'));
        assert.equal(reversed.targetRevision, 2);
        assert.equal((await client.requestDotMemoryMove(sessionId, 'move', reversed)).targetRevision, 3);
        assert.equal((await fixture.invoke('dot_memory_read', { key: 'round-trip' })).memory.expiresAt, source.expiresAt);
        assert.equal((await fixture.invoke('dot_memory_read', { key: 'round-trip' }, fixture.other)).memory, null);
        const historical = await client.requestDotMemoryMove(sessionId, 'status', first);
        assert.equal(historical.status, 'completed_locally'); assert.equal(historical.indexing, 'superseded');
    });
    await t.test('an encrypted conflict becomes the native error without overwriting either layer', async () => {
        await remember('conflict'); await remember('conflict', 'user', 'existing');
        await assert.rejects(client.requestDotMemoryMove(sessionId, 'prepare', intent('conflict')), /memory_move_target_conflict/);
        assert.equal((await fixture.invoke('dot_memory_read', { key: 'conflict' })).memory.value.language, '中文');
        assert.equal((await fixture.invoke('dot_memory_read', { scope: 'user', key: 'conflict' })).memory.value, 'existing');
    });
    await t.test('an interrupted target save is discovered and resumes using the original request and CAS', async () => {
        await remember('interrupted');
        const original = await prepare(intent('interrupted'));
        const interrupted = await dotMemoryMoveRPC(fixture.root, sessionId, { schemaVersion: 1, action: 'move', ...original }, stage => {
            if (stage === 'target_saved') throw Error('fixture-interruption');
        });
        assert.equal(interrupted.ok, false);
        const discovered = await client.requestDotMemoryMove(sessionId, 'prepare', intent('interrupted'));
        assert.equal(discovered.requestID, original.requestID); assert.equal(discovered.status, 'target_saved');
        assert.equal(discovered.targetExpectedRevision, original.targetRevision);
        assert.equal((await client.requestDotMemoryMove(sessionId, 'status', original)).status, 'target_saved');
        assert.equal((await client.requestDotMemoryMove(sessionId, 'move', original)).status, 'completed_locally');
        assert.equal((await client.requestDotMemoryMove(sessionId, 'move', original)).targetRevision, 1);
    });
    await t.test('explicit cancellation keeps both copies and never resumes deletion under the old ID', async () => {
        await remember('cancelled');
        const original = await prepare(intent('cancelled'));
        await dotMemoryMoveRPC(fixture.root, sessionId, { schemaVersion: 1, action: 'move', ...original }, stage => {
            if (stage === 'target_saved') throw Error('fixture-interruption');
        });
        const cancelled = await client.requestDotMemoryMove(sessionId, 'cancel', original);
        assert.equal(cancelled.status, 'abandoned');
        assert.match(client.dotMemoryMoveNotice(cancelled), /副本保留/);
        assert.equal((await client.requestDotMemoryMove(sessionId, 'move', original)).status, 'abandoned');
        for (const scope of ['dot', 'user']) {
            assert.equal((await fixture.invoke('dot_memory_read', { scope, key: 'cancelled' })).memory.value.language, '中文');
        }
    });
    await t.test('a new client discovers the older reserved snapshot after the source has been edited', async () => {
        await remember('edited');
        const original = await prepare(intent('edited'));
        await dotMemoryMoveRPC(fixture.root, sessionId, { schemaVersion: 1, action: 'move', ...original }, stage => {
            if (stage === 'target_saved') throw Error('fixture-interruption');
        });
        await fixture.invoke('dot_memory_write', { requestID: randomUUID(), scope: 'dot', operation: {
            action: 'remember', key: 'edited', kind: 'preference', value: 'new source', revision: 1,
        } });
        const discovered = await client.requestDotMemoryMove(sessionId, 'prepare', intent('edited', 'dot', 2));
        assert.equal(discovered.requestID, original.requestID); assert.equal(discovered.sourceRevision, 1);
        const stopped = await client.requestDotMemoryMove(sessionId, 'cancel', original);
        assert.equal(stopped.status, 'abandoned');
        assert.equal((await fixture.invoke('dot_memory_read', { key: 'edited' })).memory.value, 'new source');
    });
    await t.test('an invalidated workspace rejects subsequent native calls', async () => {
        current = false;
        await assert.rejects(client.requestDotMemoryMove(sessionId, 'status', intent('round-trip')), /memory_move_invalid_response/);
        assert(wire.every(payload => !('userId' in payload) && !('owner' in payload) && !('bank' in payload) && !('value' in payload)));
    });
});
