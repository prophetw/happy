import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Pure contract tests: deliberately no CLI build/global setup, credentials or live services.
export default defineConfig({ resolve: {alias: {'@':fileURLToPath(new URL('./src',import.meta.url))}}, test: { include: ['src/daemon/automationShutdown.test.ts', 'src/daemon/automationControl.test.ts', 'src/daemon/automationWorker.test.ts', 'src/daemon/automationBootstrap.test.ts', 'src/daemon/automationExistingMachine.test.ts', 'src/daemon/automationMetadata.test.ts', 'src/daemon/run.resume.test.ts', 'src/daemon/sessionEnvironment.test.ts'], environment: 'node' } });
