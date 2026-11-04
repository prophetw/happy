import importlib.util
import pathlib
import json
import tempfile
import subprocess
import shutil
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('caller_run',pathlib.Path(__file__).with_name('caller-run.py'))
caller=importlib.util.module_from_spec(spec);spec.loader.exec_module(caller)
class CallerInputTests(unittest.TestCase):
    def test_invalid_json_and_shape_do_not_start_a_signer(self):
        for value in [b'{',b'{}',b'{"tool":"arbitrary_shell","input":{}}',b'{"tool":"happy_machines","input":{},"endpoint":"https://other.test"}']:
            with patch.object(caller.subprocess,'run',side_effect=AssertionError('no process allowed')):
                self.assertFalse(caller.invoke(value)['ok'])
    def test_oversize_is_rejected_before_parse(self):
        self.assertEqual(caller.invoke(b'x'*(caller.LIMIT+1))['error']['code'],'CONTROL_INPUT_TOO_LARGE')
    def test_non_operator_cannot_load_credentials(self):
        with patch.object(caller.os,'geteuid',return_value=1000),patch.object(caller,'private',side_effect=AssertionError('no credential access')):
            self.assertEqual(caller.invoke(b'{"tool":"happy_machines","input":{}}')['error']['code'],'CALLER_OPERATOR_REQUIRED')
    def test_uncertainty_keeps_only_valid_request_id(self):
        value=caller.failure('UNKNOWN',{'input':{'requestID':'req_123','text':'private fixture'}},True)
        self.assertEqual(value['data'],{'state':'unknown','requestID':'req_123'})
class CallerCleanupTests(unittest.TestCase):
    def test_timeout_with_late_create_keeps_credentials_private(self):self.case('late')
    def test_failed_container_query_keeps_credentials_private(self):self.case('query')
    def test_foreign_label_never_removed(self):self.case('label')
    def case(self,mode):
        with tempfile.TemporaryDirectory(prefix='happy-caller-cleanup-fixture-') as temp:
            root=pathlib.Path(temp);base=root/'source';base.mkdir();runtime=root/'runtime';calls=[]
            (base/'caller.json').write_text('{}');(base/'runtime.json').write_text(json.dumps({'image':'sha256:'+'1'*64}))
            (base/'assistant.encrypted.pem').write_bytes(b'fixture-encrypted');(base/'assistant-key-passphrase').write_bytes(b'fixture-unlock')
            def fake(args,**kwargs):
                calls.append(args)
                if args[0]=='stat':return subprocess.CompletedProcess(args,0,b'tmpfs\n',b'')
                self.assertEqual(kwargs['env'],{'PATH':'/usr/sbin:/usr/bin:/sbin:/bin'})
                if 'run' in args:
                    self.assertEqual(args[args.index('--log-driver')+1],'none')
                    raise subprocess.TimeoutExpired(args,45)
                if 'ps' in args:return subprocess.CompletedProcess(args,1 if mode=='query' else 0,b'container\n' if mode=='label' else b'',b'')
                if 'inspect' in args:return subprocess.CompletedProcess(args,0,b'foreign-label\n',b'')
                raise AssertionError(args)
            with patch.object(caller,'BASE',base),patch.object(caller,'RUNTIME',runtime),patch.object(caller,'private',side_effect=lambda p,*a:p),patch.object(caller.os,'geteuid',return_value=0),patch.object(caller.os,'chown'),patch.object(caller.subprocess,'run',fake):
                reply=caller.invoke(b'{"tool":"happy_send","input":{"sessionID":"fixture","requestID":"same-request","text":"private-fixture"}}')
            self.assertEqual(reply['error']['code'],'CALLER_CREDENTIAL_CLEANUP_UNKNOWN')
            self.assertEqual(reply['data'],{'state':'unknown','requestID':'same-request'})
            self.assertEqual(len(list(runtime.glob('call-*'))),1)
            self.assertFalse(any('rm' in args for args in calls))

if __name__=='__main__':unittest.main()
