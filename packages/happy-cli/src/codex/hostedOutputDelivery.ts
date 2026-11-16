import type { SessionEnvelope } from '@slopus/happy-wire';

type Output = { localId: string; envelope: unknown; sent: boolean };
/** Transport batching only: every row must already be durable. No text or IDs
 * are rewritten, and a partial/unknown ACK never authorizes the remaining rows. */
export class HostedOutputDelivery {
    private scanned = 0;
    private pending: Output[] = [];
    private active?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private closed = false;
    private lastTextKey?: string;
    readonly stats = { batches: 0, verified: 0, queuePeak: 0 };
    constructor(private readonly outputs: Output[],
        private readonly send: (rows: Array<{ localId: string; envelope: SessionEnvelope }>) => Promise<string[]>,
        private readonly persist: () => void | Promise<void>, private readonly windowMs = 20) {}

    /** Call only after the journal transaction succeeds. */
    durable(): void {
        if (this.closed) return;
        let boundary = false;
        for (; this.scanned < this.outputs.length; this.scanned++) if (!this.outputs[this.scanned].sent) {
            const row = this.outputs[this.scanned];
            if (!this.textKey(row) || this.textKey(row) !== this.lastTextKey) boundary = true;
            this.pending.push(row);
        }
        this.stats.queuePeak = Math.max(this.stats.queuePeak, this.pending.length);
        if (!this.pending.length || this.active) return;
        const key = this.textKey(this.pending[0]);
        const immediate = boundary || !key || key !== this.lastTextKey || this.pending.length >= 50;
        if (immediate) { clearTimeout(this.timer); this.timer = undefined; void this.flush().catch(() => {}); }
        else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, this.windowMs);
    }

    private textKey(row: Output): string | undefined {
        const e = row.envelope as SessionEnvelope;
        if (e.ev.t !== 'text' || e.ev.textSnapshot || e.ev.textOffset === undefined) return;
        // Include the epoch carried in the stable localId, and all routing axes.
        return JSON.stringify([row.localId.split(':').slice(0, 2), e.turn, e.subagent, e.codexItemId, e.ev.thinking]);
    }

    flush(): Promise<void> {
        clearTimeout(this.timer); this.timer = undefined;
        if (this.active) return this.active;
        if (this.closed) return Promise.resolve();
        this.active = this.drain().finally(() => { this.active = undefined; });
        return this.active;
    }
    private async drain(): Promise<void> {
        while (this.pending.length && !this.closed) {
            const key = this.textKey(this.pending[0]), batch: Output[] = [];
            let bytes = 0;
            for (const row of this.pending) {
                if (batch.length && (!key || this.textKey(row) !== key)) break;
                const size = Buffer.byteLength(JSON.stringify(row.envelope));
                if (batch.length && (batch.length >= 50 || bytes + size > 64 * 1024)) break;
                batch.push(row); bytes += size;
            }
            this.stats.batches++;
            const verified = new Set(await this.send(batch.map(row => ({ localId: row.localId, envelope: row.envelope as SessionEnvelope }))));
            let changed = false;
            for (const row of batch) if (verified.has(row.localId)) { row.sent = true; changed = true; this.stats.verified++; }
            if (changed) {
                // Do not forget rows in memory until their ACK transaction is durable.
                await this.persist();
                this.pending = this.pending.filter(row => !row.sent);
            }
            this.lastTextKey = key;
            if (batch.some(row => !verified.has(row.localId))) throw new Error('hosted_output_unconfirmed');
        }
    }
    async close(): Promise<void> { this.closed = true; clearTimeout(this.timer); await this.active?.catch(() => {}); }
}
