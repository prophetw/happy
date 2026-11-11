import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// pkgroll bundles devDependencies. The fork's workspace-only automation API
// must not resolve to the unrelated registry happy-agent package after packing.
export function verifyAgentBundle(packageDirectory) {
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        assert.ok(!Object.hasOwn(manifest[field] ?? {}, 'happy-agent'), `happy-agent must not be in ${field}`);
    }
    assert.ok(manifest.devDependencies?.['happy-agent'], 'happy-agent must be bundled as a devDependency');

    let checkedFiles = 0;
    function inspect(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) inspect(path);
            else if (/\.(?:[cm]?js|d\.[cm]?ts)$/.test(entry.name)) {
                assert.ok(entry.isFile(), `Bundle output must be a regular file: ${path}`);
                const source = readFileSync(path, 'utf8');
                // Include declarations and static/dynamic/require imports, but
                // not package.json metadata embedded in the CLI itself.
                assert.doesNotMatch(source, /(?:\bfrom\s*|\bimport\s*|\b(?:import|require)\s*\(\s*)['"`]happy-agent(?:\/[^'"`\r\n]*)?['"`]/,
                    `Unbundled happy-agent reference in ${path}`);
                checkedFiles += 1;
            }
        }
    }
    inspect(join(packageDirectory, 'dist'));
    assert.ok(checkedFiles > 0, 'No bundle files checked');

    function checkEntrypoints(value) {
        if (typeof value === 'string') {
            assert.ok(value.startsWith('./dist/'), `Unexpected bundle entrypoint: ${value}`);
            assert.ok(statSync(join(packageDirectory, value)).isFile(), `Missing entrypoint: ${value}`);
        } else if (value && typeof value === 'object') {
            for (const entry of Object.values(value)) checkEntrypoints(entry);
        }
    }
    checkEntrypoints(manifest.exports);
    return { checkedFiles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const directory = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
    const result = verifyAgentBundle(directory);
    console.log(`Happy CLI bundle verified: ${result.checkedFiles} files, no external happy-agent dependency`);
}
