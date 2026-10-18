#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { isIP } from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const options = {
    host: 'root@192.168.99.56', dir: '/data/code/happy-relay',
    source: path.join(homedir(), '.cache', 'happy-relay', 'release-source'),
};
const flags = { '--host': 'host', '--dir': 'dir', '--source': 'source', '--image': 'image', '--public-url': 'publicUrl', '--port': 'port', '--allowed-accounts': 'allowedAccounts', '--ssh-port': 'sshPort', '--identity': 'identity', '--bind-address': 'bindAddress', '--project': 'project' };
for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === '--help' || flag === '-h') {
        console.log(`Usage: node scripts/deploy-relay.mjs [options]
  --host <user@host>    SSH target or SSH-config Host (default: root@192.168.99.56)
  --dir <path>          Deployment directory (default: /data/code/happy-relay)
  --source <path>       Clean main checkout to build; default is a cached upstream clone
  --image <tag>         Deploy a prebuilt local image instead of fetching/building main
  --public-url <url>    Set client-facing API URL; otherwise retain existing value
  --port <n>            Set published HTTP port; otherwise retain existing value
  --allowed-accounts <ids>  Comma-separated Happy account IDs; new deployments deny all by default
  --ssh-port <n>        SSH port, applied to both ssh and scp
  --identity <path>     SSH private-key path (contents are never read by this script)
  --bind-address <IPv4> Published bind address; retain existing, or 127.0.0.1 for a new instance
  --project <name>      Compose project name; retained in the remote .env.relay
  --dry-run            Print a plan without running Git, Docker or SSH
  --check              Check local tools and remote prerequisites without deploying`);
        process.exit(0);
    }
    if (flag === '--dry-run' || flag === '--check') {
        options[flag === '--dry-run' ? 'dryRun' : 'check'] = true;
        continue;
    }
    if (!flags[flag] || !process.argv[i + 1]) throw new Error(`Unknown or incomplete option: ${flag}`);
    options[flags[flag]] = process.argv[++i];
}
if (!/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.host)) throw new Error('Use a hostname or IPv4 SSH target, optionally user@host.');
if (!/^\/[A-Za-z0-9_./-]+$/.test(options.dir)) throw new Error('Use an absolute deployment path containing letters, digits, _, -, / and .');
if (options.port && (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535)) throw new Error('Invalid HTTP port.');
if (options.sshPort && (!/^\d+$/.test(options.sshPort) || Number(options.sshPort) < 1 || Number(options.sshPort) > 65535)) throw new Error('Invalid SSH port.');
if (options.bindAddress && isIP(options.bindAddress) !== 4) throw new Error('Use an IPv4 bind address, for example 127.0.0.1 or 192.168.99.56.');
if (options.project && !/^[a-z0-9][a-z0-9_-]*$/.test(options.project)) throw new Error('Invalid Compose project name.');
if (options.dryRun && options.check) throw new Error('Choose either --dry-run or --check.');
if (options.identity) options.identity = path.resolve(options.identity.replace(/^~(?=\/)/, homedir()));
if (options.publicUrl) {
    const url = new URL(options.publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid public API URL.');
    options.publicUrl = url.toString().replace(/\/+$/, '');
}
if (options.image && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(options.image)) throw new Error('Invalid image reference.');
if (options.allowedAccounts !== undefined && !/^[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*$/.test(options.allowedAccounts)) {
    throw new Error('Use comma-separated Happy account IDs for --allowed-accounts.');
}
if (options.allowedAccounts !== undefined) options.allowedAccounts = options.allowedAccounts.split(',').map(id => id.trim()).join(',');

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
const connectionArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(options.identity ? ['-i', options.identity] : [])];
const sshArgs = [...connectionArgs, ...(options.sshPort ? ['-p', options.sshPort] : []), options.host];
const scpArgs = ['-q', ...connectionArgs, ...(options.sshPort ? ['-P', options.sshPort] : [])];
const remote = (script, settings) => run('ssh', [...sshArgs, 'sh -s'], { ...settings, input: `set -eu\n${script}\n` });
const imageId = async image => {
    const result = await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { allowFailure: true });
    return result.code === 0 ? result.output : null;
};

