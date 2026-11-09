#!/usr/bin/env node
// The root maintenance verifier invokes this fixed entry as the original user.
// It receives identities only; no grant, account key, task instruction or queue mutation.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { SessionProcessProofs, LinuxProcessIdentitySchema } from '../dist/automation/rest/index.mjs';
try {
    if (process.argv.length !== 3 || process.argv[2] !== '--record-verified' || !process.getuid?.()) throw Error();
    let input = ''; for await (const part of process.stdin) { input += part; if (Buffer.byteLength(input) > 65536) throw Error(); }
    const body = JSON.parse(input), identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    if (!body || Object.keys(body).some(key => !['machineID','sessions'].includes(key)) || !identifier(body.machineID)
        || !Array.isArray(body.sessions) || !body.sessions.length || body.sessions.length > 100) throw Error();
    const config = JSON.parse(readFileSync('/etc/happy-control/worker.json', 'utf8'));
    if (config.registration.machineID !== body.machineID) throw Error();
    const cached = JSON.parse(readFileSync(join(config.happyHomeDirectory, 'sessions.json'), 'utf8')).sessions;
    const directory = join(userInfo().homedir, '.local/state/happy-control/machines', createHash('sha256').update(body.machineID).digest('hex'), 'session-process-proofs');
    const proofs = new SessionProcessProofs(directory, body.machineID), recorded = [];
    for (const item of body.sessions) {
        if (!item || Object.keys(item).some(key => !['sessionID','identity'].includes(key)) || !identifier(item.sessionID)) throw Error();
        const identity = LinuxProcessIdentitySchema.parse(item.identity), saved = cached[item.sessionID];
        if (!saved || !proofs.importVerified({ id: item.sessionID, metadata: saved.metadata }, identity)) throw Error();
        recorded.push(item.sessionID);
    }
    process.stdout.write(JSON.stringify({ ok: true, recorded }) + '\n');
} catch {
    process.stderr.write('SESSION_PROCESS_PROOF_IMPORT_REJECTED\n'); process.exitCode = 1;
}
