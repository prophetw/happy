#!/usr/bin/env python3
"""One approved managed-worker release switch. No login, key access, task or lock stealing."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import subprocess
import tempfile
import tarfile
import time
import urllib.request

UNIT = 'happy-automation-worker.service'
STATE = pathlib.Path('/home/dev/.happy/daemon.state.json')
LOCK = pathlib.Path('/home/dev/.happy/daemon.state.json.lock')
CONFIG = pathlib.Path('/etc/happy-control/worker.json')


def safe_data_filter(member, destination):
    """Keep data_filter checks; correct older Python's root-relative symlink target check."""
    if not member.issym(): return tarfile.data_filter(member, destination)
    if os.path.isabs(member.linkname): raise RuntimeError('ABSOLUTE_ARCHIVE_LINK')
    root = os.path.realpath(destination)
    target = os.path.realpath(os.path.join(root, os.path.dirname(member.name), member.linkname))
    if os.path.commonpath([root, target]) != root: raise RuntimeError('ARCHIVE_LINK_OUTSIDE_RELEASE')
    # Validate all standard name/type/permission rules with the equivalent root-relative target,
    # then preserve the original relative link semantics for extraction.
    checked = tarfile.data_filter(member.replace(linkname=os.path.relpath(target, root)), destination)
    return checked.replace(linkname=member.linkname)


def command(args, timeout=45):
    r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
    if r.returncode: raise RuntimeError('COMMAND_REJECTED')
    return r.stdout.strip()


def sha(path): return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def atomic(path, data, mode=0o600, uid=0, gid=0, identity=None):
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=str(path.parent))
    try:
        os.fchmod(fd, mode); os.fchown(fd, uid, gid)
        if identity is not None:
            info = os.fstat(fd); identity.update({'dev': info.st_dev, 'ino': info.st_ino})
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, str(path)); sync(path.parent)
    finally:
        if os.path.lexists(name): os.unlink(name)


def sync(directory):
    fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def process(pid):
    try:
        path = pathlib.Path('/proc') / str(pid); raw = (path / 'stat').read_text(); tail = raw[raw.rfind(')') + 2:].split()
        if tail[0] in ['Z', 'X']: return None
        return {'pid': pid, 'startTicks': tail[19], 'exe': os.readlink(str(path / 'exe')), 'uid': path.stat().st_uid,
                'cgroup': (path / 'cgroup').read_text(), 'args': (path / 'cmdline').read_bytes().split(b'\0')}
    except FileNotFoundError: return None


def unit():
    raw = command(['systemctl', 'show', UNIT, '-p', 'MainPID', '-p', 'ExecMainPID', '-p', 'ActiveState', '-p', 'SubState', '-p', 'KillMode', '-p', 'User', '-p', 'InvocationID', '-p', 'ExecMainStartTimestampMonotonic', '-p', 'DropInPaths'])
    return dict(s.split('=', 1) for s in raw.splitlines())


def metadata():
    if not STATE.exists(): return None
    info = STATE.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 1000 or info.st_nlink != 1: raise RuntimeError('UNSAFE_DAEMON_METADATA')
    return json.loads(STATE.read_text())


def local(port, route):
    if not isinstance(port, int) or not 1024 <= port <= 65535: raise RuntimeError('INVALID_METADATA_PORT')
    req = urllib.request.Request('http://127.0.0.1:' + str(port) + route, data=b'{}', headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=3) as response: return json.load(response)


