import * as React from 'react';
import { Platform } from 'react-native';
import { scanFromURLAsync } from 'expo-camera';
import { launchImageLibraryAsync } from 'expo-image-picker';
import { Modal } from '@/modal';
import { t } from '@/text';

interface UseScanQrCodeOptions {
    urlPrefix: string;
    onScan: (url: string) => Promise<boolean>;
    scanWithCamera: () => Promise<void>;
}

/** Shares the source chooser between terminal and account linking. */
export function useScanQrCode({ urlPrefix, onScan, scanWithCamera }: UseScanQrCodeOptions) {
    const [isPickingImage, setIsPickingImage] = React.useState(false);
    const isPickingImageRef = React.useRef(false);

    const pickImage = React.useCallback(async () => {
        if (isPickingImageRef.current) return;
        isPickingImageRef.current = true;
        setIsPickingImage(true);
        try {
            // The system photo picker grants access to the selected image only;
            // neither camera nor full photo-library permission is needed.
            const result = await launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsEditing: false,
                allowsMultipleSelection: false,
                quality: 1,
                exif: false,
            });
            if (result.canceled || !result.assets.length) return;

            const codes = await scanFromURLAsync(result.assets[0].uri, ['qr']);
            if (codes.length === 0) {
                Modal.alert(t('common.error'), t('qrScanner.noQrCode'));
                return;
            }

            const code = codes.find((candidate) => candidate.data.startsWith(urlPrefix));
            if (!code) {
                Modal.alert(t('common.error'), t('modals.invalidAuthUrl'));
                return;
            }
            await onScan(code.data);
        } catch {
            Modal.alert(t('common.error'), t('qrScanner.scanFailed'));
        } finally {
            isPickingImageRef.current = false;
            setIsPickingImage(false);
        }
    }, [onScan, urlPrefix]);

    const openCamera = React.useCallback(async () => {
        try {
            await scanWithCamera();
        } catch {
            Modal.alert(t('common.error'), t('qrScanner.scanFailed'));
        }
    }, [scanWithCamera]);

    const scanQrCode = React.useCallback(async () => {
        if (isPickingImageRef.current) return;
        if (Platform.OS === 'web') {
            await openCamera();
            return;
        }
        Modal.alert(t('qrScanner.title'), undefined, [
            { text: t('qrScanner.scanWithCamera'), onPress: openCamera },
            { text: t('imageUpload.chooseFromLibrary'), onPress: pickImage },
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    }, [openCamera, pickImage]);

    return { scanQrCode, isPickingImage };
}
