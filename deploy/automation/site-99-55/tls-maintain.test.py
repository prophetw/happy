import importlib.util
import pathlib
import os
import tempfile
import shutil
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('tls_maintenance', pathlib.Path(__file__).with_name('tls-maintain.py'))
tls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tls)

class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='happy-tls-local-fixture-')
        self.base = pathlib.Path(self.directory.name)
        self.server = tls.Maintenance({'version': 1, 'role': 'server', 'directory': str(self.base / 'server')})
        self.client = tls.Maintenance({'version': 1, 'role': 'proxy', 'directory': str(self.base / 'client')})
        self.server.initialize(); self.client.initialize()
    def tearDown(self):
        self.directory.cleanup()
    def test_role_separation_and_explicit_issuer_extensions(self):
        for manager, purpose in [(self.server, 'sslserver'), (self.client, 'sslclient')]:
            leaf = manager.base / (manager.prefix + '.crt')
            tls.run(['openssl', 'verify', '-CAfile', str(manager.base / 'issuer.crt'), '-purpose', purpose, str(leaf)])
            issuer = tls.run(['openssl', 'x509', '-in', str(manager.base / 'issuer.crt'), '-noout', '-text']).decode()
            self.assertEqual(issuer.count('X509v3 Basic Constraints'), 1)
            self.assertTrue((manager.base / 'issuer.encrypted.pem').read_bytes().startswith(b'-----BEGIN ENCRYPTED PRIVATE KEY-----'))
        rejected = subprocess.run(['openssl', 'verify', '-CAfile', str(self.client.base / 'issuer.crt'), str(self.server.base / 'server.crt')], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(rejected.returncode, 0)
    def test_missing_unlock_never_recreates_an_issuer(self):
        before = (self.server.base / 'issuer.crt').read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'TLS_ISSUER_ALREADY_EXISTS'):self.server.initialize()
        (self.server.base / 'issuer.passphrase').unlink()
        with self.assertRaises(FileNotFoundError):self.server.validate()
        self.assertEqual((self.server.base / 'issuer.crt').read_bytes(), before)
    def test_long_lived_leaf_does_not_renew_on_every_ensure(self):
        before = self.server.validate()['sha256']
        self.assertFalse(self.server.issue()['issued'])
        self.assertEqual(self.server.validate()['sha256'], before)
    def test_expired_leaf_renews_but_ensure_cannot_activate_it(self):
        base=self.server.base;csr=base/'expired.csr';cert=base/'expired.crt'
        tls.run(['openssl','req','-new','-key',str(base/'server.key'),'-subj','/CN=happy-control-55.internal','-out',str(csr)])
        tls.run(['openssl','x509','-req','-in',str(csr),'-CA',str(base/'issuer.crt'),'-CAkey',str(base/'issuer.encrypted.pem'),'-passin','file:'+str(base/'issuer.passphrase'),'-CAcreateserial','-days','0','-sha256','-extfile',str(base/'leaf-ext.cnf'),'-out',str(cert)])
        os.replace(str(cert),str(base/'server.crt'));os.chmod(str(base/'server.crt'),0o400)
        with self.assertRaises(RuntimeError):self.server.validate()
        self.assertTrue(self.server.issue()['issued'])
        self.server.validate()
    def test_mismatched_key_rejects_before_runtime_actions(self):
        os.chmod(str(self.server.base / 'server.key'), 0o600)
        shutil.copyfile(str(self.client.base / 'client.key'), str(self.server.base / 'server.key'))
        with self.assertRaisesRegex(RuntimeError, 'TLS_LEAF_KEY_MISMATCH'):self.server.ensure()
    def test_interrupted_pair_commit_recovers_forward(self):
        old=self.server.validate()['serial'];real=os.replace;failed=[False]
        def interrupt(source,target):
            if str(target)==str(self.server.base/'server.crt') and not failed[0]:
                failed[0]=True;raise OSError('fixture-interruption')
            return real(source,target)
        with patch.object(os,'replace',interrupt):
            with self.assertRaises(OSError):self.server.issue(True)
        self.assertTrue((self.server.base/'rotation.pending.json').exists())
        orphan=self.server.base/'server.key.pending-killed-fixture'
        orphan.write_bytes(b'private-fixture-orphan');os.chmod(str(orphan),0o400)
        self.assertNotEqual(self.server.validate()['serial'],old)
        self.assertFalse((self.server.base/'rotation.pending.json').exists())
        self.assertTrue(orphan.exists())
    def test_server_bind_mount_inode_is_preserved_on_rotation(self):
        runtime_parent = pathlib.Path('/run/user') / str(os.getuid())
        if not runtime_parent.is_dir():self.skipTest('no writable /run/user fixture directory')
        runtime = pathlib.Path(tempfile.mkdtemp(prefix='happy-tls-fixture-', dir=str(runtime_parent)))
        original = tls.run
        original_runtime=tls.SERVER_RUNTIME;tls.SERVER_RUNTIME=str(runtime)
        def no_live_docker(args, *values, **kwargs):
            if args[0] == 'docker':
                self.assertIn('ps', args);return b''
            return original(args, *values, **kwargs)
        try:
            self.server.cfg['runtime'] = str(runtime)
            peer = self.server.base / 'peer-ca.crt';peer.write_bytes((self.client.base / 'issuer.crt').read_bytes());os.chmod(str(peer),0o400)
            tls.run = no_live_docker
            first = self.server.ensure();self.assertTrue(first['changed']);self.assertFalse(first['gatewayRunning'])
            key_inode = (runtime / 'server.key').stat().st_ino;cert_inode = (runtime / 'server.crt').stat().st_ino
            self.assertFalse(self.server.ensure()['changed'])
            self.server.issue(True);self.assertTrue(self.server.ensure()['changed'])
            self.assertEqual((runtime / 'server.key').stat().st_ino,key_inode)
            self.assertEqual((runtime / 'server.crt').stat().st_ino,cert_inode)
        finally:
            tls.run=original;tls.SERVER_RUNTIME=original_runtime;shutil.rmtree(str(runtime))

