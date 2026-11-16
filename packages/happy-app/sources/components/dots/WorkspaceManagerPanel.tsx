import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { randomUUID } from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t, type TranslationKey } from '@/text';
import { workspacesEn } from '@/text/workspaces';
import type { WorkspaceCatalog, WorkspaceDetail, WorkspaceItem, WorkspaceTicket, WorkspaceWrite, WorkspaceMutationResult } from '@slopus/happy-wire';
import { workspaceWriteSchema, workspaceMutationResultSchema } from '@slopus/happy-wire';
import type { WorkspaceManagerClient } from '@/sync/workspaceManagement';
import { WorkspaceManagerError } from '@/sync/workspaceManagement';

type Mutation = Exclude<WorkspaceWrite,{action:'plan'}>;
type Pending = { request: Mutation; result?: WorkspaceMutationResult };
function reason(code: string) {
    return Object.hasOwn(workspacesEn.reasons, code) ? t(`workspaces.reasons.${code}` as TranslationKey)
        : `${t('workspaces.unknown')} · ${code}`;
}
function status(item: WorkspaceItem) {
    if (item.state === 'retired') return t('workspaces.retired');
    if (item.plan?.eligible && item.plan.expiresAt > Date.now()) return t('workspaces.ready');
    if (item.reasons.includes('staged_unstaged_or_untracked') || item.reasons.includes('ignored_artifacts')) return t('workspaces.dirty');
    if (item.reasons.includes('queued_running_or_recovery_reference') || item.reasons.includes('live_session_or_process')) return t('workspaces.running');
    return t(item.managed && !item.reasons.includes('activity_unconfirmed') ? 'workspaces.pending' : 'workspaces.unknown');
}

/** Actual product view. Transport is injected so the same UI can exercise a
 * complete isolated Git-backed owner API without a live account or model. */
