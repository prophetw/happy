import * as React from 'react';
import { Platform, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { apiSocket } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { workspaceManagerClient, workspaceManagerRpcClient } from '@/sync/workspaceManagement';
import { t } from '@/text';
import type { WorkspaceItem } from '@slopus/happy-wire';
import { WorkspaceReclaimNotice } from './WorkspaceReclaimNotice';

export function DotTaskReclaimNotice({ projectID, requestID, machineID, directory, released, state, reason, open }: {
    projectID: string; requestID: string; machineID?: string; directory: string; released: boolean;
    state?: string; reason?: string; open: () => void;
}) {
    const {credentials,isAuthenticated}=useAuth();
    const {theme}=useUnistyles();
    const server=getServerUrl(), token=credentials?.token, secret=credentials?.secret;
    const target=JSON.stringify([server,projectID,requestID,machineID,directory]);
    const native=Platform.OS!=='web';
    const current=React.useCallback(()=>!!token && isAuthenticated && server===getServerUrl()
        && token===sync.getCredentials()?.token && secret===sync.getCredentials()?.secret
        && (!native || !!machineID && !!storage.getState().machines[machineID]),[token,secret,isAuthenticated,server,native,machineID]);
    const client=React.useMemo(()=>native
        ? machineID && workspaceManagerRpcClient(machineID,current,(id,method,request)=>apiSocket.machineRPC(id,method,request))
        : workspaceManagerClient(token??'',current),[native,machineID,current,token]);
    const [sending,setSending]=React.useState(false);
    const [attempt,setAttempt]=React.useState(0);
    const [checked,save]=React.useState<{target:string;client:typeof client;attempt:number;item?:WorkspaceItem}>();
    React.useEffect(()=>{
        let waiting=true;
        const read=async()=>{
            if(!client || !current()) return;
            const catalog=await client.catalog();
            if (!catalog.projects.some(project=>project.id===projectID) || machineID && catalog.machineID!==machineID && native) return;
            const scope={machineID:catalog.machineID,projectID,action:'delivery-inventory' as const,requestID,guidance:true,reclaim:true as const};
            for (const view of (released?['released']:['pending','released']) as ('pending'|'released')[]) {
                const page=await client.inventory({...scope,view,limit:2});
                const choices=page.items.filter(item=>item.directory===directory && item.tasks.some(task=>task.requestID===requestID));
                if (choices.length===1) return choices[0];
                if (choices.length>1) return;
            }
        };
        const saveItem=(item?: WorkspaceItem)=>{if(waiting)save({target,client,attempt,item});};
        void read().then(saveItem,()=>saveItem());
        return ()=>{waiting=false;};
    },[client,current,projectID,requestID,machineID,native,directory,released,target,attempt]);
    const matching=checked?.target===target && checked.client===client && checked.attempt===attempt ? checked : undefined;
    const item=matching?.item;
    const refresh=()=>setAttempt(value=>value+1);
    React.useEffect(()=>{
        if(!item?.reclaimRequest || !['waiting','archiving','closing'].includes(item.reclaimRequest.state))return;
        const timer=setTimeout(refresh,25_000);
        return ()=>clearTimeout(timer);
    },[item]);
    const reclaim=item?.canRequestReclaim && client ? async()=>{
        if(sending||!current())return;
        setSending(true);
        try {
            const catalog=await client.catalog();
            if(current())await client.reclaim({machineID:catalog.machineID,projectID,workspaceID:item.id});
        } catch { /* The next scoped read reconciles the stable intent. */ }
        finally {setSending(false);refresh();}
    }:undefined;
    const fallback={state:released?'retired':'active',tasks:[],reasons:state?[['automatic_reclaim',state,reason??''].join(':')]:[]};
    return <>
        <WorkspaceReclaimNotice item={matching?.item??fallback} open={open} reclaim={reclaim}
            recheck={released?undefined:refresh} busy={sending||!released && !matching}/>
        {!released && (!matching || !matching.item) && <Text accessibilityLiveRegion="polite" style={{color:theme.colors.textSecondary}}>
            {t(matching?'workspaces.guidance.unavailable':'workspaces.guidance.activeCheck')}
        </Text>}
    </>;
}
