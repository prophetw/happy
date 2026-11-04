import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import type { SessionRowData } from '@/sync/storage';
import { buildPathProjectGroups } from '@/sync/projectGroups';
import { buildProjectHomeRows } from './projectHomeList';
import { buildTestloopDotsListItem, testloopDotsKind } from '@/sync/testloopDotsList';
import { buildFlatSessionRows, toFlatSessionRow } from './flatSessionList';
import { getSessionShortcutIdsInDisplayOrder } from './sessionDisplayOrder';

const workspaceId = 'da58a731-14f3-4dd1-a6c3-cf832eaf3508';
function session(id: string, marker?: Record<string, unknown>): Session {
    return { id, active: false, createdAt: 1, updatedAt: 1,
        metadata: { path: '/persistent/assistant', host: 'host-without-native-machine',
            summary: { text: id, updatedAt: 1 }, ...(marker ? { testloopDots: marker } : {}) } } as Session;
}
function row(value: Session): SessionRowData {
    return { id: value.id, name: value.id, machineId: value.metadata?.machineId ?? null,
        ...(testloopDotsKind(value) ? { testloopDotsKind: testloopDotsKind(value)! } : {}),
        path: value.metadata?.path ?? null, active: false, archived: false, hasUnread: true,
        machineOffline: false, lastActivityAt: 1, createdAt: 1,
        projectName: null, workspaceName: null } as SessionRowData;
}
const workspace = session('workspace', { schemaVersion: 1, kind: 'workspace', workspaceId });
const dot = session('dot', { schemaVersion: 1, kind: 'dot', workspaceId,
    workspaceSessionId: 'workspace', dotId: '11909737-fb01-4dbb-9bf0-d6cf344e853d' });

describe('Dots presentation does not imply an unknown development machine', () => {
    it('keeps valid machine-less Dot metadata out of path/project machine grouping', () => {
        const groups = buildPathProjectGroups([workspace, dot], row, () => false, 'happy');
        const rows = buildProjectHomeRows({ data: groups.map(project => ({ type: 'project', source: 'happy', project })),
            machines: [], unknownMachineText: '未知', expanded: {}, labels: { bots: 'Bots', projects: 'Projects' } });
        expect(rows.filter(item => item.type === 'machine')).toEqual([]);
        expect(groups).toEqual([]);
    });
    it('preserves a genuinely unknown legacy machine and invalid Dot metadata in its original project group', () => {
        const ordinary = session('ordinary');
        const invalid = session('invalid-marker', { schemaVersion: 1, kind: 'dot', workspaceId: 'bad' });
        const groups = buildPathProjectGroups([ordinary, invalid], row, () => false, 'happy');
        expect(groups).toHaveLength(1);
        expect(groups[0].machineId).toBeNull();
        expect(groups[0].workspaces[0].sessions.map(s => s.id)).toEqual(['ordinary', 'invalid-marker']);
    });
    it('builds a dedicated workspace-first group while retaining native presence and unread state', () => {
        const group = buildTestloopDotsListItem([dot, workspace, session('ordinary')], row)!;
        expect(group.type).toBe('dots');
        expect(group.sessions.map(s => s.id)).toEqual(['workspace', 'dot']);
        expect(group.sessions.map(s => s.testloopDotsKind)).toEqual(['workspace', 'dot']);
        expect(group.sessions.filter(s => s.testloopDotsKind === 'dot')).toHaveLength(1);
        expect(group.sessions.every(s => s.hasUnread && !s.active && !s.machineOffline)).toBe(true);
    });
    it('leaves real machine projects beside the independent Dots group', () => {
        const group = buildTestloopDotsListItem([dot, workspace], row)!;
        const ordinary = session('project-chat');
        ordinary.metadata!.machineId = 'real-machine';
        const projects = buildPathProjectGroups([workspace, dot, ordinary], row, () => false, 'happy');
        const input = [group, ...projects.map(project => ({ type: 'project' as const, source: 'happy' as const, project }))];
        const rows = buildProjectHomeRows({ data: input, machines: [{ id: 'real-machine', metadata: { displayName: '开发电脑' } }],
            unknownMachineText: '未知', expanded: {}, labels: { bots: 'Bots', projects: 'Projects' } });
        expect(rows[0]).toEqual(group);
        expect(rows.filter(item => item.type === 'machine')).toEqual([{ type: 'machine', machineId: 'real-machine', machineName: '开发电脑' }]);
        expect(getSessionShortcutIdsInDisplayOrder(input, [], '未知')).toEqual(['workspace', 'dot', 'project-chat']);
    });
    it('keeps Dot identity in flat rows and preserves original row references for actions and selection', () => {
        const group = buildTestloopDotsListItem([dot, workspace], row)!;
        const rows = buildFlatSessionRows([group], { sortByActivity: true });
        expect(rows).toHaveLength(2);
        expect(rows.find(r => r.session.id === 'dot')!.session).toBe(group.sessions.find(s => s.id === 'dot'));
        expect(toFlatSessionRow(group.sessions[0])).toMatchObject({ projectName: '工作台入口', workspaceName: null });
        expect(toFlatSessionRow(group.sessions[1])).toMatchObject({ projectName: 'Dot 专属对话', workspaceName: null });
    });
});
