import { afterEach, describe, expect, it, vi } from 'vitest'

const { stopBeforeSpawn, capturedOptions } = vi.hoisted(() => ({
    stopBeforeSpawn: new Error('Stop the probe before spawning Claude'),
    capturedOptions: [] as Array<import('@anthropic-ai/claude-agent-sdk').Options>,
}))

vi.mock('detect-libc', () => ({ MUSL: 'musl', familySync: () => 'glibc' }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
    const sdk = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
    return {
        ...sdk,
        query: (params: Parameters<typeof sdk.query>[0]) => {
            capturedOptions.push(params.options!);
            return sdk.query({
                ...params,
                options: {
                    ...params.options,
                    spawnClaudeCodeProcess: () => { throw stopBeforeSpawn },
                },
            });
        },
    }
})

import { query } from './query'

afterEach(() => vi.restoreAllMocks())

describe('Claude query initialization', () => {
    it('uses native main-thread batch and interruption hooks without changing their decisions', async () => {
        const onTokenSpeedBoundary = vi.fn();
        expect(() => query({ prompt: 'hello', options: { onTokenSpeedBoundary } })).toThrow(stopBeforeSpawn);
        const options = capturedOptions.at(-1)!;
        expect(options.includePartialMessages).toBe(true);
        const batch = options.hooks!.PostToolBatch![0].hooks[0];
        const base = { session_id: 'fixture', cwd: '/fixture', transcript_path: '/fixture/transcript' };
        const hookOptions = { signal: new AbortController().signal };
        expect(await batch({ ...base, hook_event_name: 'PostToolBatch', tool_calls: [] }, undefined, hookOptions)).toEqual({});
        expect(onTokenSpeedBoundary.mock.calls).toEqual([['tool-batch-complete']]);
        await batch({ ...base, hook_event_name: 'PostToolBatch', tool_calls: [], agent_id: 'child' }, undefined, hookOptions);
        expect(onTokenSpeedBoundary).toHaveBeenCalledOnce();
        for (const name of ['PreToolUse', 'PermissionRequest', 'Elicitation', 'PreCompact', 'PreModelSwitch', 'UserPromptSubmit'] as const) {
            const callback = options.hooks![name]![0].hooks[0];
            expect(await callback({ ...base, hook_event_name: name } as any, undefined, hookOptions)).toEqual({});
        }
        expect(onTokenSpeedBoundary.mock.calls.slice(1)).toEqual([...Array(5).fill(['interrupt']), ['prompt-submit']]);
    });

    it('creates repeated SDK queries without collecting a process diagnostic report', () => {
        const getReport = vi.spyOn(process.report, 'getReport').mockImplementation(() => {
            throw new Error('Diagnostic reports can block on reverse DNS with an active relay socket')
        })

        // Keep the real Happy adapter and SDK binary resolution. Stop at the
        // process boundary so the regression needs neither credentials nor an API call.
        for (let i = 0; i < 2; i++) {
            expect(() => query({ prompt: 'hello' })).toThrow(stopBeforeSpawn)
        }
        expect(getReport).not.toHaveBeenCalled()
    })
})
