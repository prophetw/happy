// THROWAWAY PROTOTYPE: fixtures and in-memory changes only. Never import sync/auth.
export type WorkStatus = 'proposed' | 'running' | 'review' | 'accepted' | 'canceled';
export type Work = { id: string; dotId: string; title: string; project: string; status: WorkStatus; scope: string; criteria: string[] };
export type Dot = { id: string; name: string; instruction: string; mark: string; color: string };
export type Message = { id: string; dotId: string; role: 'user' | 'dot'; text: string; workId?: string };
export type Memory = { id: string; dotId: string; text: string };
export type PrototypeState = { dots: Dot[]; works: Work[]; messages: Message[]; memories: Memory[] };

export const workLabels: Record<WorkStatus, string> = {
    proposed: '待确认', running: '执行中', review: '待验收', accepted: '验收通过', canceled: '已取消',
};

export function seedState(): PrototypeState {
    return {
        dots: [
            { id: 'project', name: '项目助理', instruction: '推进产品开发，跟进交付与验收。', mark: '项', color: '#7560d7' },
            { id: 'writing', name: '写作助理', instruction: '把零散想法整理成清晰的周报、通知和文档。', mark: '写', color: '#358879' },
            { id: 'research', name: '研究助理', instruction: '收集可靠资料，比较方案，保留结论的依据。', mark: '研', color: '#b17c3b' },
        ],
        works: [
            { id: 'login', dotId: 'project', title: '改善登录体验', project: 'Happy', status: 'review',
                scope: '改进登录失败提示，保留用户已输入的信息。',
                criteria: ['失败原因有明确提示', '重试时保留已输入内容', '窄屏可以正常完成登录'] },
            { id: 'nav', dotId: 'project', title: '整理导航中的重复入口', project: 'Happy', status: 'running',
                scope: '核对重复入口，提交导航调整建议。', criteria: ['列出重复入口', '说明各入口应保留还是合并'] },
            { id: 'report', dotId: 'writing', title: '整理本周项目周报', project: '工作整理', status: 'proposed',
                scope: '按进展、问题、下周计划整理草稿，暂不对外发送。', criteria: ['覆盖本周提供的进展', '保留尚未解决的问题'] },
        ],
        messages: [
            { id: 'm1', dotId: 'project', role: 'user', text: '先把登录体验改好，失败时别让我重新输入。' },
            { id: 'm2', dotId: 'project', role: 'dot', text: '我已收到执行结果，登录失败提示和输入保留已调整。执行结束仍需要核对验收条件。', workId: 'login' },
            { id: 'm3', dotId: 'writing', role: 'dot', text: '周报的整理范围已经列好，确认后再开始。', workId: 'report' },
            { id: 'm4', dotId: 'research', role: 'dot', text: '可以把你想研究的问题交给我，我会保留资料来源和需要核实的部分。' },
        ],
        memories: [
            { id: 'p1', dotId: 'project', text: '优先推进影响日常使用的问题。' },
            { id: 'p2', dotId: 'project', text: '执行结束后，需要查看产物和验收证据。' },
            { id: 'w1', dotId: 'writing', text: '周报保持简洁，先写进展，再写问题。' },
        ],
    };
}

export type Action =
    | { type: 'create'; id: string; name: string; instruction: string }
    | { type: 'send'; id: string; dotId: string; text: string }
    | { type: 'work'; workId: string; status: WorkStatus }
    | { type: 'memory'; id: string; dotId: string; text: string }
    | { type: 'forget'; id: string }
    | { type: 'reset' };

export function prototypeReducer(state: PrototypeState, action: Action): PrototypeState {
    if (action.type === 'reset') return seedState();
    if (action.type === 'create') return {
        ...state,
        dots: [...state.dots, { id: action.id, name: action.name, instruction: action.instruction, mark: action.name.slice(0, 1), color: '#7560d7' }],
        messages: [...state.messages, { id: `${action.id}-welcome`, dotId: action.id, role: 'dot', text: '职责已记下。你可以在这里交办第一件事。' }],
    };
    if (action.type === 'send') {
        const work: Work = { id: `work-${action.id}`, dotId: action.dotId, title: action.text.slice(0, 36), project: '待选择项目',
            status: 'proposed', scope: action.text, criteria: ['开始前核对项目、范围和验收条件'] };
        return { ...state, works: [...state.works, work], messages: [...state.messages,
            { id: action.id, dotId: action.dotId, role: 'user', text: action.text },
            { id: `${action.id}-reply`, dotId: action.dotId, role: 'dot', text: '已整理为一条待确认的交办。可以先查看范围，再决定是否开始。', workId: work.id },
        ] };
    }
    if (action.type === 'work') {
        const work = state.works.find(item => item.id === action.workId);
        if (!work) return state;
        const allowed: Partial<Record<WorkStatus, WorkStatus[]>> = {
            proposed: ['running', 'canceled'], running: ['review', 'canceled'], review: ['accepted', 'running'],
        };
        if (!allowed[work.status]?.includes(action.status)) return state;
        const text = action.status === 'review' ? `「${work.title}」的执行已结束，仍需核对产物和验收条件。`
            : action.status === 'accepted' ? `「${work.title}」已记录本次模拟验收结论。`
                : action.status === 'running' ? `「${work.title}」已进入模拟执行。` : `「${work.title}」已在原型中取消。`;
        return { ...state, works: state.works.map(item => item.id === work.id ? { ...item, status: action.status } : item),
            messages: [...state.messages, { id: `${work.id}-${state.messages.length}`, dotId: work.dotId, role: 'dot', text, workId: work.id }] };
    }
    if (action.type === 'forget') return { ...state, memories: state.memories.filter(item => item.id !== action.id) };
    return { ...state, memories: [...state.memories.filter(item => item.id !== action.id), { id: action.id, dotId: action.dotId, text: action.text }] };
}
