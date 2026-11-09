import * as React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';

const MAX_SCALE = 5;

function clampOffset(value: number, imageSize: number, viewportSize: number, scale: number) {
    'worklet';
    const limit = Math.max(0, (imageSize * scale - viewportSize) / 2);
    return Math.max(-limit, Math.min(limit, value));
}

/** Uses the already decrypted attachment; opening a preview never downloads it again. */
export function AttachmentImagePreview({ uri, name, onClose }: {
    uri: string;
    name: string;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const [viewport, setViewport] = React.useState({ width: 0, height: 0 });
    const [imageSize, setImageSize] = React.useState({ width: 0, height: 0 });
    const scale = useSharedValue(1);
    const startScale = useSharedValue(1);
    const x = useSharedValue(0);
    const y = useSharedValue(0);
    const startX = useSharedValue(0);
    const startY = useSharedValue(0);

    const fit = imageSize.width > 0 && imageSize.height > 0
        ? Math.min(viewport.width / imageSize.width, viewport.height / imageSize.height)
        : 0;
    const imageWidth = imageSize.width * fit;
    const imageHeight = imageSize.height * fit;

    React.useEffect(() => {
        // Re-centre when the window rotates or the preview source changes.
        scale.value = 1;
        x.value = 0;
        y.value = 0;
    }, [uri, viewport.width, viewport.height, scale, x, y]);

    const pinch = Gesture.Pinch()
        .onStart(() => { startScale.value = scale.value; })
        .onUpdate(event => {
            scale.value = Math.max(1, Math.min(MAX_SCALE, startScale.value * event.scale));
            x.value = clampOffset(x.value, imageWidth, viewport.width, scale.value);
            y.value = clampOffset(y.value, imageHeight, viewport.height, scale.value);
        });
    const pan = Gesture.Pan().maxPointers(1)
        .onStart(() => {
            startX.value = x.value;
            startY.value = y.value;
        })
        .onUpdate(event => {
            x.value = clampOffset(startX.value + event.translationX, imageWidth, viewport.width, scale.value);
            y.value = clampOffset(startY.value + event.translationY, imageHeight, viewport.height, scale.value);
        });
    const doubleTap = Gesture.Tap().numberOfTaps(2)
        .onEnd((event, success) => {
            if (!success) return;
            const nextScale = scale.value > 1 ? 1 : 3;
            // Zoom towards the tapped part of a long screenshot.
            x.value = clampOffset((viewport.width / 2 - event.x) * (nextScale - 1), imageWidth, viewport.width, nextScale);
            y.value = clampOffset((viewport.height / 2 - event.y) * (nextScale - 1), imageHeight, viewport.height, nextScale);
            scale.value = nextScale;
        });
    const imageStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
    }));

    return (
        <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
            <GestureHandlerRootView style={styles.container}>
                <View style={[styles.header, { paddingTop: insets.top + 8, paddingLeft: insets.left + 16, paddingRight: insets.right + 8 }]}>
                    <Text numberOfLines={1} style={styles.filename}>{name}</Text>
                    <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.back')} style={styles.close}>
                        <Ionicons name="close" size={28} color="#fff" />
                    </Pressable>
                </View>
                <View style={[styles.container, { marginBottom: insets.bottom }]}>
                    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)} touchAction="none">
                        <View
                            collapsable={false}
                            style={styles.viewport}
                            onLayout={event => {
                                const { width, height } = event.nativeEvent.layout;
                                setViewport({ width, height });
                            }}
                        >
                            <Animated.View style={[styles.image, imageStyle]}>
                                <Image
                                    source={{ uri }}
                                    contentFit="contain"
                                    style={styles.image}
                                    accessibilityLabel={name}
                                    onLoad={event => setImageSize({ width: event.source.width, height: event.source.height })}
                                />
                            </Animated.View>
                        </View>
                    </GestureDetector>
                </View>
            </GestureHandlerRootView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 8 },
    filename: { flex: 1, color: '#fff', fontSize: 15 },
    close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    viewport: { flex: 1, overflow: 'hidden' },
    image: { width: '100%', height: '100%' },
});
