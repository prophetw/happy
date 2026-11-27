import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { t, type TranslationKey } from '@/text';
import { workspacesEn } from '@/text/workspaces';
import type { WorkspaceItem } from '@slopus/happy-wire';

const prefix = 'automatic_reclaim:';
const staged = 'staged_unstaged_or_untracked';
const temporary = 'WORKSPACE_TEMPORARY_ARTIFACTS';
const used = 'live_session_or_process';
const waiting = new Set([
    used, 'task_running', 'retirement_in_progress', 'workspace_idle_close_pending',
    'queued_running_or_recovery_reference', 'open_file_reference', 'process_entrypoint_reference', 'mount_reference',
    'activity_unconfirmed', 'process_visibility_unconfirmed', 'session_mapping_unconfirmed',
    'WORKSPACE_REMOTE_UNCONFIRMED', 'WORKSPACE_NOT_IN_MAIN', 'WORKSPACE_IN_USE',
    'WORKSPACE_CONTROL_UNAVAILABLE', 'WORKSPACE_MANAGER_BUSY', 'WORKTREE_PREPARATION_UNCONFIRMED',
]);
const automaticChecks = new Set([
    'result_needs_disposition','no_change_needs_resolution','business_acceptance_required',
    'policy_changed_reverify_disposition','target_main_changed_reverify_disposition','result_changed_reverify_disposition',
]);
const humanAction = new Set([
    temporary, staged, 'ignored_artifacts', 'WORKSPACE_UNSAVED_ARTIFACTS', 'WORKSPACE_HEAD_CHANGED',
    'result_needs_disposition', 'no_change_needs_resolution', 'policy_changed_reverify_disposition',
    'target_main_changed_reverify_disposition', 'result_changed_reverify_disposition', 'WORKSPACE_OWNER_UNCONFIRMED',
    'WORKSPACE_SHARED_TASKS', 'WORKSPACE_REFLOG_ONLY_RESULTS', 'WORKSPACE_GITDIR_ONLY_RESULTS',
    'WORKSPACE_GITDIR_ARTIFACTS', 'business_acceptance_required',
]);
type Item = Pick<WorkspaceItem, 'reasons'|'state'|'delivery'|'lastOperation'|'plan'|'tasks'|'reclaimGuidance'>;
type CopyKey = keyof typeof workspacesEn.guidance;
const copy = (key: CopyKey) => t(`workspaces.guidance.${key}` as TranslationKey);
export function workspaceReason(code: string) {
    if (code===used) return copy('use');
    if (code===staged || code==='WORKSPACE_UNSAVED_ARTIFACTS') return copy('dirty');
    if (code==='ignored_artifacts') return copy('ignored');
    if (code===temporary) return copy('temporary');
    return Object.hasOwn(workspacesEn.reasons,code) ? t(`workspaces.reasons.${code}` as TranslationKey) : copy('generic');
}

export function workspaceReclaimStatus(item: Pick<Item,'reasons'|'state'|'lastOperation'>) {
    if (item.state==='retired' || item.lastOperation?.state==='removed') return {state:'released',reason:undefined};
    const [,state,reason] = item.reasons.find(value=>value.startsWith(prefix))?.split(':') ?? [];
    return state ? {state,reason} : undefined;
}

function taskStatus(status: string): CopyKey {
    if (status==='completed') return 'taskCompleted';
    if (status==='failed') return 'taskFailed';
    if (status==='cancelled') return 'taskCancelled';
    if (['preparing','running','canceling'].includes(status)) return 'taskRunning';
    return ['queued','waiting-resource'].includes(status) ? 'taskQueued' : 'taskUnknown';
}

