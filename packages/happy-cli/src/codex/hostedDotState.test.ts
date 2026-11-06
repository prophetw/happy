import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostedDotConfig, loadHostedState, savePrivate, readPrivate, addOutput } from './hostedDotState';
import { createEnvelope } from '@slopus/happy-wire';
const config = () => HostedDotConfig.parse({ version: 1, dotId: randomUUID(), sessionId: 'isolated', happyHome: '/tmp/happy',
    serverUrl: 'http://127.0.0.1:4567', directory: '/tmp/dot', executable: 'codex', args: [], model: 'test', provider: 'openai', instruction: 'chat', codexHome: '/tmp/codex' });
it('preserves input delivery state and stable output identity across process reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-journal-')), file = join(dir, 'state.json'), c = config();
    try {
        const state = loadHostedState(file, c);
        state.inputs.push({ epoch: 0, id: 'm1', seq: 7, text: 'identical text', status: 'dispatching', delivery: 'queue', beforeTurns: ['old'] });
        const envelope = createEnvelope('agent', { t: 'text', text: 'answer' }, { id: 'native-item' });
        addOutput(state, envelope); addOutput(state, envelope); savePrivate(file, state);
        const recovered = loadHostedState(file, c);
        expect(recovered.outputs).toHaveLength(1); expect(recovered.outputs[0].sent).toBe(false);
        expect(recovered.inputs[0].status).toBe('dispatching');
        expect(() => loadHostedState(file, { ...c, sessionId: 'different' })).toThrow('hosted_binding_changed');
        recovered.epoch++; addOutput(recovered, envelope); expect(recovered.outputs).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true }); }
});
it('rejects reserved identity environment variables and non-file state', () => {
    for (const name of ['CODEX_HOME', 'HOME', 'HAPPY_HOME_DIR', 'NODE_OPTIONS']) expect(() => HostedDotConfig.parse({ ...config(), environment: [name] })).toThrow();
    const dir = mkdtempSync(join(tmpdir(), 'hosted-file-'));
    try { writeFileSync(join(dir, 'real'), '{}'); symlinkSync(join(dir, 'real'), join(dir, 'link')); expect(() => readPrivate(join(dir, 'link'))).toThrow('hosted_file_invalid'); }
    finally { rmSync(dir, { recursive: true }); }
});
