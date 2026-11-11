// Import only library entrypoints. Do not start a daemon, authenticate, call a
// model, or contact a Happy server. The argument must be the installed package.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyAgentBundle } from './verify-agent-bundle.mjs';

assert.ok(process.argv[2], 'Pass the installed Happy package directory');
const directory = resolve(process.argv[2]);
const result = verifyAgentBundle(directory);
const automation = await import(pathToFileURL(join(directory, 'dist/daemon/automationMain.mjs')).href);
for (const name of ['automationWorkerMain', 'automationMetadataMain', 'launchAutomationWorker']) {
    assert.equal(typeof automation[name], 'function', `Missing installed automation export: ${name}`);
}
const lifecycle = await import(pathToFileURL(join(directory, 'dist/codex/hostedDotLifecycle.mjs')).href);
const require = createRequire(pathToFileURL(join(directory, 'package.json')));
const lifecycleCjs = require(join(directory, 'dist/codex/hostedDotLifecycle.cjs'));
for (const api of [lifecycle, lifecycleCjs]) {
    assert.equal(api.HOSTED_DOT_LIFECYCLE_VERSION, 1);
    for (const name of ['startHostedDot', 'statusHostedDot', 'stopHostedDot', 'prepareHostedDotClear', 'clearHostedDot', 'recoverHostedDot']) {
        assert.equal(typeof api[name], 'function', `Missing installed lifecycle export: ${name}`);
    }
}
console.log(`Installed Happy package passed: ${result.checkedFiles} bundle files; automation and ESM/CJS lifecycle imports`);