function showPlan() {
    console.log(JSON.stringify({
        mode: 'dry-run', host: options.host, sshPort: options.sshPort || 'SSH configuration / default',
        identityFile: options.identity || 'SSH configuration / agent', directory: options.dir,
        image: options.image || 'build from a clean main equal to freshly fetched origin/main',
        source: options.image ? undefined : options.source,
        bindAddress: options.bindAddress || 'retain existing; new instance: 127.0.0.1',
        publicUrl: options.publicUrl || 'retain existing; new instance: SSH host and published port',
        port: options.port || 'retain existing; new instance: 8193',
        project: options.project || 'retain existing; new instance: happy-relay',
        accountAccess: options.allowedAccounts ? 'specified allowlist' : 'retain existing; new instance: deny-all',
        steps: ['validate release source / image capabilities', 'check SSH and Docker Compose', 'reuse or transfer image by ID', 'preserve master secret and data volume', 'apply Compose and check health / access mode'],
        executed: false,
    }, null, 2));
}

async function checkPrerequisites() {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
    for (const [command, args] of [['git', ['--version']], ['ssh', ['-V']], ['scp', []]]) {
        // scp has no portable --version and returns nonzero for its usage text.
        await run(command, args, { allowFailure: command === 'scp' });
    }
    const local = await run('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}']);
    console.log(`Local Docker engine: ${local.output || 'available'}`);
    if (options.image && !await imageId(options.image)) throw new Error(`Local image missing: ${options.image}`);
    const checked = await remote(`
command -v docker >/dev/null
command -v openssl >/dev/null
command -v awk >/dev/null
command -v df >/dev/null
docker info >/dev/null
docker compose version
compose_help="$(docker compose up --help)"
printf '%s\\n' "$compose_help" | grep -q -- '--wait-timeout'
printf 'REMOTE_ARCH:'; uname -m
if [ -d ${quote(options.dir)} ]; then
    test -w ${quote(options.dir)}
    printf 'DEPLOY_DIR:exists-and-writable\\n'
    df -Pk ${quote(options.dir)}
else
    printf 'DEPLOY_DIR:not-created\\n'
    df -Pk /
fi
`);
    console.log(checked.output);
    console.log('Prerequisite checks passed. No image was built/imported, configuration changed or container started. Source eligibility and application connectivity remain separate checks.');
}

const requiredSource = [
    ['packages/happy-server/sources/app/auth/accountAccess.ts', 'HAPPY_ALLOWED_ACCOUNT_IDS'],
    ['packages/happy-server/sources/app/api/routes/relayRoutes.ts', 'liveSwitch: 1'],
    ['packages/happy-server/sources/app/api/api.ts', 'relayRoutes(typed)'],
];

function checkSourceCapabilities(source) {
    for (const [file, marker] of requiredSource) {
        const filename = path.join(source, file);
        if (!existsSync(filename) || !readFileSync(filename, 'utf8').includes(marker)) {
            throw new Error(`Release source is missing relay account access or live switching (${file}). Merge the relay feature into main and use --source with that clean standalone clone.`);
        }
    }
}

