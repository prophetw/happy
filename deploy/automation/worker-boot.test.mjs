import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const hasTmpfiles = spawnSync('systemd-tmpfiles', ['--version']).status === 0;

test('a boot pass retires only this Happy home’s daemon ownership; a normal pass preserves it',
    { skip: !hasTmpfiles }, t => {
    const root = mkdtempSync(join(tmpdir(), 'happy-worker-boot-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home/dev/.happy');
    const other = join(root, 'home/dev/.happy-dev');
    const configDir = join(root, 'etc/tmpfiles.d');
    for (const dir of [home, other, configDir]) mkdirSync(dir, { recursive: true });
    const source = new URL('./happy-automation-worker.tmpfiles.conf', import.meta.url);
    copyFileSync(source, join(configDir, 'happy-automation-worker.conf'));
    const files = ['daemon.state.json', 'daemon.state.json.lock'];
    for (const file of files) {
        writeFileSync(join(home, file), 'previous owner');
        writeFileSync(join(other, file), 'another daemon');
    }
    writeFileSync(join(home, 'sessions.json'), 'persistent sessions');

    const remove = (...flags) => execFileSync('systemd-tmpfiles', ['--root=' + root, '--remove', ...flags]);
    remove();
    for (const file of files) assert.equal(readFileSync(join(home, file), 'utf8'), 'previous owner');
    remove('--boot');
    for (const file of files) {
        assert.equal(existsSync(join(home, file)), false, file);
        assert.equal(readFileSync(join(other, file), 'utf8'), 'another daemon');
        writeFileSync(join(home, file), 'new owner');
    }
    remove();
    for (const file of files) assert.equal(readFileSync(join(home, file), 'utf8'), 'new owner');
    assert.equal(readFileSync(join(home, 'sessions.json'), 'utf8'), 'persistent sessions');
});