export function WorkspaceReclaimNotice({item, expanded=false, error, busy=false, recheck, open, openSession}: {
    item:Item; expanded?:boolean; error?:string; busy?:boolean; recheck?:()=>void; open?:()=>void; openSession?:(sessionID:string)=>void;
}) {
    const {rt} = useUnistyles();
    const dark = rt?.themeName==='dark';
    const status = workspaceReclaimStatus(item);
    const released = status?.state==='released' || item.delivery?.state==='released';
    const fresh = !!item.reclaimGuidance || !!item.plan;
    const planReasons = item.plan?.reasons ?? item.reasons.filter(code=>!code.startsWith(prefix));
    const actions = [...new Set([
        ...planReasons,
        ...(item.reclaimGuidance?.reasons ?? []),
        // A previous automated observation can be newer or differ in authority
        // from the manual plan. Fresh local evidence supersedes old local blockers.
        ...(status?.reason && (!fresh || ['WORKSPACE_NOT_IN_MAIN','WORKSPACE_REMOTE_UNCONFIRMED','workspace_idle_close_pending'].includes(status.reason)) ? [status.reason] : []),
        ...(!fresh && item.delivery?.dirty ? [staged] : []),
    ])].filter(code=>code!=='already_retired' && (!status || !automaticChecks.has(code)));
    const hasAction = actions.some(code=>humanAction.has(code)) || !!error;
    const autoWait = status?.state==='waiting' && !hasAction && actions.every(code=>waiting.has(code));
    const planReady = item.plan?.eligible && (item.plan.expiresAt>Date.now()) && actions.length===0 && !error;
    const title = released ? 'resolved' : hasAction || actions.length || status?.state==='attention'
        ? (autoWait?'waiting':'blocked') : autoWait?'waiting':planReady?'ready':fresh?'manual':'unchecked';
    const palette = released || title==='ready' ? (dark?['#d5fbe4','#153729','#42b88a']:['#155440','#eefbf4','#16815c'])
        : title==='waiting'||title==='manual'||title==='unchecked' ? (dark?['#ffe5ad','#3c2b15','#eab562']:['#663a05','#fff5db','#ad680d'])
        : (dark?['#ffdee1','#461820','#ff868e']:['#8b1720','#fff0f2','#b22531']);
    const [ink, backgroundColor, borderColor]=palette;
    const text = {color:ink,lineHeight:21};
    const button = (label:CopyKey,onPress:()=>void) => <Pressable onPress={onPress} disabled={busy} accessibilityRole="button" accessibilityLabel={copy(label)}
        accessibilityState={{disabled:busy}} style={{borderWidth:1,borderColor,borderRadius:8,paddingHorizontal:12,
            minHeight:44,justifyContent:'center',alignSelf:'flex-start',opacity:busy?0.65:1}}>
        <Text style={{...text,fontWeight:'600'}}>{copy(label)}</Text>
    </Pressable>;
    const temp=item.reclaimGuidance?.temporary, latest=item.tasks.at(-1);
    const occupies=actions.some(code=>[used,'queued_running_or_recovery_reference','open_file_reference','process_entrypoint_reference','workspace_idle_close_pending'].includes(code));
    const messages = actions.map(code=>({code,label:workspaceReason(code)}));
    const unique = messages.filter((entry,index)=>messages.findIndex(value=>value.label===entry.label)===index);
    return <View testID="workspace-reclaim-notice" accessibilityLiveRegion="polite"
        style={{backgroundColor,borderColor,borderWidth:1,borderStartWidth:5,borderRadius:12,padding:12,gap:7}}>
        <Text accessibilityRole={title==='blocked'?'alert':'header'} style={{...text,fontWeight:'700',fontSize:17}}>
            {copy(title)}
        </Text>
        {!released && hasAction && <Text style={{...text,fontWeight:'700'}}>{copy('needs')}</Text>}
        {(open || !released && recheck) && <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
            {open && button('open',open)}
            {!released && recheck && button('recheck',recheck)}
        </View>}
        {!released && <>
            {error && <Text style={text}>{copy('rejected')} {workspaceReason(error)}</Text>}
            {unique.map(({code,label})=><Text key={code} style={text}>• {hasAction && humanAction.has(code) ? copy('actionLabel')+' · '
                : hasAction && waiting.has(code) ? copy('waitLabel')+' · ' : ''}{label}
                {code===temporary && temp ? ` · ${temp.bounded?copy('atLeast')+' ':''}${temp.count}` : ''}
            </Text>)}
            {!expanded && actions.includes(temporary) && <Text style={text}>{copy('temporaryBrief')}</Text>}
            {expanded && temp && <View style={{gap:4}}>
                <Text style={text}>{copy('temporaryNext')}</Text>
                <Text selectable style={text}>{temp.directory}</Text>
                {!!temp.names?.length && <Text selectable style={text}>{copy('names')} · {temp.names.join(' · ')}</Text>}
                {status && <Text style={text}>{copy('knownCache')}</Text>}
            </View>}
            {expanded && (actions.includes(staged) || actions.includes('WORKSPACE_UNSAVED_ARTIFACTS') || actions.includes('ignored_artifacts'))
                && <Text style={text}>{copy('dirtyNext')}</Text>}
            {occupies && latest && <Text selectable style={text}>{copy('links')} · {latest.requestID??latest.id} · {copy(taskStatus(latest.state))}
                {expanded? `\n${latest.sessionID}` : ''}
            </Text>}
            {occupies && <Text style={text}>{copy('useNext')}</Text>}
            {expanded && occupies && latest && openSession && <Pressable accessibilityRole="button" onPress={()=>openSession(latest.sessionID)}
                style={{borderWidth:1,borderColor,borderRadius:8,paddingHorizontal:12,minHeight:44,justifyContent:'center',alignSelf:'flex-start'}}>
                <Text style={{...text,fontWeight:'600'}}>{t('workspaces.openSession')}</Text>
            </Pressable>}
            {status && autoWait ? <Text style={text}>{copy('auto')}</Text>
                : !status && fresh && !planReady && <Text style={text}>{copy('legacy')}</Text>}
            {expanded && item.reclaimGuidance && <Text style={text}>{copy('checkTime')} · {new Date(item.reclaimGuidance.checkedAt).toLocaleString()}</Text>}
        </>}
    </View>;
}
