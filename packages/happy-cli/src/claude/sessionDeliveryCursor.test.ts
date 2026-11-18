import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return fixture.home; } } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

import {
    ensureSessionDeliveryCursor,
    readSessionDeliveryCursor,
    recordSessionDeliveryCursor,
} from './sessionDeliveryCursor';

describe('sessionDeliveryCursor', () => {
    beforeEach(() => {
        fixture.home = mkdtempSync(join(tmpdir(), 'happy-delivery-cursor-'));
    });

    afterEach(() => {
        rmSync(fixture.home, { recursive: true, force: true });
    });

    it('initializes a new session at zero without moving backwards', () => {
        expect(readSessionDeliveryCursor('session-a')).toBeNull();
        expect(ensureSessionDeliveryCursor('session-a')).toBe(0);
        recordSessionDeliveryCursor('session-a', 42);
        recordSessionDeliveryCursor('session-a', 41);
        expect(readSessionDeliveryCursor('session-a')).toBe(42);
        expect(ensureSessionDeliveryCursor('session-a')).toBe(42);
    });

    it('isolates sessions and rejects unsafe IDs and sequences', () => {
        recordSessionDeliveryCursor('session-a', 7);
        expect(readSessionDeliveryCursor('session-b')).toBeNull();
        expect(() => recordSessionDeliveryCursor('../escape', 1)).toThrow('Invalid Happy session ID');
        expect(() => recordSessionDeliveryCursor('session-a', -1)).toThrow('Invalid Claude delivery cursor');
        expect(() => recordSessionDeliveryCursor('session-a', 1.5)).toThrow('Invalid Claude delivery cursor');
    });

    it('treats malformed or invalid persisted cursors as legacy sessions', () => {
        ensureSessionDeliveryCursor('session-a');
        const file = join(fixture.home, 'session-delivery-cursors', 'session-a.json');
        writeFileSync(file, '{broken');
        expect(readSessionDeliveryCursor('session-a')).toBeNull();
        writeFileSync(file, JSON.stringify({ seq: -1 }));
        expect(readSessionDeliveryCursor('session-a')).toBeNull();
    });
});
