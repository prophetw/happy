import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createRequire, localResolve, sdkResolve, existsSync, familySync } = vi.hoisted(() => ({
    createRequire: vi.fn(),
    localResolve: vi.fn(),
    sdkResolve: vi.fn(),
    existsSync: vi.fn(),
    familySync: vi.fn(),
}))

vi.mock('node:module', () => ({ createRequire }))
vi.mock('node:fs', () => ({ existsSync }))
vi.mock('detect-libc', () => ({ familySync, MUSL: 'musl' }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')!
const sdkEntrypoint = '/sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
const sdkPackage = '@anthropic-ai/claude-agent-sdk'

beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' })
    Object.defineProperty(process, 'arch', { ...originalArch, value: 'x64' })
    localResolve.mockReturnValue(sdkEntrypoint)
    sdkResolve.mockImplementation((specifier: string) => `/sdk/node_modules/${specifier}`)
    createRequire.mockReturnValueOnce({ resolve: localResolve }).mockReturnValue({ resolve: sdkResolve })
    existsSync.mockReturnValue(true)
    familySync.mockReturnValue('glibc')
    vi.spyOn(process.report, 'getReport').mockImplementation(() => {
        throw new Error('Binary resolution must not collect a diagnostic report')
    })
})

afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    Object.defineProperty(process, 'arch', originalArch)
    vi.restoreAllMocks()
})

describe('resolveClaudeCodeExecutable', () => {
    it.each([
        ['linux', 'x64', 'glibc', 'linux-x64/claude'],
        ['linux', 'arm64', 'glibc', 'linux-arm64/claude'],
        ['linux', 'x64', 'musl', 'linux-x64-musl/claude'],
        ['linux', 'arm64', 'musl', 'linux-arm64-musl/claude'],
        ['linux', 'x64', null, 'linux-x64/claude'],
        ['darwin', 'arm64', null, 'darwin-arm64/claude'],
        ['win32', 'x64', null, 'win32-x64/claude.exe'],
        ['android', 'arm64', null, 'linux-arm64-android/claude'],
    ])('selects the matching binary for %s/%s (%s)', async (platform, arch, libc, suffix) => {
        Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
        Object.defineProperty(process, 'arch', { ...originalArch, value: arch })
        familySync.mockReturnValue(libc)
        const { resolveClaudeCodeExecutable } = await import('./claudeExecutable')

        expect(resolveClaudeCodeExecutable()).toBe(`/sdk/node_modules/${sdkPackage}-${suffix}`)
        expect(createRequire).toHaveBeenNthCalledWith(2, sdkEntrypoint)
        expect(sdkResolve).toHaveBeenCalledWith(`${sdkPackage}-${suffix}`)
        expect(familySync).toHaveBeenCalledTimes(platform === 'linux' ? 1 : 0)
    })

    it.each([
        ['glibc', 'linux-x64/claude', 'linux-x64-musl/claude'],
        ['musl', 'linux-x64-musl/claude', 'linux-x64/claude'],
    ])('preserves the SDK fallback order on %s when the preferred package is missing', async (libc, first, fallback) => {
        familySync.mockReturnValue(libc)
        sdkResolve.mockImplementationOnce(() => { throw new Error('MODULE_NOT_FOUND') })
        const { resolveClaudeCodeExecutable } = await import('./claudeExecutable')

        expect(resolveClaudeCodeExecutable()).toBe(`/sdk/node_modules/${sdkPackage}-${fallback}`)
        expect(sdkResolve.mock.calls).toEqual([[`${sdkPackage}-${first}`], [`${sdkPackage}-${fallback}`]])
    })

    it('skips a resolved binary that is missing on disk', async () => {
        existsSync.mockReturnValueOnce(false)
        const { resolveClaudeCodeExecutable } = await import('./claudeExecutable')

        expect(resolveClaudeCodeExecutable()).toBe(`/sdk/node_modules/${sdkPackage}-linux-x64-musl/claude`)
    })

    it('caches the binary and libc detection across queries', async () => {
        const { resolveClaudeCodeExecutable } = await import('./claudeExecutable')

        expect(resolveClaudeCodeExecutable()).toBe(resolveClaudeCodeExecutable())
        expect(localResolve).toHaveBeenCalledOnce()
        expect(sdkResolve).toHaveBeenCalledOnce()
        expect(familySync).toHaveBeenCalledOnce()
    })

    it('reports missing optional binaries without falling back to SDK report collection or caching the failure', async () => {
        existsSync.mockReturnValue(false)
        const { resolveClaudeCodeExecutable } = await import('./claudeExecutable')

        expect(resolveClaudeCodeExecutable).toThrow('Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional.')
        existsSync.mockReturnValue(true)
        expect(resolveClaudeCodeExecutable()).toBe(`/sdk/node_modules/${sdkPackage}-linux-x64/claude`)
        expect(process.report.getReport).not.toHaveBeenCalled()
    })
})
