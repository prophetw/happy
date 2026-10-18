import { RelaySwitchRequestSchema, type RelaySwitchRequest, type RelaySwitchResult } from '@slopus/happy-wire';
import { normalizeServerUrl } from '@slopus/happy-wire/serverUrl';

export type RelayTarget = { serverUrl: string; token: string };
export interface PreparedRelaySwitch {
    commit(): Promise<void>;
    finish(): Promise<void>;
    rollback(): Promise<void>;
    dispose(): void;
}

/** The RPC channel already authenticates and encrypts these device commands. */
export class RelaySwitchController {
    private pending: { request: RelaySwitchRequest; change: PreparedRelaySwitch; committed: boolean; finished: boolean; rollbackRequested: boolean } | null = null;
    private timeout: ReturnType<typeof setTimeout> | null = null;
    private busy = false;
    private expiredFinish: RelaySwitchRequest | null = null;

    constructor(private prepare: (target: RelayTarget) => Promise<PreparedRelaySwitch>) {}

    async handle(input: unknown): Promise<RelaySwitchResult> {
        if (this.busy) return { error: 'Another relay switch is in progress' };
        this.busy = true;
        try {
            const request = RelaySwitchRequestSchema.parse(input);
            request.serverUrl = normalizeServerUrl(request.serverUrl);
            if (request.phase === 'prepare') {
                if (this.pending?.finished && !this.pending.rollbackRequested) {
                    this.expiredFinish = this.pending.request;
                    this.dispose();
                }
                if (this.pending) {
                    this.requireMatch(request);
                    return { success: true };
                }
                const change = await this.prepare(request);
                this.pending = { request, change, committed: false, finished: false, rollbackRequested: false };
                // An abandoned prepare/commit returns to the old connection. A
                // finished transaction retains its old socket briefly for rollback.
                this.scheduleExpiry(120_000);
                return { success: true };
            }
            if (request.phase === 'rollback' && !this.pending) {
                if (this.expiredFinish?.id === request.id) throw new Error('Rollback window expired; this device remains on the new relay');
                return { success: true };
            }
            this.requireMatch(request);
            const pending = this.pending!;
            if (pending.rollbackRequested && request.phase !== 'rollback') throw new Error('This relay switch is being rolled back');
            if (request.phase === 'commit' && !pending.committed) {
                await pending.change.commit();
                pending.committed = true;
            } else if (request.phase === 'finish' && !pending.finished) {
                if (!pending.committed) throw new Error('Relay switch has not been committed');
                await pending.change.finish();
                pending.finished = true;
            } else if (request.phase === 'rollback') {
                pending.rollbackRequested = true;
                await pending.change.rollback();
                // dispose only closes the unused socket, after the RPC reply.
                this.dispose();
            }
            return { success: true };
        } catch (error) {
            return { error: error instanceof Error ? error.message : 'Relay switch failed' };
        } finally {
            this.busy = false;
        }
    }

    private requireMatch(request: RelaySwitchRequest) {
        const active = this.pending?.request;
        if (!active || active.id !== request.id || active.serverUrl !== request.serverUrl || active.token !== request.token) {
            throw new Error('Relay switch transaction does not match');
        }
    }

    private scheduleExpiry(delay: number) {
        this.timeout = setTimeout(() => { void this.expire(); }, delay);
        this.timeout.unref();
    }

    private async expire() {
        if (!this.pending) return;
        if (this.busy) { this.scheduleExpiry(1_000); return; }
        this.busy = true;
        try {
            if (this.pending.finished && !this.pending.rollbackRequested) this.expiredFinish = this.pending.request;
            else await this.pending.change.rollback();
            this.dispose();
        } catch {
            console.warn('Automatic relay rollback failed; keeping both connections and retrying.');
            this.scheduleExpiry(10_000);
        } finally { this.busy = false; }
    }

    dispose() {
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = null;
        this.pending?.change.dispose();
        this.pending = null;
    }
}
