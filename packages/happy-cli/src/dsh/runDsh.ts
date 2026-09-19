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
import { DefaultTransport } from '@/agent/transport';
import { resolveDshBin, DSH_ACP_ARGS } from './constants';

/**
 * dsh resolves the ACP session/prompt request only when the turn is fully
 * finished, so turn end is driven by the prompt response instead of output
 * inactivity. Server-side thinking between tool calls can pause for many
 * seconds — far beyond any quiet-period heuristic — and an inactivity-based
 * 'idle' would end the turn mid-chain.
 */
class DshTransport extends DefaultTransport {
  turnEndOnPromptResponse(): boolean {
    return true;
  }
}

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
    transportHandler: new DshTransport('dsh'),
  });
}
