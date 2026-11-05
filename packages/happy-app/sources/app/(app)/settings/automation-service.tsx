import * as React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { automationApprovalApi } from '@/auth/automationApproval';
import { getServerUrl } from '@/sync/serverConfig';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { ServiceConnectionForm } from '@/components/automation/ServiceAccess';
export default function ServiceAuthorization() {
    const auth = useAuth(), router = useRouter(), params = useLocalSearchParams<{ from?: string }>();
    const api = React.useMemo(() => automationApprovalApi(getServerUrl(), () => {
        if (!auth.credentials?.token) throw new Error('OWNER_AUTH_REQUIRED');
        return `Bearer ${auth.credentials.token}`;
    }), [auth.credentials?.token]);
    return <><Stack.Screen options={{ title: '服务授权' }} /><ItemList><ItemGroup><ServiceConnectionForm api={api} sourceID={params.from} onCreated={id => router.push(`/settings/automation?connection=${id}`)} /></ItemGroup></ItemList></>;
}