class Switch:
    def __init__(self, plan):
        self.plan = plan; self.root = pathlib.Path(plan['directory']); self.dropin = pathlib.Path(plan['dropin'])
        self.report = {'version': 1, 'phase': 'initial', 'success': False, 'rollback': 'not-needed', 'accountOrGrantCreated': False}
        self.stop_attempted = False; self.installed = False; self.install_attempted = False; self.dropin_identity = {}; self.baseline = []
        self.owner = {'pid': plan['oldPID'], 'startTicks': plan['oldStartTicks'], 'entry': plan['oldEntry'], 'invocationID': plan['oldInvocationID']}

    def record(self, phase, **values):
        self.report.update(values); self.report['phase'] = phase
        atomic(self.root / 'status.json', (json.dumps(self.report, indent=2) + '\n').encode())

    def verify_base(self):
        if sha(self.plan['unitFragment']) != self.plan['unitSHA256']: raise RuntimeError('UNIT_CHANGED')
        u = unit()
        if u['KillMode'] != 'process' or u['User'] != 'dev': raise RuntimeError('UNIT_PROCESS_BOUNDARY_CHANGED')
        prior = self.plan.get('priorDropIns', [])
        for existing in prior:
            path = pathlib.Path(existing['path']); info = path.lstat()
            if path == self.dropin or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or sha(path) != existing['sha256']: raise RuntimeError('PRIOR_DROPIN_CHANGED')
        baseline = ' '.join(sorted(existing['path'] for existing in prior))
        installed = ' '.join(sorted([existing['path'] for existing in prior] + [str(self.dropin)]))
        expected = [baseline, installed] if self.install_attempted else [baseline]
        if u['DropInPaths'].strip() not in expected: raise RuntimeError('UNOWNED_UNIT_DROPIN')
        return u

    def candidate_files(self):
        root = pathlib.Path(self.plan['release'])
        if root.is_symlink() or not str(root).startswith('/home/dev/.local/share/happy-automation/releases/'): raise RuntimeError('UNSAFE_RELEASE')
        for relative, digest in self.plan['fileHashes'].items():
            path = root / relative
            if not str(path.resolve()).startswith(str(root.resolve()) + '/') or sha(path) != digest: raise RuntimeError('CANDIDATE_CHANGED')
        if sha(self.root / 'candidate-worker.json') != self.plan['candidateConfigSHA256'] or sha(self.root / 'before-worker.json') != self.plan['oldConfigSHA256']: raise RuntimeError('CONFIG_CANDIDATE_CHANGED')
        if sha(self.root / 'candidate-release.conf') != self.plan['dropinSHA256']: raise RuntimeError('DROPIN_CANDIDATE_CHANGED')
        before = json.loads((self.root / 'before-worker.json').read_text()); after = json.loads((self.root / 'candidate-worker.json').read_text())
        if self.plan.get('configChange') == 'directory-selection':
            if self.plan.get('authorizedDirectoryRoots') != ['/home/dev/code'] or 'directorySelection' in before['registration'] or self.plan.get('expectedDirectorySelection') is not None: raise RuntimeError('UNAPPROVED_DIRECTORY_POLICY')
            before['registration']['directorySelection'] = {'roots': self.plan['authorizedDirectoryRoots']}
        else:
            before['registration']['projects'] = self.plan['candidateProjects']
        if before != after: raise RuntimeError('UNEXPECTED_WORKER_CONFIG_DELTA')

    def config_metadata(self):
        info = CONFIG.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (info.st_uid, info.st_gid, info.st_mode & 0o777) != (self.plan['configUID'], self.plan['configGID'], self.plan['configMode']): raise RuntimeError('LIVE_CONFIG_OWNERSHIP_CHANGED')

    def owned_unit(self, expected_entry):
        u = self.verify_base(); pid = int(u['MainPID']); owner = self.owner
        if pid == 0:
            if u['InvocationID'] not in ['', owner['invocationID']] or (u['ActiveState'] not in ['inactive', 'failed'] and not (u['SubState'] == 'auto-restart' and u['InvocationID'] == owner['invocationID'])): raise RuntimeError('UNOWNED_WORKER_INVOCATION')
            return u
        p = process(pid)
        if not p or pid != owner['pid'] or p['startTicks'] != owner['startTicks'] or u['InvocationID'] != owner['invocationID'] or owner['entry'] != expected_entry or p['uid'] != 1000 or expected_entry.encode() not in p['args'] or p['exe'] != self.plan['nodeExecutable']: raise RuntimeError('UNOWNED_WORKER_INVOCATION')
        return u

    def capture_started(self, entry, started_us):
        end = time.monotonic() + 8; invocation = None
        while time.monotonic() < end:
            u = self.verify_base(); pid = int(u['MainPID']); started = int(u['ExecMainStartTimestampMonotonic']); observed = u['InvocationID']
            if invocation is None and re.fullmatch('[a-f0-9]{32}', observed) and started >= started_us:
                invocation = observed
                # Pin the first invocation before waiting for exec; a rapid failed process is still attributable.
                self.owner = {'pid': pid or int(u.get('ExecMainPID', '0')), 'startTicks': None, 'entry': entry, 'invocationID': invocation}
            if invocation is not None:
                if observed not in [invocation, '']: raise RuntimeError('UNOWNED_WORKER_INVOCATION')
                if pid:
                    p = process(pid)
                    if p:
                        if self.owner['startTicks'] is not None and (pid != self.owner['pid'] or p['startTicks'] != self.owner['startTicks']): raise RuntimeError('UNOWNED_WORKER_INVOCATION')
                        self.owner.update({'pid': pid, 'startTicks': p['startTicks']})
                        if p['uid'] == 1000 and entry.encode() in p['args'] and p['exe'] == self.plan['nodeExecutable']: return
                elif u['ActiveState'] == 'failed' or u['SubState'] == 'auto-restart': raise RuntimeError('STARTED_WORKER_EXITED')
            time.sleep(0.1)
        raise RuntimeError('STARTED_WORKER_NOT_IDENTIFIED')

    def reconcile_dropin(self):
        if not self.install_attempted: return
        if not os.path.lexists(str(self.dropin)):
            self.installed = False; return
        info = self.dropin.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_dev != self.dropin_identity.get('dev') or info.st_ino != self.dropin_identity.get('ino') or sha(self.dropin) != self.plan['dropinSHA256']: raise RuntimeError('DROPIN_OWNERSHIP_CHANGED')
        self.installed = True

    def stop(self, expected_entry):
        u = self.owned_unit(expected_entry); pid = int(u['MainPID'])
        command(['systemctl', 'stop', UNIT], timeout=45)
        if pid and process(pid): raise RuntimeError('WORKER_DID_NOT_EXIT')
        if os.path.lexists(str(STATE)) or os.path.lexists(str(LOCK)): raise RuntimeError('OWNER_METADATA_NOT_RELEASED')

    def ready(self, entry, old_pid):
        end = time.monotonic() + 55
        while time.monotonic() < end:
            u = self.owned_unit(entry); pid = int(u['MainPID']); p = process(pid) if pid else None; m = metadata()
            if p and p['uid'] == 1000 and pid != old_pid and entry.encode() in p['args'] and p['exe'] == self.plan['nodeExecutable'] and m and m.get('pid') == pid:
                try: status = local(m['httpPort'], '/status')
                except OSError:
                    time.sleep(0.5); continue
                raw = command(['journalctl', '_SYSTEMD_INVOCATION_ID=' + u['InvocationID'], '-n', '50', '-o', 'cat', '--no-pager'])
                events = []
                for line in raw.splitlines():
                    try: events.append(json.loads(line))
                    except ValueError: pass
                if status.get('connected') and status.get('machineId') == self.plan['machineID'] and any(e.get('event') == 'automation-worker' and e.get('state') == 'connected' for e in events):
                    return {'pid': pid, 'startTicks': p['startTicks'], 'entry': entry, 'invocationID': u['InvocationID']}
            time.sleep(0.5)
        raise RuntimeError('WORKER_READINESS_TIMEOUT')

    def changed_sessions(self):
        changed = []
        for before in self.baseline:
            after = process(before['pid'])
            if not after or after['startTicks'] != before['startTicks'] or after['cgroup'] != before['cgroup']: changed.append(before['pid'])
        return changed

    def run(self):
        self.record('preflight'); self.candidate_files(); u = self.verify_base(); old = process(self.plan['oldPID']); m = metadata()
        if not old or old['startTicks'] != self.plan['oldStartTicks'] or self.plan['oldEntry'].encode() not in old['args'] or old['exe'] != self.plan['nodeExecutable'] or old['uid'] != 1000 or int(u['MainPID']) != old['pid'] or not m or m.get('pid') != old['pid']: raise RuntimeError('OLD_WORKER_IDENTITY_CHANGED')
        self.config_metadata()
        if sha(CONFIG) != self.plan['oldConfigSHA256'] or os.path.lexists(str(self.dropin)): raise RuntimeError('LIVE_CONFIG_CHANGED')
        me = process(os.getpid())
        supervisor = dict(line.split('=', 1) for line in command(['systemctl', 'show', self.plan['supervisorUnit'], '-p', 'KillMode', '-p', 'MainPID', '-p', 'ControlGroup']).splitlines())
        if not me or me['cgroup'] == old['cgroup'] or supervisor['KillMode'] != 'process' or int(supervisor['MainPID']) != os.getpid() or supervisor['ControlGroup'] not in [line.split(':', 2)[-1] for line in me['cgroup'].splitlines()]: raise RuntimeError('SUPERVISOR_NOT_ISOLATED')
        status = local(m['httpPort'], '/status')
        if not status.get('connected') or status.get('machineId') != self.plan['machineID']: raise RuntimeError('OLD_WORKER_NOT_READY')
        for child in local(m['httpPort'], '/list').get('children', []):
            p = process(child['pid'])
            if p: self.baseline.append({k: p[k] for k in ['pid', 'startTicks', 'cgroup']})
        atomic(self.root / 'session-baseline.json', (json.dumps(self.baseline, indent=2) + '\n').encode())
        self.record('stopping-old-worker', protectedSessionCount=len(self.baseline)); self.stop_attempted = True
        self.stop(self.plan['oldEntry']); self.record('installing-candidate')
        # Existing account credentials and signer providers are untouched; only the reviewed public registration delta changes.
        atomic(CONFIG, (self.root / 'candidate-worker.json').read_bytes(), self.plan['configMode'], self.plan['configUID'], self.plan['configGID'])
        self.dropin.parent.mkdir(mode=0o755, exist_ok=True); self.install_attempted = True
        atomic(self.dropin, (self.root / 'candidate-release.conf').read_bytes(), identity=self.dropin_identity); self.reconcile_dropin()
        command(['systemctl', 'daemon-reload']); self.record('starting-new-worker'); started_us = int(time.monotonic() * 1000000);
        try: command(['systemctl', 'start', UNIT])
        finally: self.capture_started(self.plan['newEntry'], started_us)
        fresh = self.ready(self.plan['newEntry'], self.plan['oldPID']); changed = self.changed_sessions()
        self.record('worker-connected' if not changed else 'worker-connected-session-change-unconfirmed', success=not changed, worker=fresh, changedOriginalSessionPIDs=changed, originalSessionCount=len(self.baseline))
        return not changed

    def recover(self):
        if not self.stop_attempted:
            self.record('preflight-failed', rollback='not-needed'); return
        self.record('recovering-original-worker', rollback='pending'); self.reconcile_dropin()
        self.stop(self.plan['newEntry'] if self.installed else self.plan['oldEntry'])
        if self.installed:
            if self.dropin.is_symlink() or sha(self.dropin) != self.plan['dropinSHA256']: raise RuntimeError('DROPIN_OWNERSHIP_CHANGED')
            self.dropin.unlink(); sync(self.dropin.parent); self.installed = False; self.install_attempted = False
        # No credential or journal restore. Only this transaction's public registration delta is withdrawn.
        self.config_metadata()
        if sha(CONFIG) not in [self.plan['oldConfigSHA256'], self.plan['candidateConfigSHA256']]: raise RuntimeError('WORKER_CONFIG_OWNERSHIP_CHANGED')
        atomic(CONFIG, (self.root / 'before-worker.json').read_bytes(), self.plan['configMode'], self.plan['configUID'], self.plan['configGID']); command(['systemctl', 'daemon-reload']); started_us = int(time.monotonic() * 1000000);
        try: command(['systemctl', 'start', UNIT])
        finally: self.capture_started(self.plan['oldEntry'], started_us)
        restored = self.ready(self.plan['oldEntry'], self.plan['oldPID']); changed = self.changed_sessions()
        self.record('original-worker-restored', rollback='restored-current-state-preserved', restoredWorker=restored, changedOriginalSessionPIDs=changed)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--plan', required=True); args = parser.parse_args(); path = pathlib.Path(args.plan)
    info = path.lstat()
    if os.geteuid() != 0 or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077: raise RuntimeError('PRIVATE_ROOT_PLAN_REQUIRED')
    plan = json.loads(path.read_text())
    if not re.fullmatch('happy-automation-maintenance-[A-Za-z0-9-]+[.]service', plan['supervisorUnit']): raise RuntimeError('SUPERVISOR_IDENTITY_REQUIRED')
    root = pathlib.Path(plan['directory']); info = root.lstat()
    if root.is_symlink() or info.st_uid != 0 or info.st_mode & 0o077: raise RuntimeError('PRIVATE_RECOVERY_DIRECTORY_REQUIRED')
    switch = Switch(plan)
    def interrupted(_sig, _frame): raise RuntimeError('MAINTENANCE_INTERRUPTED')
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    try:
        if not switch.run(): return 1
        return 0
    except Exception as error:
        switch.record('failed', failurePhase=switch.report['phase'], errorCode=str(error) if isinstance(error, RuntimeError) and re.fullmatch('[A-Z0-9_]+', str(error)) else type(error).__name__)
        try: switch.recover()
        except Exception: switch.record('recovery-unconfirmed', rollback='operator-required')
        return 1

if __name__ == '__main__': raise SystemExit(main())
