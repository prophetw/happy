/**
 * DeepSeek Harness (dsh) Runner
 *
 * dsh speaks the Agent Client Protocol through `dsh --profile acp`, so the
 * runner is a thin wrapper over the generic ACP runner: it only resolves the
 * dsh binary and pins the agent identity. Model catalog, reasoning effort and
 * tool permissions all arrive as ACP session config options / permission
 * requests and are handled by runAcp.
 *
 * @module runDsh
 */

import type { Credentials } from '@/persistence';
import { runAcp } from '@/agent/acp';
import { resolveDshBin, DSH_ACP_ARGS } from './constants';

export async function runDsh(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
}): Promise<void> {
  await runAcp({
    credentials: opts.credentials,
    startedBy: opts.startedBy,
    verbose: opts.verbose,
    agentName: 'dsh',
    command: resolveDshBin(),
    args: [...DSH_ACP_ARGS],
  });
}
