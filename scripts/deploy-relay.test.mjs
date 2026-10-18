import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
    const dir = mkdtempSync(path.join(tmpdir(), 'relay-deploy-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    const remote = path.join(dir, 'remote');
    mkdirSync(bin); mkdirSync(remote);
    writeFileSync(path.join(remote, '.env.relay'), 'RELAY_PUBLIC_URL=https://kept.example/relay\nRELAY_PORT=18193\nHANDY_MASTER_SECRET=keep-existing-secret\nRELAY_IMAGE=happy-relay:previous\n', { mode: 0o600 });
    function command(name, body) { writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${body}`, { mode: 0o755 }); }
    command('ssh', `
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
fs.appendFileSync(process.env.TEST_EVENTS,'ssh\\n');
fs.appendFileSync(process.env.TEST_EVENTS,'ssh-args '+JSON.stringify(process.argv.slice(2))+'\\n');
const child=spawnSync('sh',['-s'],{input:fs.readFileSync(0),env:{...process.env,TEST_SIDE:'remote'},encoding:'utf8'});
process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');process.exit(child.status??1);
`);
    command('scp', `
const fs=require('node:fs');const args=process.argv.slice(2);const src=args.at(-2);const target=args.at(-1).split(':').slice(1).join(':');
fs.appendFileSync(process.env.TEST_EVENTS,'scp '+src+'\\n');fs.copyFileSync(src,target);
fs.appendFileSync(process.env.TEST_EVENTS,'scp-args '+JSON.stringify(args)+'\\n');
`);
    command('docker', `
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_EVENTS,(process.env.TEST_SIDE||'local')+' docker '+args.join(' ')+'\\n');
if(args[0]==='image'){
  if(process.env.TEST_SIDE==='remote'&&process.env.TEST_MISSING==='1'&&!fs.existsSync(process.env.TEST_IMPORTED))process.exit(1);
  console.log(args.at(-1).includes('revision')?process.env.TEST_REVISION:'sha256:1111111111111111111111111111111111111111111111111111111111111111');
}else if(args[0]==='save'){process.stdout.write('fixture-image');}
else if(args[0]==='load'){fs.writeFileSync(process.env.TEST_IMPORTED,'yes');}
else if(args[0]==='run'){
  if(process.env.TEST_BAD_IMAGE==='1'){console.error('Image lacks required relay capability');process.exit(1);}
}
else if(args[0]==='compose'){
  if(args.includes('--help')){console.log(process.env.TEST_OLD_COMPOSE==='1'?'usage':'--wait --wait-timeout');process.exit(0);}
  if(args.includes('exec')){
    if(args.includes('node')){
      if(process.env.TEST_BAD_ACCESS==='1'){console.log('unknown');process.exit(0);}
      const contents=fs.readFileSync('.env.relay','utf8');
      const value=(contents.match(/^HAPPY_ALLOWED_ACCOUNT_IDS=(.*)$/m)?.[1]||'').trim().replace(/^['"]|['"]$/g,'');
      console.log(value===''?'deny-all':value==='*'?'public':'allowlist');process.exit(0);
    }
    if(process.env.TEST_HEALTH_FAILURE==='1'){console.error('fixture health failure');process.exit(22);}
    console.log(JSON.stringify({service:process.env.TEST_WRONG_SERVICE==='1'?'other':'happy-server',status:'ok'}));
  }
}
`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_EVENTS: path.join(dir, 'events'), TEST_IMPORTED: path.join(dir, 'imported') };
    const run = (args = [], extra = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/deploy-relay.mjs'), '--host', 'root@fixture', '--dir', remote, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15_000 });
    return { dir, remote, env, run, events: () => readFileSync(env.TEST_EVENTS, 'utf8') };
}

test('reuses an identical image and preserves existing credentials, URL and port', t => {
    const f = fixture(t);
    const result = f.run(['--image', 'happy-relay:ready']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /skipping image transfer and import/);
    const env = readFileSync(path.join(f.remote, '.env.relay'), 'utf8');
    assert.match(env, /HANDY_MASTER_SECRET=keep-existing-secret/);
    assert.match(env, /RELAY_PUBLIC_URL=https:\/\/kept.example\/relay/);
    assert.match(env, /RELAY_PORT=18193/);
    assert.match(env, /RELAY_IMAGE=happy-relay:ready/);
    assert.doesNotMatch(result.stdout + result.stderr, /keep-existing-secret/);
    assert.doesNotMatch(f.events(), /docker save|docker load|docker build/);
});

test('transfers a missing image, verifies its ID and removes the temporary archive', t => {
    const f = fixture(t);
    const result = f.run(['--image', 'happy-relay:ready'], { TEST_MISSING: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.events(), /docker save/);
    assert.match(f.events(), /remote docker load/);
    assert.ok(existsSync(f.env.TEST_IMPORTED));
    assert.equal(existsSync(path.join(f.remote, '.relay-image-111111111111.tar.gz')), false);
});

test('a failing health check is a failed deployment', t => {
    const f = fixture(t);
    const result = f.run(['--image', 'happy-relay:ready'], { TEST_HEALTH_FAILURE: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixture health failure/);
    assert.doesNotMatch(result.stdout, /Deployment verified/);
});

test('does not accept an HTTP 200 response from a different service', t => {
    const f = fixture(t);
    const result = f.run(['--image', 'happy-relay:ready'], { TEST_WRONG_SERVICE: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /health response is invalid/);
    assert.doesNotMatch(result.stdout, /Deployment verified/);
});

test('initializes a new deployment once, without displaying the generated master secret', t => {
    const f = fixture(t);
    rmSync(path.join(f.remote, '.env.relay'));
    const result = f.run(['--image', 'happy-relay:ready']);
    assert.equal(result.status, 0, result.stderr);
    const contents = readFileSync(path.join(f.remote, '.env.relay'), 'utf8');
    const master = contents.match(/^HANDY_MASTER_SECRET=([a-f0-9]{64})$/m);
    assert.ok(master);
    assert.match(contents, /^RELAY_PUBLIC_URL=http:\/\/fixture:8193$/m);
    assert.match(contents, /^RELAY_BIND_ADDRESS=127\.0\.0\.1$/m);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(master[1]));
});

test('rejects non-main or dirty source checkouts before contacting the server', t => {
    const f = fixture(t);
    const source = path.join(f.dir, 'source');
    mkdirSync(source);
    const git = args => spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    assert.equal(git(['init', '-b', 'feature']).status, 0);
    let result = f.run(['--source', source]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be on main/);
    assert.equal(existsSync(f.env.TEST_EVENTS), false);
    assert.equal(git(['symbolic-ref', 'HEAD', 'refs/heads/main']).status, 0);
    writeFileSync(path.join(source, 'uncommitted.txt'), 'preserve me');
    result = f.run(['--source', source]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be clean/);
    assert.equal(readFileSync(path.join(source, 'uncommitted.txt'), 'utf8'), 'preserve me');
    assert.equal(existsSync(f.env.TEST_EVENTS), false);
});

test('rejects command-like options before running deployment commands', t => {
    const f = fixture(t);
    const result = f.run(['--image', 'image;echo-secret']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid image reference/);
    assert.equal(existsSync(f.env.TEST_EVENTS), false);
});

test('configures allowed accounts and retains them on a later deployment', t => {
    const f = fixture(t);
    let result = f.run(['--image', 'happy-relay:ready', '--allowed-accounts', 'account-one,account-two']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(f.remote, '.env.relay'), 'utf8'), /^HAPPY_ALLOWED_ACCOUNT_IDS=account-one,account-two$/m);
    assert.match(result.stdout, /configured with an allowlist/);
    result = f.run(['--image', 'happy-relay:ready']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(f.remote, '.env.relay'), 'utf8'), /^HAPPY_ALLOWED_ACCOUNT_IDS=account-one,account-two$/m);
});

test('reports deny-all access when no account IDs were configured', t => {
    const f = fixture(t);
    const result = f.run(['--image', 'happy-relay:ready']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Account access is disabled/);
});

test('rejects a public wildcard in the private deployment account option', t => {
    const f = fixture(t);
    const result = f.run(['--image', 'happy-relay:ready', '--allowed-accounts', '*']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /comma-separated Happy account IDs/);
    assert.equal(existsSync(f.env.TEST_EVENTS), false);
});

test('reports explicitly public access even when the env value is quoted', t => {
    const f = fixture(t);
    const envPath = path.join(f.remote, '.env.relay');
    writeFileSync(envPath, readFileSync(envPath, 'utf8') + 'HAPPY_ALLOWED_ACCOUNT_IDS="*"\n');
    const result = f.run(['--image', 'happy-relay:ready']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Account access is public/);
});

test('does not report successful deployment when the account access response is invalid', t => {
    const f = fixture(t);
    const result = f.run(['--image', 'happy-relay:ready'], { TEST_BAD_ACCESS: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /access configuration response is invalid/);
    assert.doesNotMatch(result.stdout, /Deployment verified/);
});

test('dry-run prints a reusable plan without invoking SSH, Docker or Git', t => {
    const f = fixture(t);
    const before = readFileSync(path.join(f.remote, '.env.relay'), 'utf8');
    const result = f.run(['--dry-run', '--image', 'happy-relay:ready', '--ssh-port', '2222', '--bind-address', '192.168.99.56', '--project', 'team-relay']);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.executed, false);
    assert.equal(plan.sshPort, '2222');
    assert.equal(plan.bindAddress, '192.168.99.56');
    assert.equal(plan.project, 'team-relay');
    assert.equal(existsSync(f.env.TEST_EVENTS), false);
    assert.equal(readFileSync(path.join(f.remote, '.env.relay'), 'utf8'), before);
});

test('check verifies prerequisites without changing remote configuration or starting containers', t => {
    const f = fixture(t);
    const before = readFileSync(path.join(f.remote, '.env.relay'), 'utf8');
    const result = f.run(['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Prerequisite checks passed/);
    assert.equal(readFileSync(path.join(f.remote, '.env.relay'), 'utf8'), before);
    assert.doesNotMatch(f.events(), /docker (build|run|save|load)|compose.*up -d|^scp /m);
});

test('check rejects Compose without the required wait options', t => {
    const f = fixture(t);
    const result = f.run(['--check'], { TEST_OLD_COMPOSE: '1' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Prerequisite checks passed/);
    assert.doesNotMatch(f.events(), /docker (build|run|save|load)|compose.*up -d|^scp /m);
});

test('passes SSH port and identity consistently to ssh and scp', t => {
    const f = fixture(t);
    const identity = path.join(f.dir, 'fixture-key');
    writeFileSync(identity, 'fixture key, not a real credential', { mode: 0o600 });
    const result = f.run(['--image', 'happy-relay:ready', '--ssh-port', '2222', '--identity', identity]);
    assert.equal(result.status, 0, result.stderr);
    const events = f.events().split('\n');
    const ssh = JSON.parse(events.find(line => line.startsWith('ssh-args ')).slice('ssh-args '.length));
    const scp = JSON.parse(events.find(line => line.startsWith('scp-args ')).slice('scp-args '.length));
    assert.deepEqual(ssh.slice(ssh.indexOf('-p'), ssh.indexOf('-p') + 2), ['-p', '2222']);
    assert.deepEqual(scp.slice(scp.indexOf('-P'), scp.indexOf('-P') + 2), ['-P', '2222']);
    assert.equal(ssh[ssh.indexOf('-i') + 1], identity);
    assert.equal(scp[scp.indexOf('-i') + 1], identity);
});

test('persists an explicit bind address and project, retaining both on the next deployment', t => {
    const f = fixture(t);
    const envPath = path.join(f.remote, '.env.relay');
    let result = f.run(['--image', 'happy-relay:ready', '--bind-address', '192.168.99.56', '--project', 'team-relay']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(envPath, 'utf8'), /^RELAY_BIND_ADDRESS=192\.168\.99\.56$/m);
    assert.match(readFileSync(envPath, 'utf8'), /^COMPOSE_PROJECT_NAME=team-relay$/m);
    result = f.run(['--image', 'happy-relay:ready']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(envPath, 'utf8'), /^RELAY_BIND_ADDRESS=192\.168\.99\.56$/m);
    assert.match(readFileSync(envPath, 'utf8'), /^COMPOSE_PROJECT_NAME=team-relay$/m);
});

test('rejects images missing relay access control or live switching before contacting SSH', t => {
    const f = fixture(t);
    const result = f.run(['--image', 'happy-relay:old'], { TEST_BAD_IMAGE: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Image lacks required relay capability/);
    assert.doesNotMatch(f.events(), /^ssh$|^scp /m);
});

test('rejects a clean freshly fetched main when it lacks the relay feature', t => {
    const f = fixture(t);
    const source = path.join(f.dir, 'source');
    const origin = path.join(f.dir, 'origin.git');
    mkdirSync(source);
    const git = (...args) => {
        const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git('init', '-b', 'main');
    git('config', 'user.name', 'Relay deployment test');
    git('config', 'user.email', 'relay-test@example.invalid');
    writeFileSync(path.join(source, 'README.md'), 'A main without the relay feature');
    git('add', '--', 'README.md');
    git('commit', '-m', 'fixture');
    git('init', '--bare', origin);
    git('remote', 'add', 'origin', origin);
    git('push', 'origin', 'main');
    const result = f.run(['--source', source]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing relay account access or live switching/);
    assert.equal(existsSync(f.env.TEST_EVENTS), false);
});

for (const [flag, value] of [['--ssh-port', '70000'], ['--bind-address', '0.0.0.0;echo'], ['--project', '../other']]) {
    test(`rejects invalid ${flag} before running commands`, t => {
        const f = fixture(t);
        const result = f.run(['--image', 'happy-relay:ready', flag, value]);
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(f.env.TEST_EVENTS), false);
    });
}
