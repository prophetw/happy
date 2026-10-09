#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const options = {
    host: 'root@192.168.99.55', dir: '/data/code/happy-relay',
    source: path.join(homedir(), '.cache', 'happy-relay', 'release-source'),
};
const flags = { '--host': 'host', '--dir': 'dir', '--source': 'source', '--image': 'image', '--public-url': 'publicUrl', '--port': 'port' };
for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === '--help' || flag === '-h') {
        console.log(`Usage: node scripts/deploy-relay.mjs [options]
  --host <user@host>    SSH target (default: root@192.168.99.55)
  --dir <path>          Deployment directory (default: /data/code/happy-relay)
  --source <path>       Clean main checkout to build; default is a cached upstream clone
  --image <tag>         Deploy a prebuilt local image instead of fetching/building main
  --public-url <url>    Set client-facing API URL; otherwise retain existing value
  --port <n>            Set published HTTP port; otherwise retain existing value`);
        process.exit(0);
    }
    if (!flags[flag] || !process.argv[i + 1]) throw new Error(`Unknown or incomplete option: ${flag}`);
    options[flags[flag]] = process.argv[++i];
}
if (!/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.host)) throw new Error('Use a hostname or IPv4 SSH target, optionally user@host.');
if (!/^\/[A-Za-z0-9_./-]+$/.test(options.dir)) throw new Error('Use an absolute deployment path containing letters, digits, _, -, / and .');
if (options.port && (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535)) throw new Error('Invalid HTTP port.');
if (options.publicUrl) {
    const url = new URL(options.publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid public API URL.');
    options.publicUrl = url.toString().replace(/\/+$/, '');
}
if (options.image && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(options.image)) throw new Error('Invalid image reference.');

function run(command, args, { cwd = root, input, capture = true, allowFailure = false } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
        let output = '';
        if (capture) { child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data); }
        child.once('error', reject);
        child.once('close', code => code === 0 || allowFailure ? resolve({ code, output: output.trim() }) : reject(new Error(`${command} failed (${code}): ${output.trim()}`)));
        if (input !== undefined) child.stdin.end(input);
    });
}
const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', options.host];
const remote = (script, settings) => run('ssh', [...sshArgs, 'sh -s'], { ...settings, input: `set -eu\n${script}\n` });
const imageId = async image => {
    const result = await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { allowFailure: true });
    return result.code === 0 ? result.output : null;
};

