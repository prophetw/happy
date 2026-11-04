#!/usr/bin/env node
import { productionMain } from '../dist/automation/production/index.mjs';
try { await productionMain(process.argv.slice(2)); }
catch (error) {
    const allowed = new Set(['CONTROL_STARTUP_REJECTED', 'CONTROL_LISTEN_FAILED', 'UNSAFE_PRIVATE_DIRECTORY', 'PRIVATE_MATERIAL_UNAVAILABLE', 'GATEWAY_DIRECTORY_LOCKED', 'STORE_UNAVAILABLE', 'INVALID_PUBLIC_REGISTRATION', 'INVALID_ORIGIN', 'DUPLICATE_REGISTRATION', 'SECRET_PROVIDER_UNAVAILABLE', 'INTERNAL_ERROR']);
    process.stderr.write(JSON.stringify({ event: 'startup-rejected', code: allowed.has(error?.code) ? error.code : 'CONTROL_STARTUP_REJECTED',
        ...(allowed.has(error?.startupReason) ? { reason: error.startupReason } : {}) }) + '\n');
    process.exitCode = 1;
}
