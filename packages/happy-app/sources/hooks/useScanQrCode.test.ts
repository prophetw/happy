import { beforeEach, describe, expect, it, vi } from 'vitest';

type SourceButton = { text: string; onPress?: () => unknown; style?: string };
const mocks = vi.hoisted(() => ({
    platform: { OS: 'ios' },
    alert: vi.fn<(title: string, message?: string, buttons?: SourceButton[]) => void>(),
    setState: vi.fn(),
    pickImage: vi.fn(),
    scanImage: vi.fn(),
    checkCameraPermission: vi.fn(),
    launchScanner: vi.fn(),
    dismissScanner: vi.fn(),
    onModernBarcodeScanned: vi.fn(),
    authApprove: vi.fn(),
    authAccountApprove: vi.fn(),
}));

// Exercise source selection through the linking hooks without native UI modules.
vi.mock('react', () => ({
    useState: <T,>(initial: T) => [initial, mocks.setState],
    useRef: <T,>(value: T) => ({ current: value }),
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: () => void) => { effect(); },
}));
vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-camera', () => ({
    scanFromURLAsync: mocks.scanImage,
    CameraView: {
        launchScanner: mocks.launchScanner,
        dismissScanner: mocks.dismissScanner,
        isModernBarcodeScannerAvailable: true,
        onModernBarcodeScanned: mocks.onModernBarcodeScanned,
    },
}));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: mocks.pickImage }));
vi.mock('@/hooks/useCheckCameraPermissions', () => ({
    useCheckScannerPermissions: () => mocks.checkCameraPermission,
}));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 'test-token', secret: 'test-secret' } }),
}));
vi.mock('@/encryption/base64', () => ({ decodeBase64: () => new Uint8Array(32) }));
vi.mock('@/encryption/libsodium', () => ({ encryptBox: () => new Uint8Array(48) }));
vi.mock('@/sync/sync', () => ({ sync: { encryption: { contentDataKey: new Uint8Array(32) } } }));
vi.mock('@/components/haptics', () => ({ hapticsSuccess: vi.fn() }));
vi.mock('@/auth/authApprove', () => ({ authApprove: mocks.authApprove }));
vi.mock('@/auth/authAccountApprove', () => ({ authAccountApprove: mocks.authAccountApprove }));

import { useScanQrCode } from './useScanQrCode';
import { useConnectTerminal } from './useConnectTerminal';
import { useConnectAccount } from './useConnectAccount';

const image = { uri: 'file:///photos/qr.png', width: 1200, height: 1200 };
const terminalUrl = 'happy://terminal?test-public-key';
const accountUrl = 'happy:///account?test-public-key';

beforeEach(() => {
    vi.resetAllMocks();
    mocks.platform.OS = 'ios';
    mocks.pickImage.mockResolvedValue({ canceled: false, assets: [image] });
    mocks.scanImage.mockResolvedValue([{ data: terminalUrl, type: 'qr' }]);
    mocks.checkCameraPermission.mockResolvedValue(true);
    mocks.onModernBarcodeScanned.mockReturnValue({ remove: vi.fn() });
});

function sourceButtons() {
    const buttons = mocks.alert.mock.calls.find(([title]) => title === 'qrScanner.title')?.[2];
    expect(buttons).toBeDefined();
    return buttons!;
}

async function chooseSource(key: string) {
    const button = sourceButtons().find(({ text }) => text === key);
    expect(button).toBeDefined();
    await button!.onPress?.();
}

function createScanner() {
    const onScan = vi.fn().mockResolvedValue(true);
    const scanWithCamera = vi.fn().mockResolvedValue(undefined);
    const scanner = useScanQrCode({ urlPrefix: 'happy://terminal?', onScan, scanWithCamera });
    return { ...scanner, onScan, scanWithCamera };
}

