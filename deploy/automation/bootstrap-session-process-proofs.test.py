import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bootstrap', pathlib.Path(__file__).with_name('bootstrap-session-process-proofs.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class BootstrapSafety(unittest.TestCase):
    def test_non_admin_is_rejected_before_any_process_or_service_inspection(self):
        with patch.object(m.os, 'geteuid', return_value=1000), patch.object(m.subprocess, 'check_output') as inspect:
            with self.assertRaisesRegex(RuntimeError, 'LOCAL_ROOT_REQUIRED'):
                m.prepare(pathlib.Path('/unused'), pathlib.Path('/unused'), ['session'])
            inspect.assert_not_called()

    def test_untrusted_or_public_evidence_cannot_be_used(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'evidence.json'
            path.write_text('{}')
            for info in [SimpleNamespace(st_mode=0o100600, st_uid=1000, st_nlink=1),
                         SimpleNamespace(st_mode=0o100644, st_uid=0, st_nlink=1),
                         SimpleNamespace(st_mode=0o120600, st_uid=0, st_nlink=1),
                         SimpleNamespace(st_mode=0o100600, st_uid=0, st_nlink=2)]:
                with patch.object(pathlib.Path, 'lstat', return_value=info):
                    with self.assertRaisesRegex(RuntimeError, 'PRIVATE_ROOT_EVIDENCE_REQUIRED'):
                        m.private_json(path)

    def test_check_mode_does_not_invoke_the_dev_importer_or_create_proofs(self):
        payload = {'machineID': 'machine', 'sessions': [{'sessionID': 'session', 'identity': {'pid': 123}}]}
        args = ['bootstrap', '--maintenance', '/unused', '--release', '/unused', '--session', 'session']
        with patch.object(m, 'prepare', return_value=(['runuser', '-u', 'dev'], payload)), patch.object(m.subprocess, 'run') as run, patch('sys.argv', args), contextlib.redirect_stdout(io.StringIO()) as output:
            m.main()
            run.assert_not_called()
            self.assertEqual(json.loads(output.getvalue())['status'], 'verified_not_imported')


if __name__ == '__main__':
    unittest.main()