export function WorkspaceManagerPanel({ client, current, contextKey, onClose }: {
    client: WorkspaceManagerClient; current: () => boolean; contextKey: string; onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const [catalog,setCatalog] = React.useState<WorkspaceCatalog|null>(null), [projectID,setProjectID] = React.useState('');
    const [renderScope,setRenderScope] = React.useState({client,contextKey});
    const [items,setItems] = React.useState<WorkspaceItem[]>([]), [total,setTotal] = React.useState(0), [next,setNext] = React.useState<string|null>(null);
    const [operationBusy,setBusy] = React.useState(false), [catalogLoading,setCatalogLoading] = React.useState(true), [error,setError] = React.useState<string|null>(null), [records,setRecords] = React.useState(false);
    const busy=operationBusy||catalogLoading;
    const [detail,setDetail] = React.useState<WorkspaceDetail|null>(null), [ticket,setTicket] = React.useState<WorkspaceTicket|null>(null);
    const [agreed,setAgreed] = React.useState(false), [pending,setPending] = React.useState<Pending|null>(null);
    const [pendingRestored,setPendingRestored] = React.useState(false);
    const [review,setReview] = React.useState<'adopt'|'integrated'|'no-change'|'archived'|null>(null), [clock,setClock] = React.useState(Date.now());
    const epoch = React.useRef(0), catalogAttempt = React.useRef(0), mounted = React.useRef(true), locked = React.useRef(false), pendingRef = React.useRef<Pending|null>(null);
    const scope = catalog && projectID ? { machineID:catalog.machineID,projectID } : null;
    const project = catalog?.projects.find(p=>p.id===projectID);
    const cacheKey = catalog && projectID ? `workspace-owner:${catalog.ownerID}:${catalog.machineID}:${projectID}:${contextKey}` : '';
    const valid = (version: number) => mounted.current && epoch.current === version && current();
    React.useEffect(() => { mounted.current=true; return()=>{mounted.current=false;epoch.current++;}; },[]);
    React.useEffect(() => { const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer); },[]);
    React.useEffect(() => {
        epoch.current++;const attempt=++catalogAttempt.current;const validCatalog=()=>mounted.current&&catalogAttempt.current===attempt&&current();
        locked.current=false;setBusy(false);setCatalogLoading(true);setError(null);setCatalog(null);setProjectID('');setDetail(null);setTicket(null);setItems([]);setPending(null);pendingRef.current=null;
        setRenderScope({client,contextKey});
        void client.catalog().then(value=>{if(validCatalog()){setCatalog(value);setProjectID(value.projects[0]?.id??'');}})
            .catch(e=>{if(validCatalog())setError(e instanceof Error?e.message:'WORKSPACE_MANAGER_UNAVAILABLE');})
            .finally(()=>{if(validCatalog())setCatalogLoading(false);});
        return()=>{epoch.current++;catalogAttempt.current++;};
    },[client,contextKey]);
    const load = async (after?: string) => {
        if(!scope||locked.current||!current())return;
        const version=epoch.current;locked.current=true;setBusy(true);setError(null);setTicket(null);setAgreed(false);
        try {
            const authority=await client.catalog();
            if(!valid(version))return;
            setCatalog(authority);
            if(authority.ownerID!==catalog!.ownerID||authority.machineID!==scope.machineID||!authority.projects.some(p=>p.id===scope.projectID)){
                setItems([]);setDetail(null);setProjectID(authority.projects[0]?.id??'');return;
            }
            const page=await client.inventory({action:'inventory',...scope,limit:5,...(after?{after}:{})});
            if(valid(version)){setItems(old=>[...new Map([...(after?old:[]),...page.items].map(item=>[item.directory,item])).values()]);setTotal(page.total);setNext(page.next);}}
        catch(e){if(valid(version))setError(e instanceof Error?e.message:'WORKSPACE_MANAGER_UNAVAILABLE');}
        finally{if(valid(version)){locked.current=false;setBusy(false);}}
    };
    React.useEffect(()=>{
        if(!cacheKey||renderScope.client!==client||renderScope.contextKey!==contextKey)return;
        const version=++epoch.current;locked.current=false;pendingRef.current=null;setPendingRestored(false);setPending(null);setDetail(null);setTicket(null);setReview(null);setAgreed(false);setItems([]);setNext(null);
        void AsyncStorage.getItem(cacheKey).then(raw=>{
            if(!raw||!valid(version))return;
            const parsed=JSON.parse(raw) as Pending;
            const request=workspaceWriteSchema.parse(parsed.request);
            if(request.action==='plan'||request.projectID!==projectID||request.machineID!==catalog!.machineID)return;
            const result=parsed.result?workspaceMutationResultSchema.parse(parsed.result):undefined;
            if(result&&result.operationID!==request.operationID)throw Error('WORKSPACE_RESULT_UNKNOWN');
            const restored={request,...(result?{result}:{})};pendingRef.current=restored;setPending(restored);
        }).catch(()=>{if(valid(version))setError('WORKSPACE_RESULT_UNKNOWN');}).finally(()=>{if(valid(version))setPendingRestored(true);});
        void load();
    },[cacheKey]);
    const unsettled = !pendingRestored || !!pending && pending.result?.status !== 'settled';
    const action = async <T,>(task:()=>Promise<T>,done:(value:T)=>void) => {
        if(locked.current||!current())return;
        const version=epoch.current;locked.current=true;setBusy(true);setError(null);
        try {const value=await task();if(valid(version))done(value);}
        catch(e){if(valid(version))setError(e instanceof Error?e.message:'WORKSPACE_MANAGER_UNAVAILABLE');}
        finally{if(valid(version)){locked.current=false;setBusy(false);}}
    };
    const inspect = (item:WorkspaceItem) => {if(scope)void action(()=>client.detail({action:'detail',...scope,workspaceID:item.id}),value=>{
        setDetail(value);setTicket(null);setAgreed(false);setReview(null);
    });};
    const write = async (request:Mutation, retry=false) => {
        if(!scope||!pendingRestored||locked.current||!current()||(!retry&&pendingRef.current&&pendingRef.current.result?.status!=='settled'))return;
        const version=epoch.current,key=cacheKey;locked.current=true;setBusy(true);setError(null);
        const state:Pending={request};pendingRef.current=state;setPending(state);setReview(null);setTicket(null);setAgreed(false);
        let known:WorkspaceMutationResult|undefined;
        try {
            await AsyncStorage.setItem(key,JSON.stringify(state)); // Persist identity before any write request.
            const result=await client.mutate(request);known=result;const value={request,result};
            await AsyncStorage.setItem(key,JSON.stringify(value));
            if(valid(version)){pendingRef.current=value;setPending(value);if(result.error)setError(result.error);
                if(result.receipt&&detail?.item.id===request.workspaceID)void client.detail({action:'detail',...scope,workspaceID:request.workspaceID})
                    .then(v=>{if(valid(version))setDetail(v);}).catch(()=>{if(valid(version))setError('WORKSPACE_MANAGER_UNAVAILABLE');});}
        } catch(e) {
            const rejected=!retry&&e instanceof WorkspaceManagerError&&e.rejected;
            const value={request,result:known??{operationID:request.operationID,status:rejected?'settled' as const:'unknown' as const,
                ...(rejected?{error:e.message}:{})}};
            await AsyncStorage.setItem(key,JSON.stringify(value)).catch(()=>{});
            if(valid(version)){pendingRef.current=value;setPending(value);setError(e instanceof Error?e.message:'WORKSPACE_RESULT_UNKNOWN');}
        } finally {if(valid(version)){locked.current=false;setBusy(false);}}
    };
    const query = () => {
        const p=pendingRef.current;if(!scope||!p)return;
        void action(()=>client.result({action:'result',...scope,workspaceID:p.request.workspaceID,operationID:p.request.operationID}),value=>{
            if(!('operationID' in value))return;
            const state={request:p.request,result:value};pendingRef.current=state;setPending(state);void AsyncStorage.setItem(cacheKey,JSON.stringify(state));
        });
    };
    const createPlan = () => {if(scope&&detail)void action(()=>client.plan({action:'plan',...scope,workspaceID:detail.item.id}),value=>{setTicket(value);setAgreed(false);});};
    const reviewResult = () => {
        if(!scope||!detail||!review||!detail.inspectedHead)return;
        const common={...scope,workspaceID:detail.item.id,operationID:randomUUID(),revision:detail.item.revision,head:detail.inspectedHead};
        void write(review==='adopt'?{action:'adopt',...common}:{action:'resolve',...common,kind:review});
    };
    const text={color:theme.colors.text,lineHeight:22},muted={color:theme.colors.textSecondary,fontSize:13,lineHeight:21};
    const row={flexDirection:'row' as const,flexWrap:'wrap' as const,gap:10,alignItems:'center' as const};
    const card={borderWidth:1,borderColor:theme.colors.divider,borderRadius:14,padding:16,gap:10};
    const button=(label:string,onPress:()=>void,disabled=busy,danger=false)=><Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}}
        disabled={disabled} onPress={onPress} style={{minHeight:44,padding:12,borderRadius:9,backgroundColor:danger?'#973b37':theme.colors.surfaceHigh,opacity:disabled?0.5:1}}>
        <Text style={{...text,color:danger?'#fff':text.color,fontWeight:'600'}}>{label}</Text></Pressable>;
    const reasons=(codes:string[])=>codes.map(code=><Text key={code} style={muted}>• {reason(code)}</Text>);
    const receipt=pending?.result?.receipt;
    const visible=records?items.filter(item=>item.state==='retired'||['removed','failed','applying'].includes(item.lastOperation?.state??'')):items;
    if(renderScope.client!==client||renderScope.contextKey!==contextKey||!current())return <View style={{padding:18,gap:12}}><Text style={muted}>{t('workspaces.loading')}</Text>{button(t('workspaces.close'),onClose,false)}</View>;
    return <View style={{flex:1,backgroundColor:theme.colors.surface}}>
        <ScrollView contentContainerStyle={{padding:18,gap:18,width:'100%',maxWidth:1080,alignSelf:'center',paddingBottom:40}} keyboardShouldPersistTaps="handled">
            <View style={{...row,justifyContent:'space-between'}}><View style={{flex:1,minWidth:160}}><Text accessibilityRole="header" style={{...text,fontSize:26,fontWeight:'600'}}>{t('workspaces.title')}</Text><Text style={muted}>{t('workspaces.subtitle')}</Text></View>{button(t('workspaces.close'),onClose,false)}</View>
            {catalog&&<><Text style={muted}>{t('workspaces.machine')} · {catalog.machineName} · {catalog.machineID}</Text>
                <View style={row}>{catalog.projects.map(p=><View key={p.id}>{button(p.name,()=>{if(p.id!==projectID){epoch.current++;setPendingRestored(false);setDetail(null);setTicket(null);setReview(null);setItems([]);setPending(null);pendingRef.current=null;setProjectID(p.id);}},busy)}</View>)}</View>
                <Text style={muted}>{project?`${project.name} · ${project.allowApply?t('workspaces.explicit'):t('workspaces.disabled')} · ${t('workspaces.autoOff')}`:t('workspaces.noProjects')}</Text></>}
            <View style={row}>{button(t('workspaces.listing'),()=>{setRecords(false);setDetail(null);setTicket(null);},busy)}{button(t('workspaces.records'),()=>{setRecords(true);setDetail(null);setTicket(null);},busy)}
                {button(t('workspaces.refresh'),()=>{setDetail(null);if(scope)void load();else void action(()=>client.catalog(),v=>{setCatalog(v);setProjectID(v.projects[0]?.id??'');});},busy)}</View>
            {busy&&<View accessibilityLiveRegion="polite" style={row}><ActivityIndicator/><Text style={muted}>{detail?t('workspaces.loadingDetail'):t('workspaces.loading')}</Text></View>}
            {error&&<Text accessibilityRole="alert" style={{...text,color:'#a34036'}}>{reason(error)}</Text>}
            {!catalog&&!busy&&button(t('workspaces.refresh'),()=>{void action(()=>client.catalog(),v=>{setCatalog(v);setProjectID(v.projects[0]?.id??'');});},false)}
            {pending&&<View style={card}><Text style={{...text,fontWeight:'600'}}>{t('workspaces.receipt')}</Text><Text selectable style={muted}>{t('workspaces.operation')} · {pending.request.operationID}</Text>
                <Text accessibilityLiveRegion="polite" style={text}>{pending.result?.status==='settled'?(receipt?.state==='removed'?t('workspaces.removed'):receipt?.state==='resolved'?t('workspaces.resolved'):receipt?.state==='adopted'?t('workspaces.adopted'):t('workspaces.failed'))
                    :pending.result?.status==='unknown'?t('workspaces.unknownRequest'):t('workspaces.pendingRequest')}</Text>
                {receipt?.reason&&<Text style={muted}>{reason(receipt.reason)}</Text>}
                {receipt?.retainedRef&&<Text selectable style={muted}>{t('workspaces.retained')} · {receipt.retainedRef}</Text>}
                <View style={row}>{button(t('workspaces.query'),query,busy)}{unsettled&&button(t('workspaces.retry'),()=>{void write(pending.request,true);},busy)}</View>
            </View>}
            {detail?<View style={{gap:14}}>{button(t('workspaces.back'),()=>{setDetail(null);setTicket(null);setReview(null);void load();},busy)}
                <View style={card}><Text style={{...text,fontWeight:'600'}}>{status({...detail.item,plan:detail.plan})}</Text><Text selectable style={text}>{detail.item.directory}</Text><Text selectable style={muted}>{t('workspaces.branch')} · {detail.item.branch??'—'}</Text>{reasons(detail.plan.reasons)}
                    <Text style={muted}>{t('workspaces.checked')} · {new Date(detail.plan.checkedAt).toLocaleString()}</Text></View>
                <View style={card}><Text style={{...text,fontWeight:'600'}}>{t('workspaces.evidence')}</Text>
                    <Text selectable style={muted}>{t('workspaces.head')} · {detail.inspectedHead??'—'}{`\n`}{t('workspaces.main')} · {detail.plan.mainCommit??detail.result.disposition?.mainCommit??'—'}</Text>
                    {detail.result.disposition?<><Text style={text}>{detail.result.disposition.kind} · {detail.result.disposition.proof}</Text><Text selectable style={muted}>{t('workspaces.retained')} · {detail.result.disposition.retainedRef}</Text></>:<Text style={muted}>{t('workspaces.noEvidence')}</Text>}
                    {detail.item.tasks.map(task=><Text key={task.id} selectable style={muted}>{t('workspaces.task')} · {task.id}{`\n`}{t('workspaces.session')} · {task.sessionID} · {task.state}{task.resultCommit?`\n${task.resultCommit}`:''}</Text>)}
                    <Text style={muted}>{t('workspaces.taskLimit')}</Text>
                    {detail.item.state!=='retired'&&<View style={row}>{!detail.item.managed&&button(t('workspaces.adopt'),()=>setReview('adopt'),busy||unsettled||!detail.adoptionVerified)}
                        {detail.item.managed&&<>{button(t('workspaces.integrated'),()=>setReview('integrated'),busy||unsettled||!detail.inspectedHead)}{button(t('workspaces.noChange'),()=>setReview('no-change'),busy||unsettled||!detail.inspectedHead)}
                            {project?.allowArchive&&button(t('workspaces.archive'),()=>setReview('archived'),busy||unsettled||!detail.inspectedHead)}</>}</View>}
                    {!project?.allowArchive&&<Text style={muted}>{t('workspaces.archiveDisabled')}</Text>}
                </View>
                {review&&<View style={card}><Text style={text}>{review==='adopt'?t('workspaces.adoptHelp'):t('workspaces.reviewHelp')}</Text><View style={row}>{button(t('workspaces.confirmReview'),reviewResult,busy||unsettled)}{button(t('workspaces.cancel'),()=>setReview(null),busy)}</View></View>}
                {detail.result.operations?.map(op=><View key={op.id} style={card}><Text selectable style={muted}>{op.id} · {op.state}{op.head?`\n${op.head}`:''}</Text>{op.reason&&<Text style={muted}>{reason(op.reason)}</Text>}</View>)}
                {detail.result.rebuild&&<View style={card}><Text style={{...text,fontWeight:'600'}}>{t('workspaces.recovery')}</Text><Text style={muted}>{t('workspaces.recoveryHelp')}</Text><Text selectable style={muted}>{t('workspaces.recoveryDirectory')} · {detail.result.rebuild.args.at(-2)}{`\n`}{t('workspaces.recoveryBranch')} · {detail.result.rebuild.args[5]}</Text></View>}
                {detail.item.state!=='retired'&&button(t('workspaces.plan'),createPlan,busy||unsettled)}
                {ticket&&<View testID="workspace-plan-confirmation" style={{...card,borderColor:'#bc8265'}}><Text accessibilityRole="header" style={{...text,fontWeight:'600'}}>{t('workspaces.confirmTitle')}</Text><Text selectable style={text}>{detail.item.directory}</Text>
                    <Text style={muted}>{t('workspaces.expires')} · {new Date(ticket.plan.expiresAt).toLocaleString()}</Text><Text style={muted}>{t('workspaces.keep')}</Text>{reasons(ticket.plan.reasons)}
                    {clock>=ticket.plan.expiresAt?<Text accessibilityRole="alert" style={text}>{t('workspaces.expired')}</Text>:!ticket.plan.eligible?<Text style={text}>{t('workspaces.blocked')}</Text>:<Pressable accessibilityRole="checkbox" accessibilityLabel={t('workspaces.agree')} accessibilityState={{checked:agreed,disabled:busy}}
                        disabled={busy} onPress={()=>setAgreed(!agreed)} style={{minHeight:48,padding:12}}><Text style={text}>{agreed?'☑':'☐'} {t('workspaces.agree')}</Text></Pressable>}
                    <View style={row}>{button(t('workspaces.apply'),()=>{if(scope&&agreed&&ticket.plan.eligible&&ticket.plan.expiresAt>Date.now()&&ticket.plan.workspaceID===detail.item.id)void write({action:'apply',...scope,workspaceID:detail.item.id,operationID:randomUUID(),ticket:ticket.ticket,confirmedPlanID:ticket.plan.id});},busy||unsettled||!agreed||!ticket.plan.eligible||clock>=ticket.plan.expiresAt,true)}{button(t('workspaces.cancel'),()=>{setTicket(null);setAgreed(false);},busy)}</View>
                </View>}
            </View>:<><Text style={muted}>{t('workspaces.total')} · {total}</Text>{visible.map(item=><View key={item.directory} testID={`workspace-${item.id}`} style={card}>
                <View style={{...row,justifyContent:'space-between'}}><Text style={{...text,fontWeight:'600'}}>{status(item)}</Text>{button(t('workspaces.inspect'),()=>inspect(item),busy)}</View>
                <Text selectable style={text}>{item.directory}</Text><Text selectable style={muted}>{t('workspaces.branch')} · {item.branch??'—'} · {t('workspaces.task')} {item.taskCount}</Text>
                {reasons(item.reasons)}<Text style={muted}>{t('workspaces.checked')} · {item.lastVerification?new Date(item.lastVerification).toLocaleString():t('workspaces.never')}</Text>
            </View>)}{!busy&&!visible.length&&<Text style={muted}>{t(records?'workspaces.noRecords':'workspaces.noItems')}</Text>}{next&&button(t('workspaces.loadMore'),()=>{void load(next);},busy)}</>}
        </ScrollView>
    </View>;
}
