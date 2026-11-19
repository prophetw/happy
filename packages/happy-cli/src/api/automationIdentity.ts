import axios from 'axios';
import { setTimeout as delay } from 'node:timers/promises';
import { logger } from '@/ui/logger';
import { isNetworkError } from '@/utils/serverConnectionErrors';

export async function readAutomationIdentity(serverUrl: string, token: string, path: '/v1/machines' | '/v1/account/profile', signal?: AbortSignal) {
  let waiting = false;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const response = await axios.get(`${serverUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10000, maxRedirects: 0, signal,
      });
      signal?.throwIfAborted();
      return response.data;
    } catch (error) {
      if (!signal || signal.aborted || !axios.isAxiosError(error)) throw error;
      const transient = error.response ? [502, 503, 504].includes(error.response.status)
        : isNetworkError(error.code) || error.code === 'EAI_AGAIN' || error.code === 'ECONNABORTED';
      if (!transient) throw error;
      if (!waiting) logger.debug(`[DAEMON RUN] Waiting for Relay during identity verification (${path})`);
      waiting = true;
      await delay(5000, undefined, { signal });
    }
  }
}

export async function verifyAutomationWorkerOwner(serverUrl: string, token: string, userID: string, signal?: AbortSignal) {
  try {
    const profile = await readAutomationIdentity(serverUrl, token, '/v1/account/profile', signal);
    if (!userID || profile?.id !== userID) throw new Error();
  } catch { throw new Error('AUTOMATION_WORKER_OWNER_UNVERIFIED'); }
}
