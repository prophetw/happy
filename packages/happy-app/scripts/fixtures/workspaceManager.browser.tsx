import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { DotsWorkspacePanel } from '../../sources/components/dots/DotsWorkspaceHome';
createRoot(document.getElementById('root')!).render(<DotsWorkspacePanel session={{id:'fixture-workspace-session'} as never} workspaceId="00000000-0000-4000-8000-000000000001" active/>);
