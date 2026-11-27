import * as React from 'react';
import { useAuth } from '@/auth/AuthContext';
import { sync } from '@/sync/sync';
import { storage, useSession } from '@/sync/storage';
import { getServerUrl } from '@/sync/serverConfig';
import { readTestloopDotsMetadata } from '@/sync/testloopDots';
import { workspaceManagerClient } from '@/sync/workspaceManagement';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { WorkspaceManagerPanel } from './WorkspaceManagerPanel';

export function DotsWorkspacesPanel({sessionId,workspaceId,onClose}:{sessionId:string;workspaceId:string;onClose:()=>void}) {
    const {credentials,isAuthenticated}=useAuth(),server=getServerUrl();
    const navigate=useNavigateToSession();
    const session=useSession(sessionId);
    const current=React.useCallback(()=>{
        const binding=readTestloopDotsMetadata(storage.getState().sessions[sessionId]?.metadata);
        return !!credentials?.token&&isAuthenticated&&credentials.token===sync.getCredentials()?.token
            &&credentials.secret===sync.getCredentials()?.secret&&server===getServerUrl()
            &&binding?.kind==='workspace'&&binding.workspaceId===workspaceId;
    },[credentials?.token,credentials?.secret,isAuthenticated,server,sessionId,workspaceId,session?.metadata]);
    const client=React.useMemo(()=>workspaceManagerClient(credentials?.token??'',current),[credentials?.token,current]);
    return <WorkspaceManagerPanel client={client} current={current} contextKey={`${server}:${sessionId}:${workspaceId}`} onClose={onClose} openSession={id=>{onClose();navigate(id);}}/>;
}
