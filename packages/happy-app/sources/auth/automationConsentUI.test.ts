vi.mock('@/components/DirectoryPicker',()=>({DirectoryPicker:'DirectoryPicker'}));
import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ compatibility: vi.fn(), consent: vi.fn(), list: vi.fn(), approve: vi.fn(), revoke: vi.fn(), params: { connection: 'connection_1' } }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator', AppState: { addEventListener: () => ({ remove() {} }) }, Platform: { OS: 'web', select: (v: any) => v.web ?? v.default } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: '#111', textSecondary: '#666', surfaceHigh: '#fafafa', surfaceHighest: '#eee', success: '#080', divider: '#ddd', textDestructive: '#a00', input: { placeholder: '#666', background: '#eee' }, button: { primary: { background: '#111', tint: '#fff' } } } };
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => mocks.params, useRouter: () => ({ push: vi.fn() }), useFocusEffect: (effect: React.EffectCallback) => React.useEffect(effect, [effect]) }));
vi.mock('expo-camera', () => ({ CameraView: { isModernBarcodeScannerAvailable: false } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: { token: 'fixture-owner', get secret() { throw new Error('Account secret must not be accessed'); } } }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://fixture.invalid/home-relay' }));
vi.mock('@/auth/automationApproval', async importOriginal => ({ ...(await importOriginal() as any), automationApprovalApi: () => mocks }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/qr', () => ({ QRCode: 'QRCode' }));
vi.mock('@/hooks/useScanQrCode', () => ({ useScanQrCode: () => ({ scanQrCode: vi.fn() }) }));
vi.mock('@/hooks/useCheckCameraPermissions', () => ({ useCheckScannerPermissions: () => vi.fn() }));

import AutomationConnections from '@/app/(app)/settings/automation';
const view = { id: 'connection_1', userID: 'userA', clientID: 'assistant', clientName: 'Fixture assistant', clientFingerprint: 'client_fingerprint',
    workerID: 'worker', workerName: 'Fixture worker', workerFingerprint: 'worker_fingerprint', machineID: 'machineA', projectID: 'projectA', projectDirectory: '/approved/project',
    methods: ['tasks.create','sessions.cancel'], sessionIDs: [], expiresAt: Date.now()+60000, pendingUntil: Date.now()+60000, state: 'pending', digest: 'd'.repeat(64), challenge: 'challenge', disclosure: '明文范围声明' };
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.params = { connection: 'connection_1' };
    vi.resetAllMocks(); mocks.compatibility.mockResolvedValue({ protocol: 1, approval: 1, worker: 1 }); mocks.list.mockResolvedValue([]); mocks.consent.mockResolvedValue(view);
    mocks.approve.mockImplementation(async () => { mocks.consent.mockResolvedValue({ ...view, state: 'approved' }); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const button = (renderer: any, label: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === label);
describe('automation consent screen (mock native UI, no browser or actual camera/auth)', () => {
    it('shows exact identity, fingerprints, project, operations and expiry before explicit approval', async () => {
        let renderer: any;
        await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        expect(JSON.stringify(renderer.toJSON())).not.toContain('client_fingerprint');
        expect(renderer.root.findAllByType('QRCode')).toHaveLength(0);
        await act(async () => { button(renderer, '查看身份与安全详情').props.onPress(); });
        const text = JSON.stringify(renderer.toJSON());
        for (const value of ['Fixture assistant','client_fingerprint','worker_fingerprint','machineA','projectA','/approved/project','tasks.create','sessions.cancel','明文范围声明']) expect(text).toContain(value);
        expect(mocks.approve).not.toHaveBeenCalled();
        await act(async () => { button(renderer, '显示连接二维码').props.onPress(); });
        expect(renderer.root.findByType('QRCode').props.data).toBe('happy:///automation?connection=connection_1');
        const approve = button(renderer, '确认批准以上权限');
        await act(async () => { await approve.props.onPress(); });
        expect(mocks.approve).toHaveBeenCalledWith(view);
        expect(JSON.stringify(renderer.toJSON())).not.toContain('确认批准以上权限');
        await act(async () => renderer.unmount());
    });
    it('shows every selected project and directory before approval, without silently reducing scope', async () => {
        const multi = { ...view, projectID: undefined, projectDirectory: undefined, credentialMode: 'service-token-v1', scopeVersion: 2, projectIDs: ['projectA','projectB'], projects: [{id:'projectA',directory:'/approved/project'}, {id:'projectB',directory:'/approved/second'}] };
        mocks.consent.mockResolvedValue(multi); let renderer: any;
        await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        const text = JSON.stringify(renderer.toJSON()); for (const value of ['projectA','projectB','/approved/project','/approved/second','项目 1','项目 2']) expect(text).toContain(value);
        expect(mocks.approve).not.toHaveBeenCalled();
        await act(async () => { await button(renderer, '确认批准以上权限').props.onPress(); });
        expect(mocks.approve.mock.calls[0][0].projectIDs).toEqual(['projectA','projectB']);
        await act(async () => renderer.unmount());
    });
    it('does not offer approval when consent cannot be loaded', async () => {
        mocks.consent.mockRejectedValue(new Error('GRANT_EXPIRED')); let renderer: any;
        await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        expect(JSON.stringify(renderer.toJSON())).toContain('连接申请已过期');
        expect(JSON.stringify(renderer.toJSON())).not.toContain('确认批准以上权限');
        expect(mocks.approve).not.toHaveBeenCalled(); await act(async () => renderer.unmount());
    });
    it('hides approval, QR and revocation for expired records', async () => {
        mocks.consent.mockResolvedValue({ ...view, state: 'expired' }); let renderer: any;
        await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        expect(JSON.stringify(renderer.toJSON())).toContain('这项连接已过期');
        for (const label of ['确认批准以上权限', '撤销连接', '显示连接二维码']) expect(button(renderer, label)).toBeUndefined();
        await act(async () => renderer.unmount());
    });
    it('fails closed if the approval deadline elapsed while cached server state remains pending', async () => {
        mocks.consent.mockResolvedValue({ ...view, pendingUntil: Date.now()-1000 }); let renderer: any;
        await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        expect(JSON.stringify(renderer.toJSON())).toContain('这项连接已过期');
        expect(button(renderer, '确认批准以上权限')).toBeUndefined(); expect(mocks.approve).not.toHaveBeenCalled();
        await act(async () => renderer.unmount());
    });
    it('expires an open view and refuses a previously retained approval handler', async () => {
        vi.useFakeTimers(); mocks.consent.mockResolvedValue({ ...view, pendingUntil: Date.now()+1000 }); let renderer: any;
        await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        const retained = button(renderer, '确认批准以上权限').props.onPress;
        await act(async () => { await vi.advanceTimersByTimeAsync(1500); await retained(); });
        expect(button(renderer, '确认批准以上权限')).toBeUndefined(); expect(mocks.approve).not.toHaveBeenCalled();
        await act(async () => renderer.unmount());
    });
    it('shows explicit existing session scope before approval', async () => {
        mocks.consent.mockResolvedValue({ ...view, sessionIDs: ['explicit_existing_session'] }); let renderer: any;
        await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        expect(JSON.stringify(renderer.toJSON())).toContain('explicit_existing_session');
        expect(JSON.stringify(renderer.toJSON())).toContain('以下既有会话');
        await act(async () => renderer.unmount());
    });
    it('keeps pending status on failed approval and does not leak error payloads', async () => {
        mocks.approve.mockRejectedValue(new Error('fixture-private-error')); let renderer: any;
        await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        await act(async () => { await button(renderer, '确认批准以上权限').props.onPress(); });
        const text = JSON.stringify(renderer.toJSON());
        expect(text).toContain('操作结果尚未确认'); expect(text).not.toContain('fixture-private-error'); expect(text).not.toContain('已授权');
        expect(button(renderer, '确认批准以上权限')).toBeUndefined(); expect(button(renderer, '重新核实连接状态')).toBeDefined();
        await act(async () => renderer.unmount());
    });
    it('reads back a completed approval after a lost mutation response without sending approval twice', async () => {
        mocks.approve.mockImplementation(async () => { mocks.consent.mockResolvedValue({ ...view, state: 'approved' }); throw new Error('lost-response'); });
        let renderer: any; await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        await act(async () => { await button(renderer, '确认批准以上权限').props.onPress(); });
        expect(JSON.stringify(renderer.toJSON())).toContain('已授权'); expect(JSON.stringify(renderer.toJSON())).not.toContain('操作结果尚未确认');
        expect(mocks.approve).toHaveBeenCalledTimes(1); expect(button(renderer, '撤销连接')).toBeDefined();
        await act(async () => renderer.unmount());
    });
    it('retains uncertainty and safe revocation when mutation readback also fails', async () => {
        let renderer: any; await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        mocks.approve.mockRejectedValue(new Error('lost-response')); mocks.consent.mockRejectedValue(new Error('readback-offline'));
        await act(async () => { await button(renderer, '确认批准以上权限').props.onPress(); });
        expect(JSON.stringify(renderer.toJSON())).toContain('操作结果尚未确认'); expect(button(renderer, '撤销连接')).toBeDefined();
        expect(button(renderer, '确认批准以上权限')).toBeUndefined(); expect(mocks.approve).toHaveBeenCalledTimes(1);
        await act(async () => renderer.unmount());
    });
    it('does not let a late previous connection response overwrite the current consent', async () => {
        let finishFirst!: (value: typeof view) => void;
        mocks.consent.mockImplementation((id: string) => id === 'connection_1' ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve({ ...view, id, clientName: 'Second assistant' }));
        let renderer: any; await act(async () => { renderer = create(React.createElement(AutomationConnections)); });
        mocks.params = { connection: 'connection_2' };
        await act(async () => { renderer.update(React.createElement(AutomationConnections)); });
        await act(async () => { finishFirst(view); });
        const text = JSON.stringify(renderer.toJSON()); expect(text).toContain('Second assistant'); expect(text).not.toContain('Fixture assistant');
        await act(async () => { await button(renderer, '确认批准以上权限').props.onPress(); });
        expect(mocks.approve.mock.calls[0][0].id).toBe('connection_2');
        await act(async () => renderer.unmount());
    });
});
