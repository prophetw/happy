#!/usr/bin/env python3
"""One operator-approved existing-machine transition, run by an independent root oneshot.
Only daemon metadata is read here. Account credentials are left to the normal Happy client.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import time
import urllib.request

UNIT = 'happy-automation-worker.service'
STATE = pathlib.Path('/home/dev/.happy/daemon.state.json')
LOCK = pathlib.Path('/home/dev/.happy/daemon.state.json.lock')
NODE = '/home/dev/.local/share/pnpm/node'
OLD_BUNDLE = '/home/dev/code/happy/packages/happy-cli/dist/index.mjs'


def command(args):
    r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=35)
    if r.returncode:
        raise RuntimeError('OPERATOR_ACTION_REJECTED')
    return r.stdout.strip()


def process(pid):
    p = pathlib.Path('/proc') / str(pid)
    try:
        raw = (p / 'stat').read_text(); tail = raw[raw.rfind(')') + 2:].split()
        if tail[0] in ['Z', 'X']:return None
        return {'pid': pid, 'startTicks': tail[19], 'exe': os.readlink(str(p / 'exe')), 'uid': (p / 'stat').stat().st_uid, 'ppid': int(tail[1]), 'cgroup': (p / 'cgroup').read_text().strip(), 'args': (p / 'cmdline').read_bytes().split(b'\0')}
    except FileNotFoundError:
        return None


def state():
    try:
        s = STATE.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or STATE.is_symlink():
            raise RuntimeError('DAEMON_METADATA_UNVERIFIED')
        value = json.loads(STATE.read_text())
        if not isinstance(value.get('pid'), int) or not isinstance(value.get('httpPort'), int) or not 1024 <= value['httpPort'] <= 65535:
            raise RuntimeError('DAEMON_METADATA_UNVERIFIED')
        return value
    except FileNotFoundError:
        return None


def local(port, route):
    request = urllib.request.Request('http://127.0.0.1:' + str(port) + route, data=b'{}', headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=2) as response:
        return json.load(response)


def sync_dir(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)


class Transition:
    def __init__(self, plan):
        self.plan = plan
        self.directory = pathlib.Path(plan['directory'])
        self.report = {'version': 1, 'operation': plan['operation'], 'stages': [], 'newHappyDevice': False, 'realGrantCreated': False}
        self.known = set()
        self.old_stopped = False
        self.start_us = None
        self.invocations = set()

    def record(self, stage, **values):
        self.report.update(values);self.report['stage'] = stage;self.report['stages'].append({'stage': stage, 'at': int(time.time())})
        temp = self.directory / 'status.pending.json';path = self.directory / 'status.json'
        temp.write_text(json.dumps(self.report, indent=2) + chr(10));os.chmod(str(temp), 0o600)
        with open(str(temp), 'rb') as stream:os.fsync(stream.fileno())
        os.replace(str(temp), str(path));sync_dir(self.directory)

    def unit(self):
        raw = command(['systemctl', 'show', UNIT, '-p', 'MainPID', '-p', 'ExecMainPID', '-p', 'ActiveState', '-p', 'SubState', '-p', 'InvocationID', '-p', 'ExecMainStartTimestampMonotonic'])
        value = dict(line.split('=', 1) for line in raw.splitlines())
        invocation = value.get('InvocationID', '')
        if self.start_us is not None and re.fullmatch('[a-f0-9]{32}', invocation) and int(value.get('ExecMainStartTimestampMonotonic', '0')) >= self.start_us:
            self.invocations.add(invocation)
            for key in ['MainPID', 'ExecMainPID']:
                pid = int(value.get(key, '0'))
                if pid > 0:
                    live = process(pid)
                    if live and (live['uid'] != 1000 or (self.plan['workerEntry'].encode() not in live['args'])):
                        raise RuntimeError('WORKER_UNIT_PROCESS_IDENTITY_CHANGED')
                    self.known.add(pid)
        return value

    def worker_connected(self, invocation):
        if not re.fullmatch('[a-f0-9]{32}', invocation):return False
        raw = command(['journalctl', '_SYSTEMD_INVOCATION_ID=' + invocation, '-n', '30', '-o', 'cat', '--no-pager'])
        for line in raw.splitlines():
            try:value = json.loads(line)
            except ValueError:continue
            if value.get('event') == 'automation-worker' and value.get('state') == 'connected':return True
        return False

    def archive_attributable_metadata(self):
        # Recovery is limited to dead, positively identified owners in THIS transaction.
        # A changed/unknown lock or any live daemon prevents rollback; there is no retry-steal loop.
        for pid in self.known:
            if process(pid):raise RuntimeError('TRANSACTION_OWNER_STILL_PRESENT')
        for p in pathlib.Path('/proc').iterdir():
            if not p.name.isdigit():continue
            observed = process(int(p.name))
            if not observed:continue
            args = observed['args']
            if (b'daemon' in args and b'start-sync' in args) or any(a.endswith(b'/bin/happy-control-worker.mjs') for a in args):
                raise RuntimeError('OTHER_DAEMON_OWNER_PRESENT')
        pending=[]
        for path, kind in [(STATE, 'state'), (LOCK, 'lock')]:
            if not path.exists():continue
            s = path.lstat()
            if path.is_symlink() or not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != 1000 or s.st_dev != self.directory.stat().st_dev:
                raise RuntimeError('TRANSACTION_METADATA_UNVERIFIED')
            raw = path.read_bytes();pid = json.loads(raw)['pid'] if kind == 'state' else int(raw.decode().strip())
            if pid not in self.known:raise RuntimeError('TRANSACTION_METADATA_OWNER_CHANGED')
            digest = hashlib.sha256(raw).hexdigest();target = self.directory / ('retired-' + kind + '-' + str(pid))
            if target.exists():raise RuntimeError('TRANSACTION_RECOVERY_ALREADY_USED')
            pending.append((path,s,digest,target,pid))
        for path,s,digest,target,pid in pending:
            current = path.lstat()
            if current.st_ino != s.st_ino or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise RuntimeError('TRANSACTION_METADATA_CHANGED')
            os.rename(str(path), str(target));sync_dir(path.parent);sync_dir(self.directory)
            self.record('known-transaction-metadata-archived', archivedMetadataOwner=pid)

    def rollback(self):
        current=self.unit()
        if int(current.get('MainPID','0')) and current.get('InvocationID') not in self.invocations:
            raise RuntimeError('WORKER_INVOCATION_NOT_OWNED')
        command(['systemctl', 'stop', UNIT]);command(['systemctl', 'disable', UNIT])
        self.unit()
        self.archive_attributable_metadata()
        args = ['runuser', '-u', 'dev', '--', NODE, '--no-warnings', '--no-deprecation', OLD_BUNDLE, 'daemon', 'start-sync']
        env = dict(self.plan['originalEnvironment']);env.update({'HOME': '/home/dev', 'USER': 'dev', 'HAPPY_HOME_DIR': '/home/dev/.happy', 'HAPPY_SERVER_URL': self.plan['relayURL']})
        child = subprocess.Popen(args, env=env, cwd='/home/dev', stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        end = time.monotonic() + 35
        while time.monotonic() < end:
            value = state()
            if value and process(value['pid']):
                try:
                    status = local(value['httpPort'], '/status')
                    restored=process(value['pid'])
                    if status.get('connected') and status.get('machineId') == self.plan['machineID'] and restored and restored['uid']==1000 and OLD_BUNDLE.encode() in restored['args'] and b'daemon' in restored['args'] and b'start-sync' in restored['args'] and restored['ppid']==child.pid:
                        self.record('original-daemon-restored', restoredPID=value['pid'], restoredStartTicks=restored['startTicks'], workerEnabled=False);return
                except Exception:pass
            if child.poll() is not None:break
            time.sleep(0.5)
        raise RuntimeError('ORIGINAL_DAEMON_RESTORE_UNCONFIRMED')

    def run(self):
        old = process(self.plan['oldPID']);value = state()
        if not old or old['startTicks'] != self.plan['oldStartTicks'] or OLD_BUNDLE.encode() not in old['args'] or old['uid'] != 1000 or old['exe'] != str(pathlib.Path(NODE).resolve()) or b'daemon' not in old['args'] or b'start-sync' not in old['args'] or not value or value['pid'] != old['pid']:
            raise RuntimeError('OLD_DAEMON_IDENTITY_CHANGED')
        own_unit=self.plan['supervisorUnit']
        if not re.fullmatch('happy-automation-maintenance-[A-Za-z0-9-]+[.]service', own_unit) or command(['systemctl','show',own_unit,'-p','KillMode','--value'])!='process':
            raise RuntimeError('RECOVERY_SUPERVISOR_KILL_MODE_UNSAFE')
        if process(os.getpid())['cgroup'] == old['cgroup']:
            raise RuntimeError('RECOVERY_RUNNER_NOT_ISOLATED')
        target=self.unit()
        if int(target.get('MainPID','0')) or target.get('ActiveState') in ['active','activating'] or target.get('SubState')=='auto-restart':
            raise RuntimeError('WORKER_UNIT_ALREADY_RUNNING')
        self.known.add(old['pid']);self.record('preflight', originalDaemonPID=old['pid'], independentRecoveryCgroup=True)
        status = local(value['httpPort'], '/status')
        if not status.get('connected') or status.get('machineId') != self.plan['machineID']:
            raise RuntimeError('ORIGINAL_DAEMON_NOT_READY')
        baseline=[]
        for item in local(value['httpPort'], '/list').get('children', []):
            seen=process(item['pid'])
            if seen:baseline.append({k:seen[k] for k in ['pid','startTicks','cgroup']})
        self.report['originalSessionProcessCount']=len(baseline)
        self.record('requesting-original-graceful-stop')
        try:local(value['httpPort'], '/stop')
        except Exception:pass  # The owner may close the HTTP response while exiting; observe PID/state.
        end=time.monotonic()+15
        while process(old['pid']) and time.monotonic()<end:time.sleep(0.2)
        if process(old['pid']):raise RuntimeError('OLD_DAEMON_DID_NOT_STOP_NO_FORCE_USED')
        self.old_stopped=True;self.record('original-daemon-exited')
        if STATE.exists() or LOCK.exists():self.archive_attributable_metadata()
        try:
            if self.unit().get('ActiveState') == 'failed':command(['systemctl','reset-failed',UNIT])
            self.start_us=int(time.monotonic()*1000000);command(['systemctl','start',UNIT]);self.record('new-worker-start-requested')
            end=time.monotonic()+45
            while time.monotonic()<end:
                unit=self.unit();current=state()
                if unit.get('ActiveState')=='failed':break
                if current and current['pid']==int(unit.get('MainPID','0')):
                    try:
                        status=local(current['httpPort'],'/status')
                        if status.get('connected') and status.get('machineId')==self.plan['machineID'] and self.worker_connected(unit.get('InvocationID','')):break
                    except Exception:pass
                time.sleep(0.5)
            else:raise RuntimeError('NEW_WORKER_READINESS_TIMEOUT')
            unit=self.unit();current=state()
            if unit.get('ActiveState')!='active' or not current or current['pid']!=int(unit['MainPID']) or not self.worker_connected(unit.get('InvocationID','')):
                raise RuntimeError('NEW_WORKER_NOT_READY')
            changed=[]
            for before in baseline:
                after=process(before['pid'])
                if not after or after['startTicks']!=before['startTicks'] or after['cgroup']!=before['cgroup']:changed.append(before['pid'])
            if changed:
                self.record('original-session-change-unconfirmed', changedOriginalSessionPIDs=changed)
                raise RuntimeError('ORIGINAL_SESSION_CHANGE_UNCONFIRMED')
            command(['systemctl','enable',UNIT])
            self.record('worker-connected', workerPID=current['pid'], workerEnabled=True, unchangedOriginalSessions=len(baseline)-len(changed), changedOriginalSessionPIDs=changed, userApprovalPending=True)
        except Exception:
            self.record('new-worker-failed-starting-rollback');self.rollback();raise RuntimeError('WORKER_REJECTED_ORIGINAL_RESTORED')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--plan',required=True);args=parser.parse_args()
    if os.geteuid()!=0:raise RuntimeError('ROOT_OPERATOR_REQUIRED')
    path=pathlib.Path(args.plan);s=path.lstat()
    if path.is_symlink() or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode&0o077:raise RuntimeError('PRIVATE_PLAN_REQUIRED')
    plan=json.loads(path.read_text());directory=pathlib.Path(plan['directory']);info=directory.lstat()
    if directory.is_symlink() or info.st_uid!=0 or info.st_mode&0o077 or info.st_dev!=STATE.parent.stat().st_dev:
        raise RuntimeError('PRIVATE_RECOVERY_DIRECTORY_REQUIRED')
    transition=Transition(plan)
    try:transition.run()
    except Exception as error:
        code=str(error) if isinstance(error,RuntimeError) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'TRANSITION_UNCONFIRMED'
        transition.record('failed',errorCode=code)
        raise SystemExit(1)

if __name__=='__main__':main()