async function selectImage() {
    if (options.image) return options.image;
    await mkdir(path.dirname(options.source), { recursive: true });
    if (!existsSync(path.join(options.source, '.git'))) {
        console.log('Creating cached upstream main checkout...');
        await run('git', ['clone', '--single-branch', '--branch', 'main', 'git@github.com:slopus/happy.git', options.source], { capture: false });
    }
    const git = args => run('git', args, { cwd: options.source });
    if ((await git(['branch', '--show-current'])).output !== 'main') throw new Error('Release source must be on main.');
    if ((await git(['status', '--porcelain=v1'])).output) throw new Error('Release source must be clean. Local changes were preserved.');
    const gitDir = path.resolve(options.source, (await git(['rev-parse', '--git-dir'])).output);
    const commonDir = path.resolve(options.source, (await git(['rev-parse', '--git-common-dir'])).output);
    if (gitDir !== commonDir) throw new Error('Use a standalone clone, not a worktree.');
    await git(['fetch', 'origin', 'main']);
    await git(['merge', '--ff-only', 'origin/main']);
    const revision = (await git(['rev-parse', 'HEAD'])).output;
    if (revision !== (await git(['rev-parse', 'origin/main'])).output) throw new Error('main must exactly match freshly fetched origin/main.');
    const image = `happy-relay:main-${revision.slice(0, 8)}`;
    if (!await imageId(image)) {
        console.log(`Building ${image} from clean main ${revision.slice(0, 8)}...`);
        await run('docker', ['build', '--label', `org.opencontainers.image.revision=${revision}`, '--label', 'org.opencontainers.image.source=https://github.com/slopus/happy', '-t', image, '-f', 'Dockerfile', '.'], { cwd: options.source, capture: false });
    } else {
        const label = (await run('docker', ['image', 'inspect', image, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}'])).output;
        if (label !== revision) throw new Error('Cached image tag does not have the expected source revision.');
        console.log(`Reusing local image ${image}.`);
    }
    return image;
}

const started = Date.now();
let temporary;
try {
    const image = await selectImage();
    const expectedId = await imageId(image);
    if (!expectedId) throw new Error(`Local image missing: ${image}`);
    await remote(`mkdir -p ${quote(options.dir)}\ncommand -v docker >/dev/null\ndocker compose version >/dev/null`);
    const found = await remote(`docker image inspect ${quote(image)} --format '{{.Id}}' 2>/dev/null || true`);
    const reused = found.output === expectedId;
    if (reused) {
        console.log('Server already has the exact image; skipping image transfer and import.');
    } else {
        temporary = await mkdtemp(path.join(tmpdir(), 'happy-relay-deploy-'));
        const archive = path.join(temporary, 'relay-image.tar.gz');
        console.log('Packing and transferring the new image...');
        const save = spawn('docker', ['save', image], { stdio: ['ignore', 'pipe', 'inherit'] });
        const completed = new Promise((resolve, reject) => {
            save.once('error', reject);
            save.once('close', code => code === 0 ? resolve() : reject(new Error(`docker save failed (${code})`)));
        });
        await Promise.all([completed, pipeline(save.stdout, createGzip({ level: 1 }), createWriteStream(archive))]);
        const upload = path.posix.join(options.dir, `.relay-image-${expectedId.slice(7, 19)}.tar.gz`);
        await run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', archive, `${options.host}:${upload}`]);
        await remote(`docker load --input ${quote(upload)}\n[ "$(docker image inspect ${quote(image)} --format '{{.Id}}')" = ${quote(expectedId)} ]\nrm ${quote(upload)}`);
    }
    await run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', path.join(root, 'docker-compose.relay-only.yml'), `${options.host}:${path.posix.join(options.dir, 'docker-compose.relay-only.yml')}`]);
    const port = options.port || '8193';
    const publicUrl = options.publicUrl || `http://${options.host.split('@').pop()}:${port}`;
    const setOption = (key, value) => value === undefined ? '' : `set_value ${quote(key)} ${quote(value)}`;
    const deployed = await remote(`
cd ${quote(options.dir)}
umask 077
if [ ! -e .env.relay ]; then
    master_secret="$(openssl rand -hex 32)"
    printf '%s\\n' ${quote(`RELAY_PUBLIC_URL=${publicUrl}`)} 'RELAY_BIND_ADDRESS=0.0.0.0' ${quote(`RELAY_PORT=${port}`)} "HANDY_MASTER_SECRET=$master_secret" > .env.relay
    unset master_secret
fi
set_value() {
    awk -v key="$1" -v value="$2" 'BEGIN { found=0 } index($0,key "=")==1 { print key "=" value; found=1; next } { print } END { if (!found) print key "=" value }' .env.relay > .env.relay.next
    chmod 600 .env.relay.next
    mv .env.relay.next .env.relay
}
set_value RELAY_IMAGE ${quote(image)}
${setOption('RELAY_PUBLIC_URL', options.publicUrl)}
${setOption('RELAY_PORT', options.port)}
chmod 600 .env.relay
docker compose -f docker-compose.relay-only.yml --env-file .env.relay config --quiet
docker compose -f docker-compose.relay-only.yml --env-file .env.relay up -d --no-build --wait --wait-timeout 120
printf '\\nRELAY_HEALTH:'
docker compose -f docker-compose.relay-only.yml --env-file .env.relay exec -T relay curl --fail --silent --max-time 5 http://127.0.0.1:3005/health
printf '\\n'
`);
    const response = deployed.output.match(/^RELAY_HEALTH:(.*)$/m);
    const health = response ? JSON.parse(response[1]) : null;
    if (health?.service !== 'happy-server' || health?.status !== 'ok') throw new Error('Relay health response is invalid.');
    console.log('Relay is healthy; existing credentials and data volume retained.');
    console.log(`\nDeployment verified in ${((Date.now() - started) / 1000).toFixed(1)}s; image ${reused ? 'reused' : 'transferred'}.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
}
