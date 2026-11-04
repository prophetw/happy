import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { loadConfig } from '../config';
import { requireCredentials } from '../credentials';
import { AutomationControl, validatePolicy } from './control';
import { hash, Journal } from './journal';
import { ControlError, relayTransport } from './relay';

/** JSONL stdio connector. No listeners, auto-login, token generation, or daemon startup. */
export async function serveJsonLines(control: Pick<AutomationControl, 'handle'>, input: Readable, output: Writable) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
        let response: unknown;
        try {
            if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('too large');
            response = await control.handle(JSON.parse(line));
        } catch { response = { version: 1, ok: false, error: { code: 'INVALID_JSON', retryable: false } }; }
        if (!output.write(`${JSON.stringify(response)}\n`)) await new Promise<void>(resolve => output.once('drain', resolve));
    }
}

export async function runAutomation(policyPath: string) {
    try {
        const policy = validatePolicy(JSON.parse(readFileSync(policyPath, 'utf8')));
        const config = loadConfig();
        if (config.serverUrl !== policy.serverUrl) throw new ControlError('RELAY_POLICY_MISMATCH');
        // Authentication is an explicit external prerequisite. Never initiate it from this connector.
        let creds;
        try { creds = requireCredentials(config); } catch { throw new ControlError('AUTH_REQUIRED'); }
        const journal = new Journal(join(config.homeDir, 'automation-client', hash(`${config.serverUrl}\n${creds.token}`)));
        await serveJsonLines(new AutomationControl(relayTransport(config.serverUrl, creds), policy, journal), process.stdin, process.stdout);
    } catch (error) {
        const code = error instanceof ControlError ? error.code : 'CONNECTOR_CONFIGURATION_ERROR';
        process.stdout.write(`${JSON.stringify({ version: 1, ok: false, error: { code, retryable: false } })}\n`);
        process.exitCode = 1;
    }
}
