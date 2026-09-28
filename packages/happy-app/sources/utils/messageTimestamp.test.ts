import { describe, expect, it } from 'vitest';
import { formatMessageTimestamp, formatTurnDuration } from './messageTimestamp';

describe('formatMessageTimestamp', () => {
    it('returns empty string for invalid timestamp', () => {
        expect(formatMessageTimestamp(0)).toBe('');
        expect(formatMessageTimestamp(-1)).toBe('');
        expect(formatMessageTimestamp(NaN)).toBe('');
    });

    it('formats time for the same day', () => {
        const now = new Date('2026-08-29T14:30:00Z').getTime();
        const msgTime = new Date('2026-08-29T10:15:00Z').getTime();
        const formatted = formatMessageTimestamp(msgTime, now);
        expect(formatted).toMatch(/\d{1,2}:\d{2}/);
        expect(formatted).not.toContain('/');
    });

    it('formats date and time for a different day in the same year', () => {
        const now = new Date('2026-08-29T14:30:00Z').getTime();
        const msgTime = new Date('2026-08-25T10:15:00Z').getTime();
        const formatted = formatMessageTimestamp(msgTime, now);
        expect(formatted).toMatch(/8\/\d{1,2} \d{1,2}:\d{2}/);
    });

    it('formats year, date, and time for a previous year', () => {
        const now = new Date('2026-08-29T14:30:00Z').getTime();
        const msgTime = new Date('2025-05-12T10:15:00Z').getTime();
        const formatted = formatMessageTimestamp(msgTime, now);
        expect(formatted).toMatch(/2025\/5\/12 \d{1,2}:\d{2}/);
    });
});

describe('formatTurnDuration', () => {
    it('formats sub-100ms duration', () => {
        expect(formatTurnDuration(0)).toBe('<0.1s');
        expect(formatTurnDuration(50)).toBe('<0.1s');
    });

    it('formats sub-second duration', () => {
        expect(formatTurnDuration(300)).toBe('0.3s');
        expect(formatTurnDuration(800)).toBe('0.8s');
    });

    it('formats sub-10s duration with 1 decimal digit', () => {
        expect(formatTurnDuration(1200)).toBe('1.2s');
        expect(formatTurnDuration(4800)).toBe('4.8s');
        expect(formatTurnDuration(5000)).toBe('5s');
    });

    it('formats sub-minute duration rounded to seconds', () => {
        expect(formatTurnDuration(12400)).toBe('12s');
        expect(formatTurnDuration(45800)).toBe('46s');
    });

    it('formats minute and hour durations', () => {
        expect(formatTurnDuration(75000)).toBe('1m15s');
        expect(formatTurnDuration(3665000)).toBe('1h1m');
    });
});
