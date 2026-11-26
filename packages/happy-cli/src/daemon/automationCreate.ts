import { writeSync } from 'node:fs';

export const AUTOMATION_CREATE_ENV = 'HAPPY_AUTOMATION_CREATE';
export const AUTOMATION_CREATE_PROOF_FD = 3;
export const NO_SESSION_REQUEST = 'no-session-request\n';

export type AutomationCreateBinding = { requestID: string; launchID: string };
export type AutomationCreateCode = 'SPAWN_NOT_STARTED' | 'SPAWN_EXITED_BEFORE_SESSION_REQUEST'
    | 'SPAWN_REGISTRATION_PENDING' | 'SPAWN_EXITED_UNVERIFIED';
export type AutomationCreateLaunch = {
    binding: AutomationCreateBinding;
    bindPid: (pid: number) => void;
    report: (code: AutomationCreateCode) => void;
};

let binding: AutomationCreateBinding | undefined;
let sessionRequestStarted = false;
let exitProofSent = false;

export function readAutomationCreateBinding(): AutomationCreateBinding | undefined {
    return binding;
}

/** Called at the only Relay session POST boundary, before any request can leave this process. */
export function markRelaySessionRequest() {
    if (exitProofSent) throw new Error('Session creation attempted during child exit');
    sessionRequestStarted = true;
}

export function installAutomationCreateExitProof() {
    const [requestID, launchID, extra] = (process.env[AUTOMATION_CREATE_ENV] ?? '').split(':');
    delete process.env[AUTOMATION_CREATE_ENV];
    if (extra !== undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(requestID)
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(launchID ?? '')) return;
    binding = { requestID, launchID };
    process.once('exit', () => {
        if (sessionRequestStarted) return;
        // A positive report from the launched CLI matters. Signals, a closed pipe,
        // or a CLI that does not support this protocol leave the outcome unknown.
        exitProofSent = true;
        try { writeSync(AUTOMATION_CREATE_PROOF_FD, NO_SESSION_REQUEST); }
        catch { /* No proof was delivered. Preserve the original exit status. */ }
    });
}
