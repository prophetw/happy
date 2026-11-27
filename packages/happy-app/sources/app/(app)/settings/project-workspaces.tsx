import * as React from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { ProjectWorkspaceAccess } from '@/components/dots/ProjectWorkspaceAccess';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { getServerUrl } from '@/sync/serverConfig';
import { sync } from '@/sync/sync';

export default function ProjectWorkspacesScreen() {
    const { credentials, isAuthenticated } = useAuth();
    const server = getServerUrl(), router=useRouter(), navigate=useNavigateToSession();
    const query=useLocalSearchParams<{ projectID?:string;requestID?:string;machineID?:string }>();
    const readID=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:undefined;
    const projectID=readID(query.projectID), requestID=projectID?readID(query.requestID):undefined, machineID=readID(query.machineID);
    const current = React.useCallback(() => !!credentials?.token && isAuthenticated && server===getServerUrl()
        && credentials.token===sync.getCredentials()?.token && credentials.secret===sync.getCredentials()?.secret,
    [credentials?.token, credentials?.secret, isAuthenticated, server]);
    return <ProjectWorkspaceAccess key={JSON.stringify([server,projectID,requestID,machineID])}
        initialProjectID={projectID} originalRequestID={requestID} originalMachineID={machineID}
        token={credentials?.token??''} current={current} contextKey={server} openSession={navigate}
        onClose={()=>{ if(router.canGoBack()) router.back(); else router.replace('/settings'); }}/>;
}
