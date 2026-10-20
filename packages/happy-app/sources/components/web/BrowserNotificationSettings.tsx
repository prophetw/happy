import * as React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSettingMutable } from '@/sync/storage';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Switch } from '@/components/Switch';
import { t } from '@/text';
import { Modal } from '@/modal';
import { getBrowserNotificationPermission, requestBrowserNotificationPermission } from '@/utils/web/browserNotifications';

export function BrowserNotificationSettings() {
    return Platform.OS === 'web' ? <BrowserSettings /> : null;
}

function BrowserSettings() {
    const [enabled, setEnabled] = useLocalSettingMutable('desktopNotificationsEnabled');
    const [permission, setPermission] = React.useState(getBrowserNotificationPermission);
    const [requesting, setRequesting] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const inFlight = React.useRef(false);

    React.useEffect(() => {
        const refresh = () => setPermission(getBrowserNotificationPermission());
        let status: PermissionStatus | undefined;
        let disposed = false;
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
            void navigator.permissions.query({ name: 'notifications' }).then(result => {
                if (disposed) return;
                status = result;
                status.addEventListener('change', refresh);
                refresh();
            }).catch(() => {
                // Some browsers do not expose notification permission through
                // this API. Focus/visibility changes still refresh their state.
            });
        }
        return () => {
            disposed = true;
            status?.removeEventListener('change', refresh);
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, []);

    const toggle = async (value: boolean) => {
        if (inFlight.current) return;
        setFailed(false);
        if (!value) {
            setEnabled(false);
            return;
        }
        inFlight.current = true;
        setRequesting(true);
        try {
            const result = await requestBrowserNotificationPermission();
            setPermission(result);
            setEnabled(result === 'granted');
        } catch {
            setFailed(true);
            setEnabled(false);
        } finally {
            inFlight.current = false;
            setRequesting(false);
        }
    };
    const checked = enabled && permission === 'granted';
    const blocked = permission === 'denied';
    const unavailable = permission === 'unsupported' || permission === 'insecure';
    const subtitle = failed ? t('browserNotifications.error')
        : permission === 'denied' ? t('browserNotifications.blocked')
        : permission === 'unsupported' ? t('browserNotifications.unsupported')
        : permission === 'insecure' ? t('browserNotifications.insecure')
        : t('browserNotifications.description');

    return (
        <ItemGroup title={t('browserNotifications.title')}>
            <Item title={blocked ? t('browserNotifications.manage') : t('browserNotifications.enable')} subtitle={subtitle} subtitleLines={0}
                icon={<Ionicons name="notifications-outline" size={29} color="#007AFF" />}
                onPress={blocked ? () => Modal.alert(t('browserNotifications.title'), t('browserNotifications.instructions')) : undefined}
                showChevron={blocked} loading={requesting}
                rightElement={blocked ? undefined : <Switch accessibilityLabel={t('browserNotifications.enable')} value={checked}
                    disabled={unavailable || requesting} onValueChange={value => { void toggle(value); }} />} />
        </ItemGroup>
    );
}
