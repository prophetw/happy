import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { familySync, MUSL } from 'detect-libc'

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
const require = createRequire(import.meta.url)
let cachedExecutable: string | undefined

/** Resolve the SDK's bundled CLI once, without its per-query diagnostic report. */
export function resolveClaudeCodeExecutable(): string {
    if (cachedExecutable) return cachedExecutable

    // Resolve from the SDK itself so pnpm/nested installs use its matching
    // optional binary dependency rather than another SDK version's binary.
    const sdkRequire = createRequire(require.resolve(SDK_PACKAGE))
    const { platform, arch } = process
    const base = `${SDK_PACKAGE}-${platform === 'android' ? 'linux' : platform}-${arch}`
    const packages = platform === 'linux'
        ? familySync() === MUSL ? [`${base}-musl`, base] : [base, `${base}-musl`]
        : [platform === 'android' ? `${base}-android` : base]
    const executable = platform === 'win32' ? 'claude.exe' : 'claude'

    // detect-libc checks the ELF interpreter/ldd first; its report fallback
    // disables network collection, avoiding synchronous socket reverse DNS.
    for (const pkg of packages) {
        try {
            const path = sdkRequire.resolve(`${pkg}/${executable}`)
            if (existsSync(path)) {
                cachedExecutable = path
                return path
            }
        } catch {
            // Match the SDK's fallback order when an optional package is absent.
        }
    }

    throw new Error(`Native CLI binary for ${platform}-${arch} not found. Reinstall ${SDK_PACKAGE} without --omit=optional.`)
}
