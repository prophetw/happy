import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSettingMutable } from '@/sync/storage';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { Switch } from './Switch';
import { t } from '@/text';

export function SessionNotificationSettings() {
    const [alwaysPush, setAlwaysPush] = useSettingMutable('alwaysPushToPhone');
    const [haptics, setHaptics] = useSettingMutable('sessionNotificationHaptics');
    return (
        <ItemGroup title={t('sessionNotifications.title')}>
            <Item title={t('sessionNotifications.alwaysPush')} subtitle={t('sessionNotifications.alwaysPushDescription')}
                icon={<Ionicons name="notifications-outline" size={29} color="#007AFF" />}
                rightElement={<Switch value={alwaysPush} onValueChange={setAlwaysPush} />} />
            <Item title={t('sessionNotifications.haptics')} subtitle={t('sessionNotifications.hapticsDescription')}
                icon={<Ionicons name="phone-portrait-outline" size={29} color="#34C759" />}
                rightElement={<Switch value={haptics} onValueChange={setHaptics} />} />
        </ItemGroup>
    );
}
