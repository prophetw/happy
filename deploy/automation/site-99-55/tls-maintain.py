#!/usr/bin/env python3
"""Local, fixed-role TLS maintenance. No listener, account login, remote shell or grant operations."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time
import tempfile

D = ['docker', '--host', 'unix:///var/run/docker.sock', '--config', '/run/happy-control-tls-empty-docker-config']
MARKER = 'happy-control-production-tls-v1'
SERVER_RUNTIME = '/run/happy-control/pki'
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'}


def run(args, data=None, accept=(0,)):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=35, env=SAFE_ENV)
    if result.returncode not in accept:
        raise RuntimeError('TLS_ACTION_FAILED:' + pathlib.Path(args[0]).name)
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private(path, directory=False):
    value = pathlib.Path(path)
    s = value.lstat()
    if value.is_symlink() or value.resolve() != value.absolute() or s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) & 0o077:
        raise RuntimeError('TLS_PRIVATE_PATH_REJECTED')
    if directory != stat.S_ISDIR(s.st_mode) or (not directory and (not stat.S_ISREG(s.st_mode) or s.st_nlink != 1)):
        raise RuntimeError('TLS_PRIVATE_PATH_REJECTED')
    return value


def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_source(path, data, mode=0o400):
    path = pathlib.Path(path)
    fd, name = tempfile.mkstemp(prefix=path.name + '.pending-', dir=str(path.parent))
    temporary = pathlib.Path(name)
    os.fchmod(fd, mode)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(temporary), str(path))
        sync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def certificate(path):
    text = run(['openssl', 'x509', '-in', str(path), '-noout', '-enddate', '-serial', '-fingerprint', '-sha256']).decode()
    fields = dict(line.split('=', 1) for line in text.splitlines())
    expires = datetime.datetime.strptime(fields['notAfter'], '%b %d %H:%M:%S %Y GMT').replace(tzinfo=datetime.timezone.utc)
    return {'notAfter': expires.isoformat(), 'expiresEpoch': int(expires.timestamp()), 'serial': fields['serial'], 'sha256': digest(pathlib.Path(path).read_bytes())}


class Maintenance:
    def __init__(self, config):
        self.cfg = config
        if config.get('version') != 1 or config.get('role') not in ['server', 'proxy']:
            raise RuntimeError('TLS_CONFIG_REJECTED')
        self.role = config['role']
        self.base = pathlib.Path(config['directory'])
        if not self.base.is_absolute():
            raise RuntimeError('TLS_CONFIG_REJECTED')
        self.prefix = 'server' if self.role == 'server' else 'client'

    def initialize(self):
        self.base.mkdir(mode=0o700, parents=True, exist_ok=True)
        private(self.base, True)
        if (self.base / 'issuer.encrypted.pem').exists() or (self.base / 'issuer.crt').exists():
            raise RuntimeError('TLS_ISSUER_ALREADY_EXISTS')
        atomic_source(self.base / 'issuer.passphrase', os.urandom(48).hex().encode())
        request = self.base / 'issuer-request.cnf'
        request.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=issuer\n[dn]\nCN=Happy control ' + self.role + ' dedicated issuer\n[issuer]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always,issuer\n')
        os.chmod(str(request), 0o600)
        run(['openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-aes-256-cbc', '-pass', 'file:' + str(self.base / 'issuer.passphrase'), '-out', str(self.base / 'issuer.encrypted.pem')])
        os.chmod(str(self.base / 'issuer.encrypted.pem'), 0o400)
        run(['openssl', 'req', '-config', str(request), '-new', '-x509', '-days', '1825', '-sha256', '-key', str(self.base / 'issuer.encrypted.pem'), '-passin', 'file:' + str(self.base / 'issuer.passphrase'), '-out', str(self.base / 'issuer.crt')])
        os.chmod(str(self.base / 'issuer.crt'), 0o400)
        run(['openssl', 'verify', '-CAfile', str(self.base / 'issuer.crt'), str(self.base / 'issuer.crt')])
        return self.issue(True)

    def _recover_pair(self):
        ledger = self.base / 'rotation.pending.json'
        if not ledger.exists():
            return
        record = json.loads(private(ledger).read_text())
        if set(record) != {'key', 'crt'}:
            raise RuntimeError('TLS_ROTATION_RECORD_REJECTED')
        for extension in ['key', 'crt']:
            item = record[extension]
            if set(item) != {'previous', 'next'} or not re.fullmatch('[a-f0-9]{64}', item['next']):
                raise RuntimeError('TLS_ROTATION_RECORD_REJECTED')
            if item['previous'] is not None and not re.fullmatch('[a-f0-9]{64}', item['previous']):
                raise RuntimeError('TLS_ROTATION_RECORD_REJECTED')
            staged = private(self.base / ('rotation-next.' + extension))
            if digest(staged.read_bytes()) != item['next']:
                raise RuntimeError('TLS_ROTATION_RECORD_REJECTED')
            active = self.base / (self.prefix + '.' + extension)
            observed = digest(private(active).read_bytes()) if active.exists() else None
            if observed not in [item['previous'], item['next']]:
                raise RuntimeError('TLS_ROTATION_SOURCE_CHANGED')
        # A durable, validated candidate pair lets either interrupted replace finish forward.
        for extension in ['key', 'crt']:
            atomic_source(self.base / (self.prefix + '.' + extension), (self.base / ('rotation-next.' + extension)).read_bytes())
        ledger.unlink()
        sync_directory(self.base)
        for extension in ['key', 'crt']:
            (self.base / ('rotation-next.' + extension)).unlink()

    def _commit_pair(self, key, cert):
        record = {}
        for extension, path in [('key', key), ('crt', cert)]:
            active = self.base / (self.prefix + '.' + extension)
            content = path.read_bytes()
            record[extension] = {'previous': digest(private(active).read_bytes()) if active.exists() else None, 'next': digest(content)}
            atomic_source(self.base / ('rotation-next.' + extension), content)
        atomic_source(self.base / 'rotation.pending.json', json.dumps(record, sort_keys=True).encode())
        self._recover_pair()

    def validate(self, allow_expired_leaf=False):
        private(self.base, True)
        self._recover_pair()
        for name in ['issuer.encrypted.pem', 'issuer.passphrase', 'issuer.crt', self.prefix + '.key', self.prefix + '.crt']:
            private(self.base / name)
        issuer = certificate(self.base / 'issuer.crt')
        if issuer['expiresEpoch'] <= int(datetime.datetime.now(datetime.timezone.utc).timestamp()):
            raise RuntimeError('TLS_ISSUER_EXPIRED')
        purpose = 'sslserver' if self.role == 'server' else 'sslclient'
        run(['openssl', 'verify'] + (['-no_check_time'] if allow_expired_leaf else []) + ['-CAfile', str(self.base / 'issuer.crt'), '-purpose', purpose, str(self.base / (self.prefix + '.crt'))])
        key = run(['openssl', 'pkey', '-in', str(self.base / (self.prefix + '.key')), '-pubout'])
        public = run(['openssl', 'x509', '-in', str(self.base / (self.prefix + '.crt')), '-pubkey', '-noout'])
        if key != public:
            raise RuntimeError('TLS_LEAF_KEY_MISMATCH')
        return certificate(self.base / (self.prefix + '.crt'))

    def issue(self, force=False):
        private(self.base, True)
        self._recover_pair()
        for name in ['issuer.encrypted.pem', 'issuer.passphrase', 'issuer.crt']:
            private(self.base / name)
        issuer = certificate(self.base / 'issuer.crt')
        now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
        if issuer['expiresEpoch'] - now <= 90 * 86400:
            raise RuntimeError('TLS_ISSUER_ROTATION_REQUIRED')
        if not force:
            leaf = self.validate(allow_expired_leaf=True)
            if leaf['expiresEpoch'] - now > 14 * 86400:
                return {'issued': False, 'leaf': leaf}
        key = self.base / (self.prefix + '.key.next')
        csr = self.base / (self.prefix + '.csr.next')
        cert = self.base / (self.prefix + '.crt.next')
        ext = self.base / 'leaf-ext.cnf'
        if any(p.exists() for p in [key, csr, cert]):
            raise RuntimeError('TLS_PREVIOUS_ISSUANCE_UNCONFIRMED')
        try:
            common = 'happy-control-55.internal' if self.role == 'server' else 'Happy control 99.57 proxy'
            run(['openssl', 'req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-sha256', '-subj', '/CN=' + common, '-keyout', str(key), '-out', str(csr)])
            os.chmod(str(key), 0o400)
            text = 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\nextendedKeyUsage=' + ('serverAuth' if self.role == 'server' else 'clientAuth') + '\n'
            if self.role == 'server':
                text += 'subjectAltName=DNS:happy-control-55.internal\n'
            ext.write_text(text)
            os.chmod(str(ext), 0o600)
            run(['openssl', 'x509', '-req', '-in', str(csr), '-CA', str(self.base / 'issuer.crt'), '-CAkey', str(self.base / 'issuer.encrypted.pem'), '-passin', 'file:' + str(self.base / 'issuer.passphrase'), '-CAcreateserial', '-days', '30', '-sha256', '-extfile', str(ext), '-out', str(cert)])
            os.chmod(str(cert), 0o400)
            run(['openssl', 'verify', '-CAfile', str(self.base / 'issuer.crt'), '-purpose', 'sslserver' if self.role == 'server' else 'sslclient', str(cert)])
            self._commit_pair(key, cert)
        finally:
            # These files are created by this locked attempt; never touch an unknown previous attempt.
            for p in [key, csr, cert]:
                if p.exists():
                    p.unlink()
        return {'issued': True, 'leaf': self.validate()}

    def _server(self, leaf):
        target = pathlib.Path(self.cfg['runtime'])
        if str(target) != SERVER_RUNTIME:
            raise RuntimeError('TLS_RUNTIME_REJECTED')
        target.mkdir(parents=True, mode=0o700, exist_ok=True)
        if target.is_symlink() or target.resolve() != target.absolute():
            raise RuntimeError('TLS_RUNTIME_REJECTED')
        os.chmod(str(target), 0o700)
        os.chown(str(target), 1000, 1000)
        desired, previous = {}, {}
        for source, name in [(self.base / 'server.key', 'server.key'), (self.base / 'server.crt', 'server.crt'), (self.base / 'peer-ca.crt', 'client-ca.crt')]:
            private(source)
            path = target / name
            if path.is_symlink() or (path.exists() and (not path.is_file() or path.stat().st_nlink != 1)):
                raise RuntimeError('TLS_RUNTIME_REJECTED')
            desired[path] = source.read_bytes()
            previous[path] = path.read_bytes() if path.exists() else None
        def write(path, data):
            # Per-file bind mounts MUST keep their existing inode.
            if path.exists():
                os.chmod(str(path), 0o600)
            try:
                with open(str(path), 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
            finally:
                if path.exists():
                    os.chmod(str(path), 0o400)
                    os.chown(str(path), 1000, 1000)
        ids = run(D + ['ps', '-q', '--filter', 'label=com.docker.compose.project=happy-control', '--filter', 'label=com.docker.compose.service=gateway', '--filter', 'label=com.happy.automation.managed-pair=site-99-55-v1']).decode().split()
        if len(ids) > 1:
            raise RuntimeError('TLS_GATEWAY_AMBIGUOUS')
        generation = ids[0] if ids else None
        applied = self.base / 'runtime-applied.json'
        proof = json.dumps({'container': generation, 'leaf': leaf['sha256'], 'trust': digest((self.base / 'peer-ca.crt').read_bytes())}, sort_keys=True).encode()
        changed = any(previous[p] != data for p, data in desired.items())
        needs_reload = bool(ids) and (changed or not applied.exists() or private(applied).read_bytes() != proof)
        try:
            for path, data in desired.items():
                if previous[path] != data:
                    write(path, data)
            if needs_reload:
                run(D + ['exec', ids[0], 'nginx', '-t'])
                run(D + ['exec', ids[0], 'nginx', '-s', 'reload'])
                self._server_wire_matches()
                atomic_source(applied, proof)
        except Exception:
            for path, data in previous.items():
                if data is None:
                    if path.exists():path.unlink()
                else:
                    write(path, data)
            # Do not mark an unconfirmed reload as applied. The next ensure retries it.
            if ids:
                run(D + ['exec', ids[0], 'nginx', '-t'])
                run(D + ['exec', ids[0], 'nginx', '-s', 'reload'])
            raise
        return {'changed': changed, 'nginxReloaded': needs_reload, 'gatewayRunning': bool(ids), 'wireLeafVerified': bool(needs_reload), 'leaf': leaf}

    def _server_wire_matches(self):
        # No client private key is needed to inspect the public server certificate.
        # The handshake may end with client-certificate-required after delivering it.
        expected = run(['openssl', 'x509', '-in', str(self.base / 'server.crt'), '-outform', 'DER'])
        for attempt in range(5):
            result = run(['openssl', 's_client', '-connect', '192.168.99.55:9011', '-servername', 'happy-control-55.internal', '-showcerts', '-CAfile', str(self.base / 'issuer.crt'), '-verify_return_error'], b'', accept=(0, 1))
            match = re.search(b'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', result, re.S)
            if match and run(['openssl', 'x509', '-outform', 'DER'], match.group(0)) == expected:
                return
            time.sleep(1)
        raise RuntimeError('TLS_RELOADED_LEAF_NOT_OBSERVED')

    def _proxy(self, leaf):
        container = self.cfg['container']
        memory = self.cfg['runtime']
        if container != 'bim-nginx-1.30' or memory != '/dev/shm/happy-control-production':
            raise RuntimeError('TLS_RUNTIME_REJECTED')
        if run(D + ['exec', container, 'stat', '-f', '-c', '%T', '/dev/shm']).decode().strip() != 'tmpfs':
            raise RuntimeError('TLS_RUNTIME_NOT_MEMORY')
        exists = subprocess.run(D + ['exec', container, 'test', '-d', memory], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, env=SAFE_ENV).returncode == 0
        if exists:
            if run(D + ['exec', container, 'cat', memory + '/.deployment']).decode().strip() != MARKER:
                raise RuntimeError('TLS_RUNTIME_OWNER_UNCONFIRMED')
        else:
            run(D + ['exec', container, 'mkdir', '-p', memory + '/routes'])
            run(D + ['exec', container, 'chmod', '700', memory, memory + '/routes'])
            self._stream(container, memory + '/.deployment', (MARKER + '\n').encode())
        route = pathlib.Path(self.cfg['routeFile'])
        private(route)
        sources = [(self.base / 'client.key', 'client.key'), (self.base / 'client.crt', 'client.crt'), (self.base / 'peer-ca.crt', 'server-ca.crt')]
        desired = {}
        for source, name in sources:
            private(source)
            desired[memory + '/' + name] = source.read_bytes()
        route_target = memory + '/routes/control.conf'
        desired[route_target] = route.read_bytes()
        generation = run(D + ['inspect', '--format', '{{.Id}} {{.State.StartedAt}}', container]).strip() + b'\n'
        previous = {target: self._read_runtime(container, target) for target in desired}
        changed = any(previous[p] != data for p, data in desired.items()) or self._read_runtime(container, memory + '/.generation') != generation
        if not changed:
            return {'changed': False, 'nginxReloaded': False, 'externalReadiness': 'not-checked', 'leaf': leaf}
        workers_before = self._proxy_workers(container)
        try:
            # An unrelated reload during a partial write must never read an inconsistent pair.
            run(D + ['exec', container, 'rm', '-f', route_target])
            for target, data in desired.items():
                if target == route_target or previous[target] == data:
                    continue
                self._stream(container, target, data)
            self._stream(container, memory + '/route.pending', desired[route_target])
            run(D + ['exec', container, 'mv', memory + '/route.pending', route_target])
            run(D + ['exec', container, 'nginx', '-t'])
            run(D + ['exec', container, 'nginx', '-s', 'reload'])
            for attempt in range(10):
                if self._proxy_workers(container) - workers_before:
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError('TLS_PROXY_NEW_WORKER_NOT_OBSERVED')
            self._stream(container, memory + '/.generation', generation)
        except Exception:
            # Restore every referenced material first, and publish the previous route LAST.
            run(D + ['exec', container, 'rm', '-f', route_target])
            for target, data in previous.items():
                if target == route_target:
                    continue
                if data is None:
                    run(D + ['exec', container, 'rm', '-f', target])
                else:
                    self._stream(container, target, data)
            if previous[route_target] is not None:
                self._stream(container, memory + '/route.pending', previous[route_target])
                run(D + ['exec', container, 'mv', memory + '/route.pending', route_target])
            # A reload acknowledgement may precede an error writing .generation.
            run(D + ['exec', container, 'nginx', '-t'])
            run(D + ['exec', container, 'nginx', '-s', 'reload'])
            raise
        return {'changed': True, 'nginxReloaded': True, 'externalReadiness': 'not-checked', 'leaf': leaf}

    @staticmethod
    def _proxy_workers(container):
        output = run(D + ['top', container, '-eo', 'pid,args']).decode()
        workers = {line.split()[0] for line in output.splitlines() if 'nginx: worker process' in line}
        if not workers:
            raise RuntimeError('TLS_PROXY_WORKER_UNAVAILABLE')
        return workers

    @staticmethod
    def _read_runtime(container, target):
        result = subprocess.run(D + ['exec', container, 'sh', '-ec', 'if test -f "$1"; then cat "$1"; else exit 44; fi', 'sh', target], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, env=SAFE_ENV)
        if result.returncode == 44:
            return None
        if result.returncode:
            raise RuntimeError('TLS_RUNTIME_READ_FAILED')
        return result.stdout

    @staticmethod
    def _stream(container, target, data):
        run(D + ['exec', '-i', container, 'sh', '-ec', 'umask 077; cat > "$1"', 'sh', target], data)

    def ensure(self):
        leaf = self.validate()
        private(self.base / 'peer-ca.crt')
        return self._server(leaf) if self.role == 'server' else self._proxy(leaf)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('action', choices=['initialize', 'renew', 'ensure', 'check'])
    parser.add_argument('--force-leaf-rotation', action='store_true')
    args = parser.parse_args()
    if args.force_leaf_rotation and args.action != 'renew':
        raise RuntimeError('TLS_FORCE_REQUIRES_RENEW')
    path = private(args.config)
    cfg = json.loads(path.read_text())
    manager = Maintenance(cfg)
    manager.base.mkdir(parents=True, mode=0o700, exist_ok=True)
    private(manager.base, True)
    lock = manager.base / 'maintenance.lock'
    descriptor = os.open(str(lock), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as stream:
        private(lock)
        os.chmod(str(lock), 0o600)
        fcntl.flock(stream, fcntl.LOCK_EX)
        if args.action == 'initialize':
            result = manager.initialize()
        elif args.action == 'renew':
            result = manager.issue(force=args.force_leaf_rotation)
            result['runtime'] = manager.ensure()
        elif args.action == 'ensure':
            result = manager.ensure()
        else:
            result = {'leaf': manager.validate(), 'runtimeModified': False}
    print(json.dumps({'version': 1, 'ok': True, 'role': manager.role, 'data': result}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z0-9_:-]+', str(error)) else 'TLS_MAINTENANCE_FAILED'
        print(json.dumps({'version': 1, 'ok': False, 'error': {'code': code}}))
        sys.exit(1)
