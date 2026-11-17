// Read-only operator check. Never changes a lease, cancels work or sends a message.
import { readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2), strict = args.includes('--require-no-global-holders');
const value = flag => { const i = args.indexOf(flag); if (i < 0 || !args[i + 1]?.startsWith('/')) throw Error(`Required: ${flag} <absolute-path>`); return args[i + 1]; };
try {
    const config = JSON.parse(readFileSync(value('--config'), 'utf8')), runtime = value('--runtime');
    if (config.role !== 'worker') throw Error('WORKER_CONFIG_REQUIRED');
    const r = config.registration, overrides = {};
    for (const [path, limit] of Object.entries(r.projectConcurrencyOverrides ?? {})) {
        if (realpathSync(path) !== path) throw Error('PROJECT_PATH_CHANGED');
        let repository = path;
        try { repository = realpathSync(resolve(path, execFileSync('git', ['-C', path, 'rev-parse', '--git-common-dir'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) }).trim())); } catch { /* Same non-Git fallback as the Worker. */ }
        if (overrides[repository] !== undefined && overrides[repository] !== limit) throw Error('INVALID_CONCURRENCY');
        overrides[repository] = limit;
    }
    const { TaskQueue } = await import(pathToFileURL(join(runtime, 'packages/happy-agent/dist/automation/rest/index.mjs')));
    const directory = join(userInfo().homedir, '.local/state/happy-control/machines', createHash('sha256').update(r.machineID).digest('hex'));
    const queue = new TaskQueue(directory, { projectConcurrency: r.projectConcurrency ?? 2,
        machineConcurrency: r.machineConcurrency === undefined ? r.maxConcurrency ?? null : r.machineConcurrency,
        projectOverrides: overrides }, { machineID: r.machineID, readOnly: true });
    const tasks = queue.tasks(), terminal = t => ['completed', 'failed', 'cancelled'].includes(t.state);
    const active = tasks.filter(t => !terminal(t) && !['queued', 'waiting-resource'].includes(t.state));
    const view = t => ({ taskID: t.id, requestID: t.requestID, sessionID: t.sessionID, state: t.state, reason: t.reason,
        legacy: !!t.legacy, processID: t.processID, dispatched: t.dispatched, seq: t.seq });
    const globalHolders = active.filter(t => t.resources.some(r => r.key === 'machine' && r.mode === 'exclusive')).map(view);
    const waiting = tasks.filter(t => ['queued', 'waiting-resource'].includes(t.state)).map(t => {
        const blockers = active.filter(other => other.resources.some(a => t.resources.some(b => a.key === b.key && (a.mode === 'exclusive' || b.mode === 'exclusive'))));
        return { ...view(t), blockers: blockers.map(view), recovery: queue.receipt(t).recovery };
    });
    console.log(JSON.stringify({ at: new Date().toISOString(), readOnly: true, machineID: r.machineID, workerID: r.id,
        runtime, policy: queue.policy, counts: Object.fromEntries([...new Set(tasks.map(t => t.state))].map(s => [s, tasks.filter(t => t.state === s).length])),
        globalHolders, waiting, uncertain: active.filter(t => t.state === 'blocked' || t.reason).map(view) }, null, 2));
    if (strict && globalHolders.length) process.exitCode = 2;
} catch (error) { console.error(error instanceof Error ? error.message : 'QUEUE_CHECK_FAILED'); process.exitCode = 1; }
