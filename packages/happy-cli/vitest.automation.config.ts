import { defineConfig } from 'vitest/config';

// Pure contract tests: deliberately no CLI build/global setup, credentials or live services.
export default defineConfig({ test: { include: ['src/daemon/automationShutdown.test.ts', 'src/daemon/automationControl.test.ts', 'src/daemon/automationWorker.test.ts', 'src/daemon/automationBootstrap.test.ts', 'src/daemon/automationExistingMachine.test.ts', 'src/daemon/automationMetadata.test.ts'], environment: 'node' } });
