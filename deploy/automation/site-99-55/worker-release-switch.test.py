import importlib.util
import pathlib
import tempfile
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('worker_switch',pathlib.Path(__file__).with_name('worker-release-switch.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SwitchSafety(unittest.TestCase):
 def test_new_cpu_dropin_must_sort_after_the_previous_optimization_dropin(self):
  previous='/etc/systemd/system/happy-automation-worker.service.d/zzzzzzzz-worker-optimization-608d9352d586.conf'
  with self.assertRaisesRegex(RuntimeError,'DROPIN_ORDER_CONFLICT'):
   m.verify_dropin_precedence('/etc/systemd/system/happy-automation-worker.service.d/zzzzzzzz-worker-cpu-fix-6c9128cbf612.conf',[previous])
  m.verify_dropin_precedence('/etc/systemd/system/happy-automation-worker.service.d/zzzzzzzzz-worker-cpu-fix-6c9128cbf612.conf',[previous])
 def test_effective_entry_checks_the_merged_systemd_argv_before_start(self):
  with tempfile.TemporaryDirectory() as root:
   switch=self.fixture(root)
   good='{ path=/node ; argv[]=/node /new/worker --config '+str(m.CONFIG)+' ; ignore_errors=no ; }'
   with patch.object(m,'command',return_value=good):switch.effective_entry('/new/worker')
   with patch.object(m,'command',return_value=good.replace('/new/worker','/old/worker')):
    with self.assertRaisesRegex(RuntimeError,'EFFECTIVE_WORKER_ENTRY_MISMATCH'):switch.effective_entry('/new/worker')
   with patch.object(m,'command',return_value=good+good):
    with self.assertRaisesRegex(RuntimeError,'EFFECTIVE_WORKER_ENTRY_MISMATCH'):switch.effective_entry('/new/worker')
 def test_dynamic_model_policy_follows_machine_without_adding_permission_modes(self):
  before={'version':1,'agents':[{'agent':'codex','models':['old-model'],'permissionModes':['read-only']}]}
  result=m.dynamic_model_policy(before)
  self.assertEqual([a['agent'] for a in result['agents']],['codex','claude','agy'])
  self.assertTrue(all(a['modelSource']=='machine' and a['models']==[] for a in result['agents']))
  self.assertEqual([a['permissionModes'] for a in result['agents']],[['read-only'],[],[]])
  self.assertEqual(before['agents'][0]['models'],['old-model'])
 def test_dynamic_model_policy_refuses_unexpected_existing_agents(self):
  with self.assertRaisesRegex(RuntimeError,'UNAPPROVED_MODEL_AGENT'):
   m.dynamic_model_policy({'version':1,'agents':[{'agent':'unapproved','models':[],'permissionModes':[]}]})
 def fixture(self,root):
  return m.Switch({'directory':root,'dropin':root+'/release.conf','unitFragment':root+'/unit','unitSHA256':'expected','oldPID':123,'oldStartTicks':'7','oldInvocationID':'a'*32,'oldEntry':'/old/worker','newEntry':'/new/worker','nodeExecutable':'/node','oldConfigSHA256':'old','candidateConfigSHA256':'new','dropinSHA256':'drop','configMode':0o400,'configUID':1000,'configGID':1000})
 def test_changed_process_fails_before_stop_or_config_write(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root)
   with patch.object(s,'record'),patch.object(s,'candidate_files'),patch.object(s,'verify_base',return_value={'MainPID':'123'}),patch.object(m,'process',return_value=None),patch.object(m,'metadata',return_value=None),patch.object(s,'stop') as stop,patch.object(m,'atomic') as atomic:
    with self.assertRaisesRegex(RuntimeError,'OLD_WORKER_IDENTITY_CHANGED'):s.run()
    stop.assert_not_called();atomic.assert_not_called();self.assertFalse(s.stop_attempted)
 def test_unknown_owner_metadata_is_retained_no_restart_or_lock_steal(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root);state=pathlib.Path(root)/'state';state.write_text('fixture-metadata')
   with patch.object(s,'verify_base',return_value={'MainPID':'0','ActiveState':'inactive','SubState':'dead','InvocationID':''}),patch.object(m,'command') as command,patch.object(m,'STATE',state),patch.object(m,'LOCK',pathlib.Path(root)/'lock'):
    with self.assertRaisesRegex(RuntimeError,'OWNER_METADATA_NOT_RELEASED'):s.stop('/old/worker')
    command.assert_called_once_with(['systemctl','stop',m.UNIT],timeout=45);self.assertTrue(state.exists())
 def test_dropin_verification_covers_install_before_manager_reload_and_rejects_foreign_dropins(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root);s.installed=True;s.install_attempted=True
   with patch.object(m,'sha',return_value='expected'),patch.object(m,'unit',return_value={'KillMode':'process','User':'dev','DropInPaths':''}):s.verify_base()
   with patch.object(m,'sha',return_value='expected'),patch.object(m,'unit',return_value={'KillMode':'process','User':'dev','DropInPaths':'/foreign.conf'}):
    with self.assertRaisesRegex(RuntimeError,'UNOWNED_UNIT_DROPIN'):s.verify_base()
 def test_unknown_live_config_is_never_overwritten_by_recovery(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root);s.stop_attempted=True
   with patch.object(s,'record'),patch.object(s,'stop'),patch.object(s,'config_metadata'),patch.object(s,'capture_started'),patch.object(m,'sha',return_value='someone-else'),patch.object(m,'atomic') as atomic:
    with self.assertRaisesRegex(RuntimeError,'WORKER_CONFIG_OWNERSHIP_CHANGED'):s.recover()
    atomic.assert_not_called()
 def test_recovery_preserves_original_private_config_owner_and_permissions(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root);s.stop_attempted=True;(pathlib.Path(root)/'before-worker.json').write_bytes(b'fixture-only')
   with patch.object(s,'record'),patch.object(s,'stop'),patch.object(s,'config_metadata'),patch.object(s,'effective_entry'),patch.object(s,'capture_started'),patch.object(m,'sha',return_value='new'),patch.object(m,'atomic') as atomic,patch.object(m,'command'),patch.object(s,'ready'),patch.object(s,'changed_sessions',return_value=[]):
    s.recover();atomic.assert_called_once_with(m.CONFIG,b'fixture-only',0o400,1000,1000)
 def test_same_entry_foreign_invocation_or_pid_is_never_stopped(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root)
   for pid,invocation in [(123,'b'*32),(124,'a'*32)]:
    u={'MainPID':str(pid),'InvocationID':invocation,'ActiveState':'active','SubState':'running'}
    p={'pid':pid,'startTicks':'7','uid':1000,'exe':'/node','args':[b'/old/worker']}
    with patch.object(s,'verify_base',return_value=u),patch.object(m,'process',return_value=p),patch.object(m,'command') as command:
     with self.assertRaisesRegex(RuntimeError,'UNOWNED_WORKER_INVOCATION'):s.stop('/old/worker')
     command.assert_not_called()
 def test_dangling_lock_is_not_natural_release(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root);lock=pathlib.Path(root)/'lock';lock.symlink_to(pathlib.Path(root)/'missing')
   with patch.object(s,'owned_unit',return_value={'MainPID':'0'}),patch.object(m,'command'),patch.object(m,'STATE',pathlib.Path(root)/'state'),patch.object(m,'LOCK',lock):
    with self.assertRaisesRegex(RuntimeError,'OWNER_METADATA_NOT_RELEASED'):s.stop('/old/worker')
    self.assertTrue(lock.is_symlink())
 def test_dropin_installed_before_fsync_error_is_detected_by_its_original_inode(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root);s.install_attempted=True;s.dropin.write_bytes(b'fixture');info=s.dropin.stat();s.dropin_identity={'dev':info.st_dev,'ino':info.st_ino}
   fake=SimpleNamespace(st_mode=0o100600,st_uid=0,st_nlink=1,st_dev=info.st_dev,st_ino=info.st_ino)
   with patch.object(pathlib.Path,'lstat',return_value=fake),patch.object(m,'sha',return_value='drop'):s.reconcile_dropin()
   self.assertTrue(s.installed)
   fake.st_ino+=1
   with patch.object(pathlib.Path,'lstat',return_value=fake),patch.object(m,'sha',return_value='drop'):
    with self.assertRaisesRegex(RuntimeError,'DROPIN_OWNERSHIP_CHANGED'):s.reconcile_dropin()
 def test_safe_filter_preserves_inside_relative_pnpm_link_and_rejects_escape(self):
  with tempfile.TemporaryDirectory() as root:
   entry=tarfile.TarInfo('node_modules/.pnpm/package/node_modules/zod');entry.type=tarfile.SYMTYPE;entry.linkname='../../zod/node_modules/zod'
   checked=m.safe_data_filter(entry,root);self.assertEqual(checked.linkname,entry.linkname)
   entry.linkname='../../../../../../outside'
   with self.assertRaisesRegex(RuntimeError,'ARCHIVE_LINK_OUTSIDE_RELEASE'):m.safe_data_filter(entry,root)
 def test_safe_filter_keeps_standard_archive_name_and_special_file_protection(self):
  with tempfile.TemporaryDirectory() as root:
   entry=tarfile.TarInfo('../outside');entry.type=tarfile.SYMTYPE;entry.linkname='inside'
   with self.assertRaises(Exception):m.safe_data_filter(entry,root)
   entry=tarfile.TarInfo('device');entry.type=tarfile.CHRTYPE
   with self.assertRaises(Exception):m.safe_data_filter(entry,root)
 def test_delayed_exec_waits_with_one_pinned_invocation(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root);u={'MainPID':'124','ExecMainPID':'124','InvocationID':'b'*32,'ExecMainStartTimestampMonotonic':'501','ActiveState':'active','SubState':'running'}
   bootstrap={'pid':124,'startTicks':'8','uid':0,'exe':'/bootstrap','args':[]};ready={**bootstrap,'uid':1000,'exe':'/node','args':[b'/new/worker']}
   with patch.object(s,'verify_base',return_value=u),patch.object(m,'process',side_effect=[bootstrap,ready]),patch.object(m.time,'sleep'):
    s.capture_started('/new/worker',500)
   self.assertEqual(s.owner['invocationID'],'b'*32);self.assertEqual(s.owner['startTicks'],'8')
 def test_fast_failure_pins_new_invocation_for_recovery_without_adopting_later_restart(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root);failed={'MainPID':'0','ExecMainPID':'124','InvocationID':'b'*32,'ExecMainStartTimestampMonotonic':'501','ActiveState':'activating','SubState':'auto-restart'}
   with patch.object(s,'verify_base',return_value=failed):
    with self.assertRaisesRegex(RuntimeError,'STARTED_WORKER_EXITED'):s.capture_started('/new/worker',500)
   self.assertEqual(s.owner['invocationID'],'b'*32)
   with patch.object(s,'verify_base',return_value={**failed,'InvocationID':'c'*32}),patch.object(m,'command') as command:
    with self.assertRaisesRegex(RuntimeError,'UNOWNED_WORKER_INVOCATION'):s.stop('/new/worker')
    command.assert_not_called()
 def test_preserves_pinned_previous_release_dropin_and_rejects_changed_or_unowned_files(self):
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root);previous=str(pathlib.Path(root)/'old-release.conf');s.plan['priorDropIns']=[{'path':previous,'sha256':'previous'}]
   fake=SimpleNamespace(st_mode=0o100600,st_uid=0,st_nlink=1)
   unit={'KillMode':'process','User':'dev','DropInPaths':previous}
   def digest(path):return 'previous' if str(path)==previous else 'expected'
   with patch.object(pathlib.Path,'lstat',return_value=fake),patch.object(m,'sha',side_effect=digest),patch.object(m,'unit',return_value=unit):
    s.verify_base();s.install_attempted=True;unit['DropInPaths']=' '.join(sorted([previous,str(s.dropin)]));s.verify_base()
    unit['DropInPaths']+=' /unknown.conf'
    with self.assertRaisesRegex(RuntimeError,'UNOWNED_UNIT_DROPIN'):s.verify_base()
   with patch.object(pathlib.Path,'lstat',return_value=fake),patch.object(m,'sha',return_value='expected'),patch.object(m,'unit',return_value=unit):
    with self.assertRaisesRegex(RuntimeError,'PRIOR_DROPIN_CHANGED'):s.verify_base()
 def test_candidate_allows_only_the_explicit_directory_policy_and_keeps_projects_credentials_unchanged(self):
  import json
  with tempfile.TemporaryDirectory() as root:
   s=self.fixture(root);release=str(pathlib.Path('/home/dev/.local/share/happy-automation/releases/fixture-only'))
   before={'registration':{'projects':[{'id':'existing','directory':'/fixture/existing'}]},'secrets':{'fixture':'reference-only'}}
   after={**before,'registration':{**before['registration'],'directorySelection':{'roots':['/home/dev/code']}}}
   for name,data in [('before-worker.json',before),('candidate-worker.json',after)]: (pathlib.Path(root)/name).write_text(json.dumps(data))
   s.plan.update({'release':release,'fileHashes':{},'configChange':'directory-selection','authorizedDirectoryRoots':['/home/dev/code'],'expectedDirectorySelection':None})
   def digest(path):return 'old' if str(path).endswith('before-worker.json') else 'new' if str(path).endswith('candidate-worker.json') else 'drop'
   with patch.object(m,'sha',side_effect=digest):
    s.candidate_files();s.plan['authorizedDirectoryRoots']=['/']
    with self.assertRaisesRegex(RuntimeError,'UNAPPROVED_DIRECTORY_POLICY'):s.candidate_files()
    s.plan['authorizedDirectoryRoots']=['/home/dev/code'];after['secrets']['fixture']='different-reference';(pathlib.Path(root)/'candidate-worker.json').write_text(json.dumps(after))
    with self.assertRaisesRegex(RuntimeError,'UNEXPECTED_WORKER_CONFIG_DELTA'):s.candidate_files()
    before['registration']['directorySelection']={'roots':['/fixture']};s.plan['expectedDirectorySelection']=before['registration']['directorySelection'];(pathlib.Path(root)/'before-worker.json').write_text(json.dumps(before))
    with self.assertRaisesRegex(RuntimeError,'UNAPPROVED_DIRECTORY_POLICY'):s.candidate_files()

if __name__=='__main__':unittest.main()
