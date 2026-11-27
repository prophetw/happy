import { inTx, afterTx, type Tx } from "@/storage/inTx";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { eventRouter, buildKVBatchUpdateUpdate } from "@/app/events/eventRouter";
import * as privacyKit from "privacy-kit";
import { SESSION_ATTENTION_PREFIX, encodeAttentionValue, readAttentionValue } from '@/app/push/sessionAttentionValue';

export interface KVMutation {
    key: string;
    value: string | null; // null = delete (sets value to null but keeps record)
    version: number; // Always required, use -1 for new keys
}

export interface KVMutateResult {
    success: boolean;
    results?: Array<{
        key: string;
        version: number;
    }>;
    errors?: Array<{
        key: string;
        error: 'version-mismatch';
        version: number;
        value: string | null;  // Current value (null if deleted)
    }>;
}

/**
 * Atomically mutate multiple key-value pairs.
 * All mutations succeed or all fail.
 * Version is always required for all operations (use -1 for new keys).
 * Delete operations set value to null but keep the record with incremented version.
 * Sends a single bundled update notification for all changes.
 */
export async function kvMutate(
    ctx: { uid: string },
    mutations: KVMutation[]
): Promise<KVMutateResult> {
    return inTx(tx => kvMutateInTx(tx, ctx, mutations, true));
}

export async function kvMutateInTx(tx: Tx, ctx: { uid: string }, mutations: KVMutation[], preserveAttentionState = false): Promise<KVMutateResult> {
    const errors: KVMutateResult['errors'] = [];
    const values = new Map<string, string>();

    // Pre-validate all mutations
    for (const mutation of mutations) {
        const existing = await tx.userKVStore.findUnique({
            where: {
                accountId_key: {
                    accountId: ctx.uid,
                    key: mutation.key
                }
            }
        });

        const currentVersion = existing?.version ?? -1;

        // Version check is always required
        if (currentVersion !== mutation.version) {
            errors.push({
                key: mutation.key,
                error: 'version-mismatch',
                version: currentVersion,
                value: existing?.value ? privacyKit.encodeBase64(existing.value) : null
            });
        }

        // Older clients acknowledge an event by replacing its JSON. Keep
        // relay-owned lifecycle information across those read receipts.
        if (preserveAttentionState && mutation.key.startsWith(SESSION_ATTENTION_PREFIX) && mutation.value && existing?.value) {
            const previous = readAttentionValue(existing.value);
            const incoming = readAttentionValue(Buffer.from(mutation.value, 'base64'));
            if (previous && incoming) {
                const event = incoming.eventId === previous.eventId ? { ...previous, read: previous.read || incoming.read } : incoming;
                values.set(mutation.key, encodeAttentionValue({ ...event,
                    visibility: incoming.visibility ?? previous.visibility,
                    action: incoming.action && incoming.action.version > (previous.action?.version ?? -1) ? incoming.action : previous.action,
                    turnStartedAt: previous.turnStartedAt,
                    archivedAt: previous.archivedAt,
                }));
            }
        }
    }

    // If any errors, return all errors and abort
    if (errors.length > 0) {
        return { success: false, errors };
    }

    // Apply all mutations and collect results
    const results: Array<{ key: string; version: number }> = [];
    const changes: Array<{ key: string; value: string | null; version: number }> = [];

    for (const mutation of mutations) {
        const value = values.get(mutation.key) ?? mutation.value;
        if (mutation.version === -1) {
            // Create new entry (must not exist)
            const result = await tx.userKVStore.create({
                data: {
                    accountId: ctx.uid,
                    key: mutation.key,
                    value: value ? new Uint8Array(Buffer.from(value, 'base64')) : null,
                    version: 0
                }
            });

            results.push({
                key: mutation.key,
                version: result.version
            });

            changes.push({
                key: mutation.key,
                value,
                version: result.version
            });
        } else {
            // Update existing entry (including "delete" which sets value to null)
            const newVersion = mutation.version + 1;

            const result = await tx.userKVStore.update({
                where: {
                    accountId_key: {
                        accountId: ctx.uid,
                        key: mutation.key
                    }
                },
                data: {
                    value: value ? privacyKit.decodeBase64(value) : null,
                    version: newVersion
                }
            });

            results.push({
                key: mutation.key,
                version: result.version
            });

            changes.push({
                key: mutation.key,
                value,
                version: result.version
            });
        }
    }

    // Send single bundled notification for all changes
    afterTx(tx, async () => {
        const updateSeq = await allocateUserSeq(ctx.uid);
        eventRouter.emitUpdate({
            userId: ctx.uid,
            payload: buildKVBatchUpdateUpdate(changes, updateSeq, randomKeyNaked(12)),
            recipientFilter: { type: 'user-scoped-only' }
        });
    });

    return { success: true, results };
}
