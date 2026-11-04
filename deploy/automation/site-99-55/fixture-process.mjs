import { spawn } from 'node:child_process';

/** A stop prevents subsequent work; teardown explicitly opts in. Signals/timeouts are never success. */
export class FixtureProcesses {
    stopping = false;
    active = new Set();
    cleanupChildren = new WeakSet();
    controller = new AbortController();
    get signal() { return this.controller.signal; }
    check() { if (this.stopping) throw Object.assign(Error('FIXTURE_STOPPED'), { code: 'FIXTURE_STOPPED' }); }
    delay(ms, {cleanup = false} = {}) {
        if (this.stopping && !cleanup) return Promise.reject(Object.assign(Error('FIXTURE_STOPPED'), {code:'FIXTURE_STOPPED'}));
        return new Promise((resolve, reject) => {
            const finish = () => { this.signal.removeEventListener('abort', abort); resolve(); };
            const timer = setTimeout(finish, ms);
            const abort = () => { clearTimeout(timer); reject(Object.assign(Error('FIXTURE_STOPPED'), {code:'FIXTURE_STOPPED'})); };
            if (!cleanup) this.signal.addEventListener('abort', abort, {once:true});
        });
    }
    stop() {
        if (this.stopping) return;
        this.stopping = true;
        this.controller.abort();
        for (const child of this.active) {
            if (this.cleanupChildren.has(child)) continue;
            child.kill('SIGTERM');
            const force = setTimeout(() => { if (this.active.has(child)) child.kill('SIGKILL'); }, 1500);
            force.unref();
        }
    }
    run(executable, args, { cwd, env, timeout = 30000, allowFailure = false, cleanup = false } = {}) {
        if (this.stopping && !cleanup) return Promise.reject(Object.assign(Error('FIXTURE_STOPPED'), { code: 'FIXTURE_STOPPED' }));
        return new Promise((resolve, reject) => {
            const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
            this.active.add(child);
            if (cleanup) this.cleanupChildren.add(child);
            let output = '', error = '', timedOut = false, settled = false;
            const finish = (code, signal, spawnError) => {
                if (settled) return; settled = true; clearTimeout(timer); clearTimeout(forceTimer); this.active.delete(child);
                const result = { code, signal, timedOut, output, error };
                if ((this.stopping && !cleanup) || timedOut || signal || spawnError || (code !== 0 && !allowFailure)) {
                    const kind = this.stopping && !cleanup ? 'FIXTURE_STOPPED' : timedOut ? 'COMMAND_TIMEOUT' : signal ? 'COMMAND_SIGNAL' : spawnError ? 'COMMAND_SPAWN_FAILED' : 'COMMAND_EXIT_FAILED';
                    reject(Object.assign(Error(kind), { code: kind, result }));
                } else resolve(result);
            };
            let forceTimer;
            const timer = setTimeout(() => {
                timedOut = true; child.kill('SIGTERM');
                forceTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
            }, timeout);
            child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
            child.on('error', error => finish(null, null, error)); child.on('close', (code, signal) => finish(code, signal));
        });
    }
}