class ProxyTransactionTests(unittest.TestCase):
    setUp = MaintenanceTests.setUp
    tearDown = MaintenanceTests.tearDown
    def test_proxy_write_failure_restores_materials_before_route(self):
        self._proxy_case('write')
    def test_proxy_publish_failure_restores_materials_before_route(self):
        self._proxy_case('publish')
    def test_proxy_repeat_is_noop_and_container_generation_restores(self):
        self._proxy_case(None)
    def _proxy_case(self, failure):
        root='/dev/shm/happy-control-production'
        cfg=self.client.cfg
        route=self.base/'route.conf';route.write_bytes(b'location ^~ /happy-control/v1/ {}');os.chmod(str(route),0o600)
        cfg.update({'container':'bim-nginx-1.30','runtime':root,'routeFile':str(route)})
        peer=self.client.base/'peer-ca.crt';peer.write_bytes((self.server.base/'issuer.crt').read_bytes());os.chmod(str(peer),0o400)
        files={root+'/.deployment':(tls.MARKER+'\n').encode(),root+'/.generation':b'old-container start\n',root+'/client.key':b'old-private-fixture',root+'/client.crt':b'old-cert',root+'/server-ca.crt':b'old-ca',root+'/routes/control.conf':b'old-route'}
        original=dict(files);events=[];failed=[False];worker=[1];generation=[b'container start\n'];real=subprocess.run
        def fake(args, **kwargs):
            if args[0]!='docker':return real(args,**kwargs)
            def result(code=0,out=b''):return subprocess.CompletedProcess(args,code,out,b'')
            if 'inspect' in args:return result(out=generation[0])
            if 'top' in args:return result(out=(str(worker[0])+' nginx: worker process\n').encode())
            offset=args.index('exec')+1
            if args[offset]=='-i':offset+=1
            op=args[offset+1:]
            if op[:2]==['stat','-f']:return result(out=b'tmpfs\n')
            if op[:2]==['test','-d']:return result()
            if op[0]=='cat':return result(out=files[op[1]])
            if op[0]=='sh' and op[2].startswith('if test -f'):
                target=op[-1];return result(out=files[target]) if target in files else result(44)
            if op[0]=='sh':
                target=op[-1]
                if failure=='write' and not failed[0] and target.endswith('/client.crt'):
                    failed[0]=True;files[target]=b'partial';return result(1)
                files[target]=kwargs['input'];events.append(('write',target));return result()
            if op[0]=='rm':
                files.pop(op[-1],None);events.append(('remove',op[-1]));return result()
            if op[0]=='mv':
                if failure=='publish' and not failed[0]:failed[0]=True;return result(1)
                files[op[-1]]=files.pop(op[-2]);events.append(('publish',op[-1]));return result()
            if op[0]=='nginx':
                if op[-1]=='reload':worker[0]+=1
                events.append(('nginx',op[-1]));return result()
            raise AssertionError(op)
        with patch.object(subprocess,'run',fake):
            if failure:
                with self.assertRaises(RuntimeError):self.client.ensure()
                for key,value in original.items():self.assertEqual(files[key],value)
                last_publish=max(i for i,e in enumerate(events) if e[0]=='publish')
                self.assertTrue(all(i<last_publish for i,e in enumerate(events) if e[0]=='write' and not e[1].endswith('/route.pending')))
            else:
                self.assertTrue(self.client.ensure()['changed']);events.clear()
                self.assertFalse(self.client.ensure()['changed']);self.assertEqual(events,[])
                generation[0]=b'container restarted\n'
                self.assertTrue(self.client.ensure()['changed'])

if __name__ == '__main__':unittest.main()
