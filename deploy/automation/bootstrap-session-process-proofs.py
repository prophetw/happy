#!/usr/bin/env python3
"""One local-admin import from successful Worker maintenance evidence; no task/lock changes."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess

MAINTENANCE_ROOT = pathlib.Path('/var/lib/happy-automation-maintenance')
RELEASE_ROOT = pathlib.Path('/home/dev/.local/share/happy-automation/releases')
CONFIG = pathlib.Path('/etc/happy-control/worker.json')


def private_json(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077 or path.resolve() != path:
        raise RuntimeError('PRIVATE_ROOT_EVIDENCE_REQUIRED')
    return json.loads(path.read_text())


def identity(pid):
    if not isinstance(pid, int) or pid <= 0:
        raise RuntimeError('PROCESS_ID_REQUIRED')
    root = pathlib.Path('/proc') / str(pid)
    before = (root / 'stat').read_text().rsplit(') ', 1)[1].split()
    value = {'pid': pid, 'uid': root.stat().st_uid,
             'bootID': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
             'startTicks': before[19], 'cwd': str((root / 'cwd').resolve(strict=True)),
             'cgroup': (root / 'cgroup').read_text()}
    after = (root / 'stat').read_text().rsplit(') ', 1)[1].split()
    if before[19] != after[19] or after[0] in ['Z', 'X'] or root.stat().st_uid != value['uid'] or pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() != value['bootID']:
        raise RuntimeError('PROCESS_IDENTITY_CHANGED')
    return value


def prepare(maintenance, release, session_ids):
    if os.geteuid() != 0:
        raise RuntimeError('LOCAL_ROOT_REQUIRED')
    info = maintenance.lstat()
    if maintenance.resolve() != maintenance or maintenance.parent != MAINTENANCE_ROOT or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError('PRIVATE_MAINTENANCE_DIRECTORY_REQUIRED')
    if release.resolve() != release or release.parent != RELEASE_ROOT:
        raise RuntimeError('FIXED_RELEASE_REQUIRED')
    plan, status = private_json(maintenance / 'plan.json'), private_json(maintenance / 'status.json')
    before = private_json(maintenance / 'session-baseline.json')
    if status.get('success') is not True or status.get('phase') != 'worker-connected' or status.get('changedOriginalSessionPIDs') != []:
        raise RuntimeError('SUCCESSFUL_UNCHANGED_MAINTENANCE_REQUIRED')
    props = dict(line.split('=', 1) for line in subprocess.check_output([
        'systemctl', 'show', 'happy-automation-worker.service', '-p', 'MainPID', '-p', 'InvocationID', '-p', 'User', '-p', 'KillMode'], text=True).splitlines())
    worker = status['worker']
    worker_identity = identity(worker['pid'])
    if props['User'] != 'dev' or props['KillMode'] != 'process' or int(props['MainPID']) != worker['pid'] or props['InvocationID'] != worker['invocationID'] or worker_identity['uid'] != 1000 or worker_identity['startTicks'] != worker['startTicks']:
        raise RuntimeError('MAINTENANCE_WORKER_CHANGED')
    config_info = CONFIG.lstat()
    config_bytes = CONFIG.read_bytes()
    if not stat.S_ISREG(config_info.st_mode) or config_info.st_nlink != 1 or CONFIG.resolve() != CONFIG or (config_info.st_uid, config_info.st_gid, config_info.st_mode & 0o777) != (plan['configUID'], plan['configGID'], plan['configMode']) or hashlib.sha256(config_bytes).hexdigest() != plan['candidateConfigSHA256']:
        raise RuntimeError('MAINTENANCE_REGISTRATION_CHANGED')
    config = json.loads(config_bytes)
    if config['registration']['machineID'] != plan['machineID']:
        raise RuntimeError('MACHINE_BINDING_CHANGED')
    saved = json.loads((pathlib.Path(config['happyHomeDirectory']) / 'sessions.json').read_text())['sessions']
    selected = []
    for session_id in session_ids:
        if not re.fullmatch('[A-Za-z0-9_-]{1,128}', session_id):
            raise RuntimeError('SESSION_ID_REQUIRED')
        metadata = saved[session_id]['metadata']
        current = identity(metadata['hostPid'])
        if current['uid'] != 1000 or metadata.get('machineId') != plan['machineID'] or current['cwd'] != metadata.get('path'):
            raise RuntimeError('SESSION_PROCESS_BINDING_CHANGED')
        if not os.path.isdir(current['cwd']) or os.path.realpath(current['cwd']) != current['cwd']:
            raise RuntimeError('CANONICAL_DIRECTORY_REQUIRED')
        for baseline in [plan['protectedProcesses'], before]:
            matches = [item for item in baseline if item['pid'] == current['pid']]
            if len(matches) != 1 or any(matches[0][key] != current[key] for key in ['startTicks', 'cgroup']):
                raise RuntimeError('MAINTENANCE_PROCESS_BINDING_CHANGED')
        selected.append({'sessionID': session_id, 'identity': current})
    entry = release / 'packages/happy-agent/bin/happy-session-process-proof.mjs'
    if not entry.is_file() or entry.resolve() != entry:
        raise RuntimeError('FIXED_IMPORT_ENTRY_REQUIRED')
    node = str((pathlib.Path('/proc') / str(worker['pid']) / 'exe').resolve(strict=True))
    if node != plan['nodeExecutable'] or worker['entry'].encode() not in (pathlib.Path('/proc') / str(worker['pid']) / 'cmdline').read_bytes().split(b'\0'):
        raise RuntimeError('MAINTENANCE_WORKER_EXECUTABLE_CHANGED')
    payload = {'machineID': plan['machineID'], 'sessions': selected}
    if len((json.dumps(payload) + '\n').encode()) > 65536:
        raise RuntimeError('BOOTSTRAP_INPUT_TOO_LARGE')
    return [ 'runuser', '-u', 'dev', '--', node, str(entry), '--record-verified' ], payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--maintenance', required=True, type=pathlib.Path)
    parser.add_argument('--release', required=True, type=pathlib.Path)
    parser.add_argument('--session', action='append', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if len(args.session) > 100 or len(set(args.session)) != len(args.session):
        raise RuntimeError('DISTINCT_BOUNDED_SESSIONS_REQUIRED')
    command, payload = prepare(args.maintenance, args.release, args.session)
    if not args.apply:
        print(json.dumps({'status': 'verified_not_imported', 'machineID': payload['machineID'], 'sessions': payload['sessions']}))
        return
    # The normal dev identity writes private material; root never bypasses privateFs.
    subprocess.run(command, input=json.dumps(payload) + '\n', text=True, check=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        raise SystemExit(code if isinstance(error, RuntimeError) and re.fullmatch('[A-Z0-9_]+', code) else 'SESSION_PROCESS_BOOTSTRAP_REJECTED')
