/**
 * Formats a duration in milliseconds into a compact string representation:
 * - >= 1 hour: "1h23m"
 * - >= 1 minute: "2m15s"
 * - < 1 minute: "12s"
 */
export function formatWorkDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m${seconds}s`;
    }
    return `${seconds}s`;
}

/**
 * Formats a message creation timestamp for display in chat bubbles and footer rows.
 * - Same day: "14:32" (or locale equivalent e.g. "2:32 PM")
 * - Different day (same year): "8/29 14:32"
 * - Different year: "2025/8/29 14:32"
 */
export function formatMessageTimestamp(timestamp: number, now: number = Date.now()): string {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return '';
    }
    const date = new Date(timestamp);
    const nowDate = new Date(now);

    const isSameDay = date.getFullYear() === nowDate.getFullYear()
        && date.getMonth() === nowDate.getMonth()
        && date.getDate() === nowDate.getDate();

    const timeString = date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
    });

    if (isSameDay) {
        return timeString;
    }

    const month = date.getMonth() + 1;
    const day = date.getDate();

    if (date.getFullYear() === nowDate.getFullYear()) {
        return `${month}/${day} ${timeString}`;
    }

    return `${date.getFullYear()}/${month}/${day} ${timeString}`;
}

/**
 * Formats task/turn execution duration:
 * - < 100ms: "<0.1s"
 * - 100ms - 999ms: "0.5s"
 * - 1000ms - 9999ms: "4.8s", "5s"
 * - 10000ms - 59999ms: "14s", "52s"
 * - >= 60000ms: "1m12s", "1h5m" (delegates to formatWorkDuration)
 */
export function formatTurnDuration(durationMs: number): string {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return '<0.1s';
    }
    if (durationMs < 100) {
        return '<0.1s';
    }
    if (durationMs < 1000) {
        const tenths = (durationMs / 1000).toFixed(1);
        return `${parseFloat(tenths)}s`;
    }
    if (durationMs < 10000) {
        const tenths = (durationMs / 1000).toFixed(1);
        return `${parseFloat(tenths)}s`;
    }
    if (durationMs < 60000) {
        return `${Math.round(durationMs / 1000)}s`;
    }
    return formatWorkDuration(durationMs);
}
