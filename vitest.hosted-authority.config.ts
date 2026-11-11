import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Offline regression suite: temporary journals and isolated process/HTTP fixtures.
// Deliberately omits the CLI global setup, which builds the entire CLI.
export default defineConfig({
    resolve: { alias: { '@': resolve('packages/happy-cli/src') } },
    test: {
        environment: 'node',
        include: [
            'packages/happy-cli/src/codex/hostedDot*.test.ts',
            'packages/happy-agent/src/automation/rest/sessionProcessProofs.test.ts',
            'packages/happy-agent/src/automation/rest/persistedScheduling.test.ts',
        ],
    },
});
