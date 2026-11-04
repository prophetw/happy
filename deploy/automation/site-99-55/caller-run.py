#!/usr/bin/env python3
"""Root operator's bounded REST signer adapter. JSON stdin/stdout; no listener or shell input."""
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile

LIMIT = 512 * 1024
BASE = pathlib.Path('/etc/happy-control/secure/assistant')
RUNTIME = pathlib.Path('/run/happy-control-caller')
TOOLS = {'happy_machines', 'happy_sessions', 'happy_create_task', 'happy_send', 'happy_status', 'happy_events', 'happy_result', 'happy_cancel', 'happy_request_status', 'happy_request_connection'}


def failure(code, request=None, uncertain=False):
    value = {'version': 1, 'ok': False, 'error': {'code': code, 'retryable': False}}
    if uncertain:
        value['data'] = {'state': 'unknown'}
        if isinstance(request, dict) and isinstance(request.get('input'), dict):
            request_id = request['input'].get('requestID')
            if isinstance(request_id, str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', request_id):
                value['data']['requestID'] = request_id
    return value


def private(path, directory=False):
    info = path.lstat()
    if path.is_symlink() or path.resolve() != path.absolute() or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError('CALLER_PRIVATE_PATH_REJECTED')
    if directory != stat.S_ISDIR(info.st_mode) or (not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1)):
        raise RuntimeError('CALLER_PRIVATE_PATH_REJECTED')
    return path


def invoke(raw):
    request = None
    directory = None
    uncertain = False
    name = None
    started = False
    completion_observed = False
    result = None
    try:
        if len(raw) > LIMIT:
            return failure('CONTROL_INPUT_TOO_LARGE')
        request = json.loads(raw.decode('utf8'))
        if not isinstance(request, dict) or set(request) != {'tool', 'input'} or request['tool'] not in TOOLS or not isinstance(request['input'], dict):
            return failure('CONTROL_INPUT_INVALID')
        uncertain = request['tool'] in {'happy_create_task', 'happy_send', 'happy_cancel', 'happy_request_connection'}
        if os.geteuid() != 0:
            return failure('CALLER_OPERATOR_REQUIRED')
        private(BASE, True)
        config = json.loads(private(BASE / 'caller.json').read_text())
        runtime_config = json.loads(private(BASE / 'runtime.json').read_text())
        image = runtime_config['image']
        if not re.fullmatch('sha256:[a-f0-9]{64}', image):
            raise RuntimeError('CALLER_IMAGE_PIN_REQUIRED')
        encrypted = private(BASE / 'assistant.encrypted.pem')
        password = private(BASE / 'assistant-key-passphrase')
        if encrypted.stat().st_size > 32768 or password.stat().st_size > 4096:
            raise RuntimeError('CALLER_CREDENTIAL_REJECTED')
        RUNTIME.mkdir(mode=0o700, exist_ok=True)
        private(RUNTIME, True)
        memory = subprocess.run(['stat', '-f', '-c', '%T', str(RUNTIME)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin'})
        if memory.returncode or memory.stdout.strip() != b'tmpfs':
            raise RuntimeError('CALLER_RUNTIME_NOT_MEMORY')
        docker_config = RUNTIME / 'docker-cli';docker_config.mkdir(mode=0o700, exist_ok=True);private(docker_config, True)
        directory = pathlib.Path(tempfile.mkdtemp(prefix='call-', dir=str(RUNTIME)))
        credentials = directory / 'credentials';credentials.mkdir(mode=0o700)
        for source, target in [(encrypted, directory / 'assistant.encrypted.pem'), (password, credentials / 'assistant-key-passphrase')]:
            shutil.copyfile(str(source), str(target));os.chmod(str(target),0o400);os.chown(str(target),1000,1000)
        config['identityRef'] = 'assistant-rest'
        config['secrets'] = {'type': 'encrypted-pkcs8-credentials', 'credentialsDirectory': '/caller/credentials', 'keys': {'assistant-rest': {'encryptedPKCS8': '/caller/assistant.encrypted.pem', 'passphraseCredential': 'assistant-key-passphrase'}}}
        target = directory / 'caller.json';target.write_text(json.dumps(config));os.chmod(str(target),0o400);os.chown(str(target),1000,1000)
        for target in [credentials,directory]:os.chmod(str(target),0o700);os.chown(str(target),1000,1000)
        name = 'happy-control-call-' + directory.name
        docker = ['docker', '--host', 'unix:///var/run/docker.sock', '--config', str(docker_config)]
        args = docker + ['run', '--rm', '-i', '--name', name, '--label', 'com.happy.automation.caller=site-99-55-v1', '--log-driver', 'none', '--pull', 'never', '--network', 'bridge', '--add-host', 'szsp.suitbim.com.cn:192.168.99.57', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '192m', '--pids-limit', '64', '--cpus', '0.5', '--mount', 'type=bind,src='+str(directory)+',dst=/caller,readonly', '--entrypoint', 'node', image, '/app/packages/happy-agent/bin/happy-control-call.mjs', '--config', '/caller/caller.json']
        started = True
        safe_env = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin'}
        response = subprocess.run(args, input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45, env=safe_env)
        if len(response.stdout) > 32 * 1024 * 1024:
            raise RuntimeError('CALLER_REPLY_INVALID')
        parsed = json.loads(response.stdout.decode('utf8'))
        if parsed.get('version') != 1 or not isinstance(parsed.get('ok'), bool):
            raise RuntimeError('CALLER_REPLY_INVALID')
        completion_observed = response.returncode in (0, 1)
        result = parsed
    except Exception:
        result = failure('CALLER_UNAVAILABLE_OR_UNKNOWN', request, uncertain and started)
    finally:
        # A timed-out docker CLI may leave its container alive. Stop only this exact unique caller.
        cleanup_ok = True
        if name:
            try:
                present = subprocess.run(docker + ['ps', '-aq', '--filter', 'name=^/'+name+'$'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, env=safe_env)
                if present.returncode:
                    cleanup_ok = False
                elif present.stdout.strip():
                    inspect = subprocess.run(docker + ['inspect', '--format', '{{index .Config.Labels "com.happy.automation.caller"}}', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, env=safe_env)
                    if inspect.returncode or inspect.stdout.strip() != b'site-99-55-v1':
                        cleanup_ok = False
                    else:
                        removed = subprocess.run(docker + ['rm', '-f', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, env=safe_env)
                        remaining = subprocess.run(docker + ['ps', '-aq', '--filter', 'name=^/'+name+'$'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, env=safe_env)
                        cleanup_ok = removed.returncode == 0 and remaining.returncode == 0 and not remaining.stdout.strip()
                elif started and not completion_observed:
                    cleanup_ok = False
            except Exception:
                cleanup_ok = False
        if directory:
            if cleanup_ok:
                try:shutil.rmtree(str(directory))
                except Exception:cleanup_ok = False
            # Retain a private tmpfs directory if removal could race a running signer.
            if not cleanup_ok:
                result = failure('CALLER_CREDENTIAL_CLEANUP_UNKNOWN', request, uncertain and started)
    return result


if __name__ == '__main__':
    value = invoke(sys.stdin.buffer.read(LIMIT + 1))
    sys.stdout.write(json.dumps(value) + '\n')
    sys.exit(0 if value.get('ok') else 1)