describe.each([
    {
        flow: 'terminal',
        url: terminalUrl,
        connect: () => useConnectTerminal().connectTerminal(),
        approve: mocks.authApprove,
        otherApprove: mocks.authAccountApprove,
    },
    {
        flow: 'account',
        url: accountUrl,
        connect: () => useConnectAccount().connectAccount(),
        approve: mocks.authAccountApprove,
        otherApprove: mocks.authApprove,
    },
])('$flow linking', ({ url, connect, approve, otherApprove }) => {
    it.each(['ios', 'android'])('authorizes an image QR on %s without camera permission', async (platform) => {
        mocks.platform.OS = platform;
        mocks.checkCameraPermission.mockResolvedValue(false);
        mocks.scanImage.mockResolvedValue([{ data: 'https://example.com', type: 'qr' }, { data: url, type: 'qr' }]);

        await connect();
        expect(mocks.pickImage).not.toHaveBeenCalled();
        expect(mocks.checkCameraPermission).not.toHaveBeenCalled();
        await chooseSource('imageUpload.chooseFromLibrary');

        expect(mocks.scanImage).toHaveBeenCalledWith(image.uri, ['qr']);
        expect(approve).toHaveBeenCalledOnce();
        expect(approve.mock.calls[0][0]).toBe('test-token');
        expect(otherApprove).not.toHaveBeenCalled();
        expect(mocks.launchScanner).not.toHaveBeenCalled();
        expect(mocks.checkCameraPermission).not.toHaveBeenCalled();
    });

    it('keeps camera scanning and approval working', async () => {
        await connect();
        await chooseSource('qrScanner.scanWithCamera');
        expect(mocks.checkCameraPermission).toHaveBeenCalledOnce();
        expect(mocks.launchScanner).toHaveBeenCalledWith({ barcodeTypes: ['qr'] });

        const listener = mocks.onModernBarcodeScanned.mock.calls[0][0];
        await listener({ data: url });
        expect(mocks.dismissScanner).toHaveBeenCalledOnce();
        expect(approve).toHaveBeenCalledOnce();
        expect(otherApprove).not.toHaveBeenCalled();
        expect(mocks.pickImage).not.toHaveBeenCalled();
    });

    it('keeps camera permission failures visible', async () => {
        mocks.checkCameraPermission.mockResolvedValue(false);
        await connect();
        await chooseSource('qrScanner.scanWithCamera');
        expect(mocks.launchScanner).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenLastCalledWith('common.error', expect.stringContaining('cameraPermissions'), expect.any(Array));
        expect(approve).not.toHaveBeenCalled();
    });
});

describe('image QR source selection', () => {
    it('cancels source selection without opening either source', async () => {
        const scanner = createScanner();
        await scanner.scanQrCode();
        expect(sourceButtons().find(({ style }) => style === 'cancel')).toBeDefined();
        await chooseSource('common.cancel');
        expect(mocks.pickImage).not.toHaveBeenCalled();
        expect(scanner.scanWithCamera).not.toHaveBeenCalled();
    });

    it.each([
        { canceled: true, assets: null },
        { canceled: false, assets: [] },
    ])('handles empty picker results: %j', async (result) => {
        mocks.pickImage.mockResolvedValue(result);
        const scanner = createScanner();
        await scanner.scanQrCode();
        await chooseSource('imageUpload.chooseFromLibrary');
        expect(mocks.scanImage).not.toHaveBeenCalled();
        expect(scanner.onScan).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledOnce();
        expect(mocks.setState).toHaveBeenLastCalledWith(false);
    });

    it.each([
        { codes: [], message: 'qrScanner.noQrCode' },
        { codes: [{ data: 'https://example.com', type: 'qr' }], message: 'modals.invalidAuthUrl' },
        { codes: [{ data: accountUrl, type: 'qr' }], message: 'modals.invalidAuthUrl' },
    ])('rejects an unsuitable image with $message', async ({ codes, message }) => {
        mocks.scanImage.mockResolvedValue(codes);
        const scanner = createScanner();
        await scanner.scanQrCode();
        await chooseSource('imageUpload.chooseFromLibrary');
        expect(scanner.onScan).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenLastCalledWith('common.error', message);
        expect(mocks.setState).toHaveBeenLastCalledWith(false);
    });

    it.each(['picker', 'decoder', 'camera'])('reports a %s failure without an unhandled rejection', async (source) => {
        const scanner = createScanner();
        if (source === 'picker') mocks.pickImage.mockRejectedValue(new Error('picker unavailable'));
        if (source === 'decoder') mocks.scanImage.mockRejectedValue(new Error('image unreadable'));
        if (source === 'camera') scanner.scanWithCamera.mockRejectedValue(new Error('camera unavailable'));
        await scanner.scanQrCode();
        await chooseSource(source === 'camera' ? 'qrScanner.scanWithCamera' : 'imageUpload.chooseFromLibrary');
        expect(scanner.onScan).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenLastCalledWith('common.error', 'qrScanner.scanFailed');
    });

    it('prevents duplicate picking and authorization, then permits a retry', async () => {
        let finishPicking!: (value: unknown) => void;
        mocks.pickImage.mockReturnValueOnce(new Promise((resolve) => { finishPicking = resolve; }));
        const scanner = createScanner();
        await scanner.scanQrCode();
        const pending = chooseSource('imageUpload.chooseFromLibrary');
        await chooseSource('imageUpload.chooseFromLibrary');
        await scanner.scanQrCode();
        expect(mocks.pickImage).toHaveBeenCalledOnce();
        expect(mocks.alert).toHaveBeenCalledOnce();

        finishPicking({ canceled: false, assets: [image] });
        await pending;
        expect(scanner.onScan).toHaveBeenCalledExactlyOnceWith(terminalUrl);
        expect(mocks.setState).toHaveBeenLastCalledWith(false);

        await chooseSource('imageUpload.chooseFromLibrary');
        expect(mocks.pickImage).toHaveBeenCalledTimes(2);
        expect(scanner.onScan).toHaveBeenCalledTimes(2);
    });
});
