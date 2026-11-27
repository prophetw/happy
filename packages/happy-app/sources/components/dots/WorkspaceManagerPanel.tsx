import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { randomUUID } from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t, type TranslationKey } from '@/text';
import { workspacesEn } from '@/text/workspaces';
import type { WorkspaceCatalog, WorkspaceDetail, WorkspaceDelivery, WorkspaceDeliveryRequest, WorkspaceItem, WorkspaceTicket, WorkspaceWrite, WorkspaceMutationResult } from '@slopus/happy-wire';
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
    const delivery=item.delivery;
    if (delivery) return t(`workspaces.deliveryState.${delivery.state}`);
    if (item.state === 'retired') return t('workspaces.retired');
    if (item.plan?.eligible && item.plan.expiresAt > Date.now()) return t('workspaces.ready');
    if (item.reasons.includes('staged_unstaged_or_untracked') || item.reasons.includes('ignored_artifacts')) return t('workspaces.dirty');
    if (item.reasons.includes('queued_running_or_recovery_reference') || item.reasons.includes('live_session_or_process')) return t('workspaces.running');
    return t(item.managed && !item.reasons.includes('activity_unconfirmed') ? 'workspaces.pending' : 'workspaces.unknown');
}

/** Actual product view. Transport is injected so the same UI can exercise a
 * complete isolated Git-backed owner API without a live account or model. */