async function checkImageCapabilities(image) {
    const checks = requiredSource.map(([file, marker]) => [`/repo/${file}`, marker]);
    const probe = `const fs=require('node:fs');for(const [file,marker] of ${JSON.stringify(checks)}){if(!fs.existsSync(file)||!fs.readFileSync(file,'utf8').includes(marker)){console.error('Image lacks required relay capability: '+file);process.exit(1)}}`;
    await run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', image, '-e', probe]);
}

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
    checkSourceCapabilities(options.source);
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
    if (options.dryRun) { showPlan(); process.exit(0); }
    if (options.check) { await checkPrerequisites(); process.exit(0); }
    const image = await selectImage();
    const expectedId = await imageId(image);
    if (!expectedId) throw new Error(`Local image missing: ${image}`);
    await checkImageCapabilities(image);
    await remote(`command -v docker >/dev/null\ndocker info >/dev/null\ndocker compose version >/dev/null\nmkdir -p ${quote(options.dir)}`);
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
        await run('scp', [...scpArgs, archive, `${options.host}:${upload}`]);
        await remote(`docker load --input ${quote(upload)}\n[ "$(docker image inspect ${quote(image)} --format '{{.Id}}')" = ${quote(expectedId)} ]\nrm ${quote(upload)}`);
    }
    await run('scp', [...scpArgs, path.join(root, 'docker-compose.relay-only.yml'), `${options.host}:${path.posix.join(options.dir, 'docker-compose.relay-only.yml')}`]);
    const port = options.port || '8193';
    const publicUrl = options.publicUrl || `http://${options.host.split('@').pop()}:${port}`;
    const setOption = (key, value) => value === undefined ? '' : `set_value ${quote(key)} ${quote(value)}`;
    const deployed = await remote(`
cd ${quote(options.dir)}
umask 077
if [ ! -e .env.relay ]; then
    master_secret="$(openssl rand -hex 32)"
    printf '%s\\n' ${quote(`RELAY_PUBLIC_URL=${publicUrl}`)} ${quote(`RELAY_BIND_ADDRESS=${options.bindAddress || '127.0.0.1'}`)} ${quote(`RELAY_PORT=${port}`)} "HANDY_MASTER_SECRET=$master_secret" 'HAPPY_ALLOWED_ACCOUNT_IDS=' > .env.relay
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
${setOption('RELAY_BIND_ADDRESS', options.bindAddress)}
${setOption('COMPOSE_PROJECT_NAME', options.project)}
${setOption('HAPPY_ALLOWED_ACCOUNT_IDS', options.allowedAccounts)}
chmod 600 .env.relay
docker compose -f docker-compose.relay-only.yml --env-file .env.relay config --quiet
docker compose -f docker-compose.relay-only.yml --env-file .env.relay up -d --no-build --wait --wait-timeout 120
printf '\\nRELAY_HEALTH:'
docker compose -f docker-compose.relay-only.yml --env-file .env.relay exec -T relay curl --fail --silent --max-time 5 http://127.0.0.1:3005/health
printf '\\n'
printf 'RELAY_ACCESS:'
docker compose -f docker-compose.relay-only.yml --env-file .env.relay exec -T relay node -e 'const value = (process.env.HAPPY_ALLOWED_ACCOUNT_IDS ?? "").trim(); console.log(value === "" ? "deny-all" : value === "*" ? "public" : "allowlist")'
`);
    const response = deployed.output.match(/^RELAY_HEALTH:(.*)$/m);
    const health = response ? JSON.parse(response[1]) : null;
    if (health?.service !== 'happy-server' || health?.status !== 'ok') throw new Error('Relay health response is invalid.');
    const accessMode = deployed.output.match(/^RELAY_ACCESS:(.*)$/m)?.[1];
    if (!['deny-all', 'public', 'allowlist'].includes(accessMode)) throw new Error('Relay account access configuration response is invalid.');
    console.log('Relay is healthy; existing credentials and data volume retained.');
    if (accessMode === 'deny-all') console.log('Account access is disabled. Set HAPPY_ALLOWED_ACCOUNT_IDS before clients can sign in.');
    else if (accessMode === 'public') console.log('Account access is public (*). Restrict HAPPY_ALLOWED_ACCOUNT_IDS before exposing this private relay.');
    else console.log('Account access is configured with an allowlist.');
    console.log(`\nDeployment verified in ${((Date.now() - started) / 1000).toFixed(1)}s; image ${reused ? 'reused' : 'transferred'}.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
}
