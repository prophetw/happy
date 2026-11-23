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
    private compactionPending = true;
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
            const envelope = row.envelope as SessionEnvelope;
            if (envelope.ev.t === 'turn-end' || envelope.ev.t === 'text' && envelope.ev.textSnapshot === true)
                this.compactionPending = true;
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
    /** Main may compact only after a successful flush; a new durable batch vetoes it. */
    compactQuiescent(compact: () => number): number {
        if (!this.compactionPending || this.active || this.pending.length || this.closed || this.scanned !== this.outputs.length
            || this.outputs.some(row => !row.sent)) return 0;
        this.compactionPending = false;
        const before = this.outputs.length, removed = compact();
        if (!removed) return 0;
        if (!Number.isSafeInteger(removed) || removed < 0 || this.outputs.length !== before - removed)
            throw new Error('hosted_output_compaction_invalid');
        this.scanned = this.outputs.length;
        this.lastTextKey = undefined;
        return removed;
    }
    /** Rebase the durable frontier after removing only a verified prefix. Unsent pending refs stay intact. */
    reclaimAcknowledgedPrefix(reclaim: () => number): number {
        if (this.active || this.closed || this.scanned !== this.outputs.length) return 0;
        let prefix = 0;
        while (prefix < this.outputs.length && this.outputs[prefix].sent) prefix++;
        if (!prefix) return 0;
        const before = this.outputs.length, retainedIds = this.outputs.slice(prefix).map(row => row.localId);
        const pendingIds = this.pending.map(row => row.localId), removed = reclaim();
        if (removed !== prefix || this.outputs.length !== before - removed
            || this.outputs.some((row, position) => row.localId !== retainedIds[position])) throw new Error('hosted_output_compaction_invalid');
        const retained = new Map(this.outputs.map(row => [row.localId, row]));
        if (retained.size !== this.outputs.length) throw new Error('hosted_output_compaction_invalid');
        const pending = pendingIds.map(localId => retained.get(localId));
        if (pending.some(row => !row || row.sent)) throw new Error('hosted_output_compaction_invalid');
        this.pending = pending as Output[];
        this.scanned = this.outputs.length;
        this.lastTextKey = undefined;
        return removed;
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