export function WorkspaceManagerPanel({ client, current, contextKey, onClose, openSession, initialProjectID, originalRequestID, machinePicker }: {
    client: WorkspaceManagerClient; current: () => boolean; contextKey: string; onClose: () => void; openSession?: (id:string) => void; initialProjectID?:string; originalRequestID?:string;
    machinePicker?: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const [catalog,setCatalog] = React.useState<WorkspaceCatalog|null>(null), [projectID,setProjectID] = React.useState('');
    const [renderScope,setRenderScope] = React.useState({client,contextKey});
    const [items,setItems] = React.useState<WorkspaceItem[]>([]), [total,setTotal] = React.useState(0), [next,setNext] = React.useState<string|null>(null);
    const [operationBusy,setBusy] = React.useState(false), [catalogLoading,setCatalogLoading] = React.useState(true), [error,setError] = React.useState<string|null>(null), [records,setRecords] = React.useState(false);
    const busy=operationBusy||catalogLoading;
    const [detail,setDetail] = React.useState<WorkspaceDetail|null>(null), [selected,setSelected] = React.useState<WorkspaceItem|null>(null), [ticket,setTicket] = React.useState<WorkspaceTicket|null>(null);
    const [agreed,setAgreed] = React.useState(false), [pending,setPending] = React.useState<Pending|null>(null);
    const [pendingRestored,setPendingRestored] = React.useState(false);
    const [acceptance,setAcceptance] = React.useState<{workspaceID: string; text: string} | null>(null);
    const [deliveryApproval,setDeliveryApproval]=React.useState<{id:string; evidence:string}|null>(null);
    const resumed=React.useRef(new Set<string>());
    const deliveryRun=React.useRef<string|null>(null);
    const [delivering,setDelivering]=React.useState<string|null>(null);
    const [review,setReview] = React.useState<'adopt'|'integrated'|'no-change'|'archived'|null>(null), [clock,setClock] = React.useState(Date.now());
    const epoch = React.useRef(0), catalogAttempt = React.useRef(0), mounted = React.useRef(true), locked = React.useRef(false), pendingRef = React.useRef<Pending|null>(null);
    const scope = catalog && projectID ? { machineID:catalog.machineID,projectID } : null;
    const [focused,setFocused]=React.useState(!!originalRequestID);
    const scroll = React.useRef<ScrollView>(null);
    const project = catalog?.projects.find(p=>p.id===projectID);
    const cacheKey = catalog && projectID ? `workspace-owner:${catalog.ownerID}:${catalog.machineID}:${projectID}:${contextKey}` : '';
    const valid = (version: number) => mounted.current && epoch.current === version && current();
    const displayCatalog = (catalog: WorkspaceCatalog) => {
        setCatalog(catalog);
        const next = initialProjectID ? catalog.projects.find(project => project.id === initialProjectID) : catalog.projects[0];
        setProjectID(next?.id ?? '');
        if (initialProjectID && !next) setError('WORKSPACE_PROJECT_UNAVAILABLE');
    };
    React.useEffect(() => { scroll.current?.scrollTo({ y: 0, animated: false }); }, [selected?.id]);
    React.useEffect(() => { mounted.current=true; return()=>{mounted.current=false;epoch.current++;}; },[]);
    React.useEffect(() => { const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer); },[]);
    React.useEffect(() => {
        epoch.current++;const attempt=++catalogAttempt.current;const validCatalog=()=>mounted.current&&catalogAttempt.current===attempt&&current();
        locked.current=false;setBusy(false);setCatalogLoading(true);setError(null);setCatalog(null);setProjectID('');setSelected(null);setDeliveryApproval(null);setDetail(null);setTicket(null);setItems([]);setPending(null);pendingRef.current=null;
        setRenderScope({client,contextKey});setAcceptance(null);
        void client.catalog().then(value=>{if(validCatalog())displayCatalog(value);})
            .catch(e=>{if(validCatalog())setError(e instanceof Error?e.message:'WORKSPACE_MANAGER_UNAVAILABLE');})
            .finally(()=>{if(validCatalog())setCatalogLoading(false);});
        return()=>{epoch.current++;catalogAttempt.current++;};
    },[client,contextKey,initialProjectID]);
    const load = async (after?: string, readRecords = records) => {
        if(!scope||locked.current||!current())return;
        const version=epoch.current;locked.current=true;setBusy(true);setError(null);setTicket(null);setAgreed(false);
        try {
            const authority=await client.catalog();
            if(!valid(version))return;
            setCatalog(authority);
            if(authority.ownerID!==catalog!.ownerID||authority.machineID!==scope.machineID||!authority.projects.some(p=>p.id===scope.projectID)){
                setItems([]);setSelected(null);setDeliveryApproval(null);setDetail(null);setProjectID('');
                setError('WORKSPACE_PROJECT_UNAVAILABLE');return;
            }
            const page=await client.inventory({action:'delivery-inventory',...scope,view:readRecords?'released':'pending',requestID:focused&&projectID===initialProjectID?originalRequestID:undefined,limit:5,...(after?{after}:{})});
            if(valid(version)){setItems(old=>[...new Map([...(after?old:[]),...page.items].map(item=>[item.id,item])).values()]);setTotal(page.total);setNext(page.next);}}
        catch(e){if(valid(version))setError(e instanceof Error?e.message:'WORKSPACE_MANAGER_UNAVAILABLE');}
        finally{if(valid(version)){locked.current=false;setBusy(false);}}
    };
    React.useEffect(()=>{
        if(!cacheKey||renderScope.client!==client||renderScope.contextKey!==contextKey)return;
        const version=++epoch.current;locked.current=false;pendingRef.current=null;setPendingRestored(false);setPending(null);setSelected(null);setDeliveryApproval(null);setDetail(null);setTicket(null);setReview(null);setAgreed(false);setItems([]);setNext(null);
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
    },[cacheKey,focused]);
    const unsettled = !pendingRestored || !!pending && pending.result?.status !== 'settled';
    const action = async <T,>(task:()=>Promise<T>,done:(value:T)=>void) => {
        if(locked.current||!current())return;
        const version=epoch.current;locked.current=true;setBusy(true);setError(null);
        try {const value=await task();if(valid(version))done(value);}
        catch(e){if(valid(version))setError(e instanceof Error?e.message:'WORKSPACE_MANAGER_UNAVAILABLE');}
        finally{if(valid(version)){locked.current=false;setBusy(false);}}
    };
    const updateDelivery = (request: WorkspaceDeliveryRequest) => {
        if(deliveryRun.current||!current())return;
        const version=epoch.current;
        deliveryRun.current=request.operationID;
        setError(null);setDeliveryApproval(null);setDelivering(request.workspaceID);
        void client.deliver(request).then(async receipt=>{
            if(!valid(version))return;
            const change=(item:WorkspaceItem):WorkspaceItem=>item.id===request.workspaceID&&item.delivery
                ? {...item,delivery:{...item.delivery,receipt,canStart:false,
                    ...(receipt.phase==='released'?{state:'released' as const,next:'none' as const}
                        :receipt.phase==='merged'?{state:'merged' as const,next:'finalize' as const}:{})}}
                :item;
            setItems(old=>old.map(change));setSelected(old=>old&&change(old));
            if(selected?.id===request.workspaceID&&receipt.phase==='released'&&scope) {
                const currentDetail=await client.detail({action:'detail',...scope,workspaceID:request.workspaceID});
                if(valid(version))setDetail(old=>old?.item.id===request.workspaceID?currentDetail:old);
            }
        }).catch(error=>{
            if(valid(version))setError(error instanceof Error?error.message:'WORKSPACE_RESULT_UNKNOWN');
        }).finally(()=>{
            deliveryRun.current=null;
            if(mounted.current)setDelivering(null);
        });
    };
    React.useEffect(()=>{
        if(!scope||busy||delivering||records||selected) return;
        const item=items.find(row=>row.delivery?.receipt
            && (!row.delivery.receipt.blocker||['WORKSPACE_DELIVERY_PR_CI_WAIT','WORKSPACE_DELIVERY_PR_APPROVAL','WORKSPACE_DELIVERY_PR_NOT_READY'].includes(row.delivery.receipt.blocker))
            && row.delivery.receipt.phase!=='released' && !resumed.current.has(row.delivery.receipt.operationID));
        const receipt=item?.delivery?.receipt;
        if(!item||!receipt) return;
        resumed.current.add(receipt.operationID);
        updateDelivery({action:'resume-delivery',...scope,workspaceID:item.id,operationID:receipt.operationID});
    },[items, busy, delivering, cacheKey, records, selected]);
    const inspect = (item:WorkspaceItem) => {
        if(item.state==='unclaimed'||item.state==='mapping-missing') { setSelected(item);return; }
        if(scope)void action(()=>client.detail({action:'detail',...scope,workspaceID:item.id}),value=>{
            setSelected(item);setDetail(value);setTicket(null);setAgreed(false);setReview(null);
        });
    };
    const write = async (request:Mutation, retry=false) => {
        if(!scope||!pendingRestored||locked.current||!current()||(!retry&&pendingRef.current&&pendingRef.current.result?.status!=='settled'))return;
        const version=epoch.current,key=cacheKey;locked.current=true;setBusy(true);setError(null);
        const state:Pending={request};pendingRef.current=state;setPending(state);setReview(null);setAcceptance(null);setTicket(null);setAgreed(false);
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
    const deliveryEvidence = (value: WorkspaceDelivery, expanded = false) => <>
        <Text style={muted}>{t(`workspaces.directoryState.${value.directory}`)} · {t(`workspaces.registrationState.${value.registration}`)} · {t(`workspaces.ownershipState.${value.ownership}`)}</Text>
        {value.receipt?.blocker&&reasons(value.receipt.blocker.split(','))}
        {value.dirty&&<Text style={text}>{t('workspaces.dirty')}{value.untracked?` · ${t('workspaces.untracked')}`:''}</Text>}
        <Text style={text}>{t(`workspaces.deliveryNext.${value.next}`)}</Text>
        {expanded&&<>
            <Text selectable style={muted}>{t('workspaces.target')} · {value.remote??'—'} / {value.targetRef}</Text>
            <Text selectable style={muted}>{t('workspaces.head')} · {value.head??'—'}{'\n'}{t('workspaces.remoteTarget')} · {value.remoteHead??'—'}{'\n'}{t('workspaces.remoteBranch')} · {value.pushedHead??'—'}</Text>
            {value.receipt&&<><Text selectable style={muted}>{t('workspaces.operation')} · {value.receipt.operationID}</Text>
                <Text style={text}>{t(`workspaces.deliveryPhase.${value.receipt.phase}`)}</Text>
                {value.receipt.targetRef&&<Text selectable style={muted}>{t('workspaces.authorizedTarget')} · {value.receipt.remote} / {value.receipt.targetRef} · {value.receipt.branch}</Text>}
                {value.receipt.testedOn&&<Text selectable style={muted}>{t('workspaces.testBase')} · {value.receipt.testedOn}</Text>}
                {value.receipt.testExitCode!==undefined&&<Text selectable style={muted}>{t('workspaces.tested')} · {value.receipt.head} · {value.receipt.testExitCode}</Text>}
                {value.receipt.pullRequest&&<Text style={muted}>PR #{value.receipt.pullRequest}</Text>}</>}
            {value.proof&&<Text style={muted}>{t(`workspaces.deliveryProof.${value.proof}`)}</Text>}
            <Text selectable style={muted}>{t('workspaces.tested')} · {value.test?`${value.test.commit} · ${value.test.status}`:t('workspaces.never')}</Text>
            <Text style={muted}>{t('workspaces.checked')} · {new Date(value.observedAt).toLocaleString()}</Text>
        </>}
    </>;
    const receipt=pending?.result?.receipt;
    const visible=records?items.filter(item=>item.delivery?.state==='released'||!item.delivery
        &&(item.state==='retired'||['removed','failed','applying'].includes(item.lastOperation?.state??''))):items;
    if(renderScope.client!==client||renderScope.contextKey!==contextKey||!current())return <View style={{padding:18,gap:12}}><Text style={muted}>{t('workspaces.loading')}</Text>{button(t('workspaces.close'),onClose,false)}</View>;
    return <View style={{flex:1,backgroundColor:theme.colors.surface}}>
        <ScrollView ref={scroll} contentInsetAdjustmentBehavior="never" contentContainerStyle={{padding:18,gap:18,width:'100%',maxWidth:1080,alignSelf:'center',paddingBottom:40}} keyboardShouldPersistTaps="handled">
            <View style={{...row,justifyContent:'space-between'}}><View style={{flex:1,minWidth:160}}><Text accessibilityRole="header" style={{...text,fontSize:26,fontWeight:'600'}}>{t('workspaces.title')}</Text><Text style={muted}>{t('workspaces.subtitle')}</Text></View>{button(t('workspaces.close'),onClose,false)}</View>
            {machinePicker}
            {catalog&&<><Text style={muted}>{t('workspaces.machine')} · {catalog.machineName} · {catalog.machineID}</Text>
                <View style={row}>{catalog.projects.map(p=><View key={p.id}>{button(p.name,()=>{if(p.id!==projectID){epoch.current++;setFocused(false);setPendingRestored(false);setSelected(null);setDeliveryApproval(null);setDetail(null);setTicket(null);setReview(null);setItems([]);setPending(null);pendingRef.current=null;setProjectID(p.id);}},busy)}</View>)}</View>
                <Text style={muted}>{project?`${project.name} · ${project.allowApply?t('workspaces.explicit'):t('workspaces.disabled')} · ${t('workspaces.autoOff')}`:t('workspaces.noProjects')}</Text></>}
            <View style={row}>{button(t('workspaces.listing'),()=>{setRecords(false);setSelected(null);setDeliveryApproval(null);setDetail(null);setTicket(null);void load(undefined,false);},busy)}{button(t('workspaces.records'),()=>{setRecords(true);setSelected(null);setDeliveryApproval(null);setDetail(null);setTicket(null);void load(undefined,true);},busy)}
                {focused&&button(t('workspaces.showAll'),()=>setFocused(false),busy)}
                {button(t('workspaces.refresh'),()=>{setSelected(null);setDeliveryApproval(null);setDetail(null);if(scope)void load();else void action(()=>client.catalog(),displayCatalog);},busy)}</View>
            {busy&&<View accessibilityLiveRegion="polite" style={row}><ActivityIndicator/><Text style={muted}>{detail?t('workspaces.loadingDetail'):t('workspaces.loading')}</Text></View>}
            {delivering&&<Text accessibilityLiveRegion="polite" style={muted}>{t('workspaces.deliveryRunning')}</Text>}
            {error&&<Text accessibilityRole="alert" style={{...text,color:'#a34036'}}>{reason(error)}</Text>}
            {pending&&<View style={card}><Text style={{...text,fontWeight:'600'}}>{t('workspaces.receipt')}</Text><Text selectable style={muted}>{t('workspaces.operation')} · {pending.request.operationID}</Text>
                <Text accessibilityLiveRegion="polite" style={text}>{pending.result?.status==='settled'?(receipt?.state==='removed'?t('workspaces.removed'):receipt?.state==='resolved'?t('workspaces.resolved'):receipt?.state==='adopted'?t('workspaces.adopted'):t('workspaces.failed'))
                    :pending.result?.status==='unknown'?t('workspaces.unknownRequest'):t('workspaces.pendingRequest')}</Text>
                {receipt?.reason&&reasons(receipt.reason.split(','))}
                {receipt?.retainedRef&&<Text selectable style={muted}>{t('workspaces.retained')} · {receipt.retainedRef}</Text>}
                <View style={row}>{button(t('workspaces.query'),query,busy)}{unsettled&&button(t('workspaces.retry'),()=>{void write(pending.request,true);},busy)}</View>
            </View>}
            {(selected?.state==='unclaimed'||selected?.state==='mapping-missing')?<View style={card}>
                {button(t('workspaces.back'),()=>setSelected(null),busy)}
                <Text style={{...text,fontWeight:'600'}}>{status(selected)}</Text><Text selectable style={text}>{selected.directory}</Text>
                {selected.delivery&&deliveryEvidence(selected.delivery,true)}
                {selected.tasks.map(task=><View key={task.id}><Text selectable style={muted}>{t('workspaces.request')} · {task.requestID}</Text>
                    {openSession&&button(t('workspaces.openSession'),()=>openSession(task.sessionID),busy)}</View>)}
            </View>:detail?<View style={{gap:14}}>{button(t('workspaces.back'),()=>{setSelected(null);setDeliveryApproval(null);setDetail(null);setTicket(null);setReview(null);void load();},busy)}
                <View style={card}><Text style={{...text,fontWeight:'600'}}>{status({...detail.item,plan:detail.plan,delivery:selected?.delivery})}</Text><Text selectable style={text}>{detail.item.directory}</Text><Text selectable style={muted}>{t('workspaces.branch')} · {detail.item.branch??'—'}</Text>{reasons(detail.plan.reasons)}
                    <Text style={muted}>{t('workspaces.checked')} · {new Date(detail.plan.checkedAt).toLocaleString()}</Text>
                    {selected?.delivery&&deliveryEvidence(selected.delivery,true)}</View>
                <View style={card}><Text style={{...text,fontWeight:'600'}}>{t('workspaces.evidence')}</Text>
                    <Text selectable style={muted}>{t('workspaces.head')} · {detail.inspectedHead??'—'}{`\n`}{t('workspaces.main')} · {detail.plan.mainCommit??detail.result.disposition?.mainCommit??'—'}</Text>
                    {detail.result.disposition?<><Text style={text}>{detail.result.disposition.kind} · {detail.result.disposition.proof}</Text><Text selectable style={muted}>{t('workspaces.retained')} · {detail.result.disposition.retainedRef}</Text></>:<Text style={muted}>{t('workspaces.noEvidence')}</Text>}
                    {detail.item.tasks.map(task=><View key={task.id}><Text selectable style={muted}>{t('workspaces.task')} · {task.id}{`\n`}{t('workspaces.session')} · {task.sessionID} · {task.state}{task.resultCommit?`\n${task.resultCommit}`:''}</Text>{task.requestID&&<Text selectable style={muted}>{t('workspaces.request')} · {task.requestID}</Text>}{openSession&&button(t('workspaces.openSession'),()=>openSession(task.sessionID),busy)}</View>)}
                    <Text style={muted}>{t('workspaces.taskLimit')}</Text>
                    {selected?.delivery?.receipt&&selected.delivery.receipt.phase!=='released'&&scope
                        &&button(t('workspaces.resumeDelivery'),()=>updateDelivery({action:'resume-delivery',...scope,workspaceID:selected.id,
                            operationID:selected.delivery!.receipt!.operationID}),busy||unsettled||!!delivering)}
                    {selected?.delivery?.canStart&&detail.inspectedHead&&detail.item.tasks.at(-1)?.requestID
                        &&detail.item.tasks.at(-1)?.resultCommit===detail.inspectedHead
                        &&button(t('workspaces.startDelivery'),()=>setDeliveryApproval({id:detail.item.id,evidence:''}),busy||unsettled||!!delivering||!!selected.delivery.dirty)}
                    {deliveryApproval?.id===detail.item.id&&scope&&<View style={{gap:8}}>
                        <Text style={muted}>{t('workspaces.deliveryAuthorization')}</Text>
                        <TextInput accessibilityLabel={t('workspaces.acceptanceEvidence')} value={deliveryApproval.evidence} maxLength={16000} multiline
                            style={{...text,borderWidth:1,borderColor:theme.colors.divider,padding:8}}
                            onChangeText={value=>setDeliveryApproval({...deliveryApproval,evidence:value})}/>
                        <View style={row}>{button(t('workspaces.authorizeDelivery'),()=>{
                            const source=detail.item.tasks.at(-1);
                            if(!detail.inspectedHead||!source?.requestID) return;
                            const operationID=randomUUID();
                            resumed.current.add(operationID);
                            updateDelivery({action:'start-delivery',...scope,workspaceID:detail.item.id,operationID,head:detail.inspectedHead,
                                requestID:source.requestID,evidence:deliveryApproval.evidence.trim()||undefined});
                        },busy||unsettled)}{button(t('workspaces.cancel'),()=>setDeliveryApproval(null),busy)}</View>
                    </View>}
                    {detail.item.state!=='retired'&&<View style={row}>{!detail.item.managed&&button(t('workspaces.adopt'),()=>setReview('adopt'),busy||unsettled||!detail.adoptionVerified)}
                        {detail.item.managed&&<>{button(t('workspaces.integrated'),()=>setReview('integrated'),busy||unsettled||!detail.inspectedHead)}{button(t('workspaces.noChange'),()=>setReview('no-change'),busy||unsettled||!detail.inspectedHead)}
                            {project?.allowArchive&&button(t('workspaces.archive'),()=>setReview('archived'),busy||unsettled||!detail.inspectedHead)}</>}</View>}
                    {!project?.allowArchive&&<Text style={muted}>{t('workspaces.archiveDisabled')}</Text>}
                    {detail.item.state!=='retired'&&detail.item.canFinalizeIntegrated&&button(t('workspaces.finalize'),()=>setAcceptance({workspaceID:detail.item.id,text:''}),busy||unsettled||!detail.inspectedHead)}
                    {acceptance?.workspaceID===detail.item.id&&<View style={{gap:8}}>
                        <Text style={muted}>{t('workspaces.finalizeHelp')}</Text>
                        <TextInput accessibilityLabel={t('workspaces.acceptanceEvidence')} value={acceptance.text} maxLength={16000} multiline
                            style={{...text,borderWidth:1,borderColor:theme.colors.divider,padding:8}} onChangeText={value=>setAcceptance({...acceptance,text:value})}/>
                        <View style={row}>
                            {button(t('workspaces.finalizeSubmit'),()=>{if(scope&&detail.inspectedHead)void write({action:'finalize-integrated',...scope,
                                workspaceID:detail.item.id,operationID:randomUUID(),head:detail.inspectedHead,evidence:acceptance.text.trim()});},
                                busy||unsettled||!acceptance.text.trim()||!detail.inspectedHead,true)}
                            {button(t('workspaces.cancel'),()=>setAcceptance(null),busy)}
                        </View>
                    </View>}
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
            </View>:<><Text style={muted}>{t('workspaces.total')} · {total}</Text>{visible.map(item=><View key={item.id} testID={`workspace-${item.id}`} style={card}>
                <View style={{...row,justifyContent:'space-between'}}><Text style={{...text,fontWeight:'600'}}>{status(item)}</Text>{button(t('workspaces.inspect'),()=>inspect(item),busy)}</View>
                <Text selectable style={text}>{item.directory}</Text><Text selectable style={muted}>{t('workspaces.branch')} · {item.branch??'—'} · {t('workspaces.task')} {item.taskCount}</Text>
                {item.delivery&&deliveryEvidence(item.delivery)}{reasons(item.reasons)}
                {item.lastOperation?.reason&&reasons(item.lastOperation.reason.split(','))}
                <Text style={muted}>{t('workspaces.checked')} · {item.delivery||item.lastVerification?new Date(item.delivery?.observedAt??item.lastVerification!).toLocaleString():t('workspaces.never')}</Text>
            </View>)}{!busy&&!visible.length&&<Text style={muted}>{t(records?'workspaces.noRecords':'workspaces.noItems')}</Text>}{next&&button(t('workspaces.loadMore'),()=>{void load(next);},busy)}</>}
        </ScrollView>
    </View>;
}
