import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { DotsEntryView } from '@/components/DotsEntryView';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { ActivityIndicator, Platform } from 'react-native';

// Production previews require an explicit web build flag as well as the URL opt-in.
const prototypeAvailable = __DEV__ || (Platform.OS === 'web' && process.env.EXPO_PUBLIC_DOTS_PROTOTYPE === '1');
const DotsPrototype = prototypeAvailable ? React.lazy(() => import('@/components/dots-prototype/DotsPrototype')) : null;

export default function DotsEntryScreen() {
    const { prototype } = useLocalSearchParams<{ prototype?: string }>();
    if (prototype === '1' && DotsPrototype) return <React.Suspense fallback={<ActivityIndicator />}>
        <DotsPrototype topContentInset={Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0} />
    </React.Suspense>;
    return <DotsEntryView topContentInset={Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0} />;
}
