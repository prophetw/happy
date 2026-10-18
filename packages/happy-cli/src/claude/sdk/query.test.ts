import { afterEach, describe, expect, it, vi } from 'vitest'

const { stopBeforeSpawn } = vi.hoisted(() => ({
    stopBeforeSpawn: new Error('Stop the probe before spawning Claude'),
}))

vi.mock('detect-libc', () => ({ MUSL: 'musl', familySync: () => 'glibc' }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
    const sdk = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
    return {
        ...sdk,
        query: (params: Parameters<typeof sdk.query>[0]) => sdk.query({
            ...params,
            options: {
                ...params.options,
                spawnClaudeCodeProcess: () => { throw stopBeforeSpawn },
            },
        }),
    }
})

import { query } from './query'

afterEach(() => vi.restoreAllMocks())

describe('Claude query initialization', () => {
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
