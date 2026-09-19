/**
 * DeepSeek Harness (dsh) Model Catalog Probe
 *
 * dsh only reveals its model catalog over ACP (`session/new` config options),
 * which used to leave the app's pre-spawn pickers with nothing but the ambient
 * "Default model" row. The daemon runs this probe once per lifetime (when dsh
 * availability is first seen) and publishes the catalog as machine metadata,
 * so new sessions and the agent-defaults screen can offer the real list before
 * any session starts.
 *
 * The probe speaks the same protocol as the real runner — `dsh --profile acp`,
 * `initialize`, `session/new` — but never sends a prompt, so no turn runs and
 * the child is killed as soon as the config options arrive.
 *
 * @module discoverModels
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, type NewSessionResponse } from '@agentclientprotocol/sdk';
import { logger } from '@/ui/logger';
import { extractModelCatalogFromConfigOptions } from '@/agent/acp/sessionConfigMetadata';
import packageJson from '../../package.json';
import { DSH_ACP_ARGS, resolveDshBin } from './constants';

/** How long the probe waits for the dsh handshake before giving up. */
const PROBE_TIMEOUT_MS = 30_000;

export type DshModelCatalogOption = {
  code: string;
  value: string;
  description?: string | null;
};

export type DshModelCatalog = {
  options: DshModelCatalogOption[];
  /** The ambient model dsh runs without an override (the 'model' option's currentValue). */
  currentCode: string | null;
};

/** Filters non-JSON noise from stdout, same policy as the ACP runner's transport. */
function filterJsonLines(stdout: Readable): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let finished = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        if (buffer.trim()) {
          // A trailing non-newline line can still be a complete JSON message.
          try {
            const parsed = JSON.parse(buffer);
            if (parsed !== null && typeof parsed === 'object') {
              controller.enqueue(encoder.encode(buffer));
            }
          } catch {
            // drop
          }
        }
        try {
          controller.close();
        } catch {
          // already errored
        }
      };

      stdout.on('data', (chunk: Buffer) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            continue;
          }
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed !== null && typeof parsed === 'object') {
              controller.enqueue(encoder.encode(line + '\n'));
            }
          } catch {
            // not JSON — drop the line
          }
        }
      });
      stdout.on('end', finish);
      // 'close' without 'end' is what a spawn failure (ENOENT) or an killed
      // child leaves behind; without it the probe would hang until its timeout.
      stdout.on('close', finish);
      stdout.on('error', (err) => {
        logger.debug('[dsh] Model probe stdout error:', err);
        if (!finished) {
          finished = true;
          try {
            controller.error(err);
          } catch {
            // already closed
          }
        }
      });
    },
    cancel() {
      stdout.destroy();
    },
  });
}

function toWebWritable(stdin: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        const ok = stdin.write(chunk, (err) => {
          if (err) {
            reject(err);
          }
        });
        if (ok) {
          resolve();
        } else {
          stdin.once('drain', resolve);
        }
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        stdin.end(resolve);
      });
    },
  });
}

function spawnDsh(command: string, args: string[]): ChildProcess {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/c', [command, ...args].join(' ')], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  return spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Probe the dsh model catalog over a throwaway ACP session.
 *
 * Resolves null when dsh cannot be reached or reports no model selector —
 * callers treat that as "no catalog published" and fall back to the ambient
 * "Default model" row.
 */
export async function discoverDshModels(opts?: {
  command?: string;
  args?: string[];
  timeoutMs?: number;
}): Promise<DshModelCatalog | null> {
  const command = opts?.command ?? resolveDshBin();
  const args = opts?.args ?? DSH_ACP_ARGS;
  const timeoutMs = opts?.timeoutMs ?? PROBE_TIMEOUT_MS;

  const child = spawnDsh(command, args);
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    return null;
  }
  // spawn() emits ENOENT/EACCES asynchronously as an 'error' event; without a
  // listener that would crash the daemon instead of failing the probe.
  child.on('error', (err) => {
    logger.debug('[dsh] Model probe process error:', err);
  });
  child.stderr.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      logger.debug(`[dsh] Model probe stderr: ${text}`);
    }
  });

  const dispose = () => {
    child.kill();
  };

  let timeoutHandle: NodeJS.Timeout | null = null;
  const timedOut = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`dsh model probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const stream = ndJsonStream(toWebWritable(child.stdin), filterJsonLines(child.stdout));
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'cancel' } }),
      }),
      stream,
    );

    const result = await Promise.race([
      (async () => {
        await connection.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: {
              readTextFile: false,
              writeTextFile: false,
            },
          },
          clientInfo: {
            name: 'happy-cli',
            version: packageJson.version,
          },
        });
        const response: NewSessionResponse = await connection.newSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        const configOptions = response.configOptions ?? [];
        return extractModelCatalogFromConfigOptions(configOptions);
      })(),
      timedOut,
    ]);

    return result;
  } catch (error) {
    logger.debug('[dsh] Model probe failed:', error);
    return null;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    dispose();
  }
}
