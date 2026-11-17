#!/usr/bin/env node
/** Isolated, synthetic producer + real JSONL child + real encrypted HTTP outbox.
 * No live configuration, accounts, journals or models are used. Storage source
 * is the checkout's module or an explicitly supplied compatibility module. */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(cli, '../..'), fixtures = join(cli, 'scripts/fixtures');
const options = Object.fromEntries(process.argv.slice(2).map(arg => { const index = arg.indexOf('='); if (index < 0) throw Error('Use --name=value'); return [arg.slice(2, index), arg.slice(index + 1)]; }));
const output = resolve(options.output ?? mkdtempSync('/tmp/hosted-stream-bench-'));
mkdirSync(output, { recursive: true, mode: 0o700 });
const dependencies = join(output, 'node_modules');
if (!existsSync(dependencies)) {
    // Workspace packages such as happy-wire may be linked only in the CLI's
    // node_modules. Assemble links in the temporary output, never in the repo.
    mkdirSync(dependencies);
    for (const source of [join(repo, 'node_modules'), join(cli, 'node_modules')]) {
        if (!existsSync(source)) continue;
        for (const name of readdirSync(source).filter(name => !name.startsWith('.'))) {
            const target = join(dependencies, name);
            if (name.startsWith('@')) {
                mkdirSync(target, { recursive: true });
                for (const member of readdirSync(join(source, name))) if (!lstatSync(join(target, member), { throwIfNoEntry: false }))
                    symlinkSync(join(source, name, member), join(target, member));
            } else if (!lstatSync(target, { throwIfNoEntry: false })) symlinkSync(join(source, name), target);
        }
    }
}
const storage = resolve(options['storage-source'] ?? join(cli, 'src/codex/hostedDotStorage.ts'));
if (!existsSync(storage)) throw Error('Storage source does not exist');
const baseline = options.baseline ?? '51d4287c4c21fc59905f4bce442490ad48e864a4';
const deployed = options['deployed-root'];
const variants = (options.variants ?? 'main,candidate').split(','), backends = (options.backends ?? 'json,sqlite').split(',');
const count = Number(options.count ?? 64), history = Number(options.history ?? 23000), repeats = Number(options.repeats ?? 3), latency = Number(options.latency ?? 5), interval = Number(options.interval ?? 1);
const fault = options.fault;
if (fault && (!['durable', 'post', 'ack'].includes(fault) || variants.some(v => v !== 'candidate'))) throw Error('Fault fixtures require candidate and durable/post/ack');
for (const n of [count, history, repeats, latency, interval]) if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid bounded fixture option');
if (count > 1000 || history > 24000 || repeats > 10 || latency > 1000) throw Error('Fixture bound exceeded');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { syntheticOnly: true, baseline, storage, storageSHA256: sha(readFileSync(storage)), count, history, repeats, latency, interval, variants, backends, overlay: 'Only fake attachment/socket, measured storage writer/read compatibility, native notification timestamps. Main/client/API/durable outbox logic remains real.' };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
const summaries = [];
for (const variant of variants) {
    if (variant === 'deployed' && !deployed) throw Error('--deployed-root required');
    const root = variant === 'deployed' ? resolve(deployed, 'packages/happy-cli') : cli, src = join(root, 'src');
    const bundle = join(output, `${variant}.mjs`);
    await build({ entryPoints: [join(fixtures, 'hosted-stream-worker.mjs')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
        tsconfig: join(cli, 'tsconfig.json'), plugins: [{ name: 'isolated-fixture', setup(b) {
            b.onResolve({ filter: /^@fixture\// }, ({ path }) => ({ path: path === '@fixture/storage' ? storage : join(src, 'codex', path === '@fixture/main' ? 'hostedDotMain.ts' : 'hostedDotState.ts') }));
            b.onResolve({ filter: /^socket.io-client$/ }, () => ({ path: join(fixtures, 'hosted-stream-socket.mjs') }));
            b.onResolve({ filter: /^\.\.\/api\/api$/ }, ({ importer }) => importer.endsWith('hostedDotMain.ts') ? { path: join(fixtures, 'hosted-stream-attach.ts') } : undefined);
            b.onResolve({ filter: /^@\// }, ({ path }) => {
                const base = join(src, path.slice(2)), found = ['', '.ts', '.tsx', '.js', '/index.ts'].map(s => base + s).find(p => existsSync(p));
                if (!found) throw Error(`Unresolved source alias: ${path}`); return { path: found };
            });
            b.onLoad({ filter: /\.[jt]sx?$/ }, ({ path }) => {
                let source = variant === 'main' && path.startsWith(cli + '/src/') ? execFileSync('git', ['show', `${baseline}:${path.slice(repo.length + 1)}`], { cwd: repo, maxBuffer: 4 * 1024 * 1024 }).toString() : readFileSync(path, 'utf8');
                if (path.endsWith('hostedDotState.ts')) source = source.replace('HostedDotJournal.parse(readPrivate(file))', 'HostedDotJournal.parse(globalThis.__fixtureRead ? globalThis.__fixtureRead(file) : readPrivate(file))');
                if (path.endsWith('hostedDotAuthorityPublisher.ts')) {
                    source = source.replace('const storageWrite = write ? undefined : createHostedStorageWriter(file, state);',
                        'const storageWrite = write ? undefined : (globalThis.__fixtureCreateWriter ?? createHostedStorageWriter)(file, state);');
                    source = source.replace(/write = (savePrivate|saveHostedStorage)/, 'write = globalThis.__fixtureWrite ?? $1');
                    source = source.replace('= saveHostedStorage):', '= globalThis.__fixtureWrite ?? saveHostedStorage):');
                    source = source.replace('if (Buffer.byteLength(JSON.stringify(state)', 'if (!globalThis.__fixtureWrite && Buffer.byteLength(JSON.stringify(state)');
                    source = source.replace('if (write !== saveHostedStorage &&', 'if (!globalThis.__fixtureWrite && write !== saveHostedStorage &&');
                }
                if (path.endsWith('codexAppServerClient.ts')) {
                    source = source.replace('private handleNotification(method: string, params: any): void {', 'private handleNotification(method: string, params: any): void { globalThis.__fixtureNotification?.(method, params);');
                    source = source.replace('this.eventHandler = handler;', 'this.eventHandler = event => { globalThis.__fixtureNativeEvent?.(event); handler(event); };');
                }
                return { contents: source, loader: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : 'js' };
            });
        } }] });
    for (const backend of backends) for (let repeat = 0; repeat < repeats; repeat++) {
        const directory = mkdtempSync(join(output, `${variant}-${backend}-${repeat}-`)), rows = new Map(), posts = [], gets = [], accepted = [];
        let child, faulted = false;
        const server = createServer(async (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
            if (url.pathname === '/stats') return json({ completed: accepted.some(row => row.localId.endsWith('fixture-turn:end')) });
            if (!url.pathname.endsWith('/messages')) { res.statusCode = 404; return res.end(); }
            if (req.method === 'POST') {
                let body = ''; for await (const chunk of req) body += chunk;
                const messages = JSON.parse(body).messages, receipt = [];
                posts.push({ at: Date.now(), size: messages.length });
                for (const message of messages) {
                    let row = rows.get(message.localId);
                    if (!row) { row = { id: message.localId, seq: rows.size + 1000, localId: message.localId, content: { t: 'encrypted', c: message.content }, createdAt: Date.now(), updatedAt: Date.now() }; rows.set(row.localId, row); accepted.push({ localId: row.localId, at: Date.now() }); }
                    receipt.push({ localId: row.localId, seq: row.seq });
                }
                if (accepted.some(row => row.localId.endsWith('fixture-turn:end'))) writeFileSync(join(directory, 'relay-complete'), 'synthetic terminal received');
                if (fault === 'post' && !faulted && messages.some(row => row.localId.endsWith('fixture-item:0'))) {
                    faulted = true; child.kill('SIGKILL'); res.destroy(); return; // Only this newly spawned fixture child.
                }
                await new Promise(r => setTimeout(r, latency)); return json({ messages: receipt });
            }
            const after = Number(url.searchParams.get('after_seq'));
            gets.push({ at: Date.now(), after });
            await new Promise(r => setTimeout(r, latency));
            json({ messages: [...rows.values()].filter(row => row.seq > after).slice(0, 100), hasMore: false });
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const relay = `http://127.0.0.1:${server.address().port}`;
        let log = '';
        const launch = (restart = false) => {
            child = spawn(process.execPath, [bundle, directory, backend, relay, String(count), String(interval), String(history), ...(restart ? ['restart'] : [])], {
                env: { ...process.env, HAPPY_HOME_DIR: join(directory, 'isolated-cli-home'), FIXTURE_APP_SERVER: join(fixtures, 'hosted-stream-app-server.mjs'), FIXTURE_FAULT: fault ?? '', FIXTURE_NATIVE_EXIT: options['native-exit'] === 'true' ? '1' : '' }, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
            return new Promise(r => child.on('exit', (code, signal) => r({ code, signal })));
        };
        // Completion is identified by decrypt-free stable terminal ID. Main's
        // mapper ID is checked against the final durable envelopes below.
        const deadline = setTimeout(() => child?.kill('SIGTERM'), 200000);
        let exit, crashedOutputs;
        try {
            exit = await launch();
            if (fault) {
                assert.ok(exit.code === 86 || (fault === 'post' && exit.signal === 'SIGKILL'), `Expected injected crash, got ${JSON.stringify(exit)}`);
                // Parse through the reviewed backend in a separate short-lived process.
                crashedOutputs = [...rows.keys()];
                exit = await launch(true);
            }
        } finally { clearTimeout(deadline); await new Promise(r => server.close(r)); }
        writeFileSync(join(directory, 'process.log'), log, { mode: 0o600 });
        if (exit.code !== 0) throw Error(`${variant}/${backend}: ${JSON.stringify(exit)}; see ${directory}/process.log`);
        const result = JSON.parse(readFileSync(join(directory, 'worker-result.json'), 'utf8'));
        const snapshots = result.outputs.filter(row => row.envelope.ev.t === 'text' && row.envelope.ev.textSnapshot);
        const expected = Array.from({ length: count }, (_, n) => n % 7 === 0 ? '🙂' : '文').join('');
        assert.equal(snapshots.at(-1)?.envelope.ev.text, expected); assert.ok(result.outputs.every(row => row.sent));
        let rendered = '';
        for (const row of result.outputs) if (row.envelope.ev.t === 'text') {
            const ev = row.envelope.ev;
            if (ev.textSnapshot) rendered = ev.text;
            else { assert.equal(ev.textOffset, rendered.length, 'Unicode UTF-16 offsets must remain contiguous'); rendered += ev.text; }
        }
        assert.equal(rendered, expected); assert.equal(result.outputs.at(-1).envelope.ev.t, 'turn-end');
        assert.equal(rows.size, result.outputs.length); assert.equal(new Set(result.outputs.map(row => row.localId)).size, result.outputs.length);
        assert.equal(result.dispatches, 1, 'Unknown/accepted input must not be sent again after restart');
        assert.equal(result.threadId, 'fixture-thread'); assert.equal(result.epoch, 0); assert.equal(result.input.status, 'completed');
        if (options['native-exit'] === 'true') assert.equal(result.nativeFailures, 0, 'Buffered terminal must settle before exit can abort the turn');
        if (fault) for (const id of [...crashedOutputs, ...JSON.parse(readFileSync(join(directory, 'restart-durable-ids.json'), 'utf8'))])
            assert.ok(result.outputs.some(row => row.localId === id), 'Every durable/previously accepted stable ID remains in recovered journal');
        const delays = result.consumed.map((at, n) => at - result.generated[n]).sort((a, b) => a - b), percentile = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
        const first = accepted.find(row => row.localId.includes('fixture-item:0'));
        const summary = { variant, backend, repeat, directory, fault, recoveryVerified: !!fault, logicalBytes: result.logicalBytes, persists: result.persists, persistMs: result.persistMs,
            persistMaxMs: result.persistMaxMs, wallMs: result.wallMs, cpuMs: result.cpuMs, posts: posts.length, readbacks: gets.filter(row => row.after !== 191).length,
            maxBatch: Math.max(...posts.map(row => row.size)), queuePeak: result.queuePeak, outputs: result.outputs.length, uniqueRelayRows: rows.size,
            consumerLagP50Ms: percentile(delays, .5), consumerLagP95Ms: percentile(delays, .95), eventLoopP95Ms: result.eventLoopP95Ms,
            firstSegmentMs: first ? first.at - result.generated[0] : null, tailMs: accepted.at(-1).at - result.generated.at(-1),
            rawGenerationMs: result.generated.at(-1) - result.generated[0], throughputPerSecond: result.outputs.length / (result.wallMs / 1000), bodyAndStableIDsVerified: true };
        summaries.push(summary); writeFileSync(join(directory, 'relay-metrics.json'), JSON.stringify({ posts, gets, accepted }, null, 2), { mode: 0o600 });
        writeFileSync(join(output, 'results.json'), JSON.stringify(summaries, null, 2), { mode: 0o600 });
        console.log(JSON.stringify(summary));
    }
}
