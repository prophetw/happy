import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { DotTaskReclaimNotice } from '../../sources/components/dots/DotTaskReclaimNotice';
import { DotsWorkspacePanel } from '../../sources/components/dots/DotsWorkspaceHome';
const query=new URLSearchParams(window.location.search);
const node=query.has('task')?<DotTaskReclaimNotice projectID="fixture-project" requestID="send-live"
    directory={query.get('task')!} released={false} open={()=>{window.location.href='/';}}/>:<DotsWorkspacePanel session={{id:'fixture-workspace-session'} as never} workspaceId="00000000-0000-4000-8000-000000000001" active/>;
createRoot(document.getElementById('root')!).render(node);
