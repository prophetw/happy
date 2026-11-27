import * as React from 'react';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { WorkspaceManagerPanel } from '@/components/dots/WorkspaceManagerPanel';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { getServerUrl } from '@/sync/serverConfig';
import { sync } from '@/sync/sync';
import { workspaceManagerClient } from '@/sync/workspaceManagement';

export default function ProjectWorkspacesScreen() {
    const { credentials, isAuthenticated } = useAuth();
    const server = getServerUrl(), router=useRouter(), navigate=useNavigateToSession();
    const query=useLocalSearchParams<{ projectID?:string;requestID?:string }>();
    const readID=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:undefined;
    const projectID=readID(query.projectID), requestID=projectID?readID(query.requestID):undefined;
    const current = React.useCallback(() => !!credentials?.token && isAuthenticated && server===getServerUrl()
        && credentials.token===sync.getCredentials()?.token && credentials.secret===sync.getCredentials()?.secret,
    [credentials?.token, credentials?.secret, isAuthenticated, server]);
    const client=React.useMemo(()=>workspaceManagerClient(credentials?.token??'',current),[credentials?.token,current]);
    return <>
        <Stack.Screen options={{headerShown:false}}/>
        <WorkspaceManagerPanel key={JSON.stringify([projectID,requestID])} initialProjectID={projectID} originalRequestID={requestID} client={client} current={current} contextKey={server} openSession={navigate}
            onClose={()=>{ if(router.canGoBack()) router.back(); else router.replace('/settings'); }}/>
    </>;
}
