import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyAgentBundle } from './verify-agent-bundle.mjs';

function fixture(t, options = {}) {
    const root = mkdtempSync(join(tmpdir(), 'happy-package-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'dist', 'daemon'), { recursive: true });
    const manifest = {
        devDependencies: { 'happy-agent': 'workspace:*' },
        exports: { './daemon/automationMain': { import: { default: './dist/daemon/automationMain.mjs' } } },
        ...options.manifest,
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    if (!options.empty) writeFileSync(join(root, 'dist', 'daemon', 'automationMain.mjs'), options.source ?? 'export const boot = () => {};');
    return root;
}

test('bundled automation output passes without a workspace node_modules tree', t => {
    assert.equal(verifyAgentBundle(fixture(t)).checkedFiles, 1);
});

test('allows bundled package metadata without mistaking it for an import', t => {
    assert.equal(verifyAgentBundle(fixture(t, { source: 'export const metadata = { devDependencies: { "happy-agent": "workspace:*" } };' })).checkedFiles, 1);
});

for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    test(`rejects registry resolution through ${field}`, t => {
        assert.throws(() => verifyAgentBundle(fixture(t, { manifest: { [field]: { 'happy-agent': '0.1.0' } } })), /must not be in/);
    });
}

test('requires the build-time workspace dependency', t => {
    assert.throws(() => verifyAgentBundle(fixture(t, { manifest: { devDependencies: {} } })), /must be bundled/);
});

for (const source of [
    "import { ScopedWorker } from 'happy-agent/automation';",
    'const production = import("happy-agent/automation/production");',
    "const agent = require('happy-agent');",
    "import 'happy-agent/automation';",
    "export type Worker = import('happy-agent/automation').ScopedWorker;",
]) {
    test(`rejects external reference: ${source}`, t => {
        assert.throws(() => verifyAgentBundle(fixture(t, { source })), /Unbundled happy-agent reference/);
    });
}

test('also checks nested declaration chunks', t => {
    const root = fixture(t);
    writeFileSync(join(root, 'dist', 'daemon', 'automationMain.d.mts'), "export { WorkerConfig } from 'happy-agent/automation/production';");
    assert.throws(() => verifyAgentBundle(root), /Unbundled happy-agent reference/);
});

test('rejects an empty build directory', t => {
    assert.throws(() => verifyAgentBundle(fixture(t, { empty: true })), /No bundle files checked/);
});

test('rejects a missing public entrypoint', t => {
    const root = fixture(t, { manifest: { exports: { './missing': './dist/missing.mjs' } } });
    assert.throws(() => verifyAgentBundle(root), /ENOENT|Missing entrypoint/);
});

function installedFixture(t, omitExport = false) {
    const root = fixture(t, { source: ['automationWorkerMain', 'automationMetadataMain', 'launchAutomationWorker']
        .filter(name => !omitExport || name !== 'launchAutomationWorker').map(name => `export function ${name}() { throw Error('must not execute'); }`).join('\n') });
    mkdirSync(join(root, 'dist', 'codex'));
    const names = ['startHostedDot', 'statusHostedDot', 'stopHostedDot', 'prepareHostedDotClear', 'clearHostedDot', 'recoverHostedDot'];
    writeFileSync(join(root, 'dist', 'codex', 'hostedDotLifecycle.mjs'), 'export const HOSTED_DOT_LIFECYCLE_VERSION = 1;\n' +
        names.map(name => `export function ${name}() { throw Error('must not execute'); }`).join('\n'));
    writeFileSync(join(root, 'dist', 'codex', 'hostedDotLifecycle.cjs'), 'exports.HOSTED_DOT_LIFECYCLE_VERSION = 1;\n' +
        names.map(name => `exports.${name} = () => { throw Error('must not execute'); };`).join('\n'));
    return root;
}

test('installed smoke checks both formats and automation exports without executing worker or lifecycle actions', t => {
    const root = installedFixture(t);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./smoke-installed-package.mjs', import.meta.url)), root], { cwd: tmpdir(), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /automation and ESM\/CJS lifecycle imports/);
});

test('installed smoke rejects an incomplete automation entrypoint', t => {
    const root = installedFixture(t, true);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./smoke-installed-package.mjs', import.meta.url)), root], { cwd: tmpdir(), encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Missing installed automation export: launchAutomationWorker/);
});
