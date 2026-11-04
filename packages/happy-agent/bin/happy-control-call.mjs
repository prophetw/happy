#!/usr/bin/env node
import { readControlRequest, restCallerMain } from '../dist/automation/production/index.mjs';
try {
    const result = await restCallerMain(process.argv.slice(2), await readControlRequest(process.stdin));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
} catch {
    process.stdout.write(JSON.stringify({ version: 1, ok: false, error: { code: 'CONTROL_INPUT_INVALID', retryable: false } }) + '\n');
    process.exitCode = 1;
}
