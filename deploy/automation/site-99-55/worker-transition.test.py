import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('transition',pathlib.Path(__file__).with_name('worker-transition.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SafetyTests(unittest.TestCase):
 def test_changed_original_identity_does_not_send_stop(self):
  with tempfile.TemporaryDirectory() as d:
   t=m.Transition({'directory':d,'operation':'fixture','oldPID':123,'oldStartTicks':'7'})
   with patch.object(m,'process',return_value=None),patch.object(m,'state',return_value={'pid':123}),patch.object(m,'local') as local:
    with self.assertRaisesRegex(RuntimeError,'OLD_DAEMON_IDENTITY_CHANGED'):t.run()
    local.assert_not_called()
 def test_unknown_lock_owner_retains_both_files(self):self.archive(False)
 def test_only_dead_transaction_owner_metadata_is_archived(self):self.archive(True)
 def archive(self,known):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);owner=root/'state';lock=root/'lock';owner.write_text(json.dumps({'pid':123}));lock.write_text('123' if known else '987')
   t=m.Transition({'directory':d,'operation':'fixture'});t.known={123}
   with patch.object(m,'STATE',owner),patch.object(m,'LOCK',lock),patch.object(m,'process',return_value=None):
    if known:
     t.archive_attributable_metadata();self.assertFalse(owner.exists());self.assertFalse(lock.exists())
    else:
     with self.assertRaisesRegex(RuntimeError,'TRANSACTION_METADATA_OWNER_CHANGED'):t.archive_attributable_metadata()
     self.assertTrue(owner.exists());self.assertTrue(lock.exists())
 def test_unit_pids_before_this_start_are_not_transaction_owners(self):
  with tempfile.TemporaryDirectory() as d:
   t=m.Transition({'directory':d,'operation':'fixture'});t.start_us=500
   with patch.object(m,'command',return_value='MainPID=123\nExecMainPID=123\nInvocationID='+'a'*32+'\nExecMainStartTimestampMonotonic=499'):
    t.unit();self.assertEqual(t.known,set())
if __name__=='__main__':unittest.main()
