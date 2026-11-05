import { DotsEntryView } from '@/components/DotsEntryView';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Platform } from 'react-native';

export default function DotsEntryScreen() {
    return <DotsEntryView topContentInset={Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0} />;
}
