import { describe, expect, it, vi } from 'vitest';
import { switchRelay, type RelaySwitchParticipant } from './relaySwitch';

describe('switching relay without pairing again', () => {
    it('moves every live connection before saving the new login', async () => {
        const events: string[] = [];
        const participant = (name: string): RelaySwitchParticipant => ({
            name,
            call: async request => {
                events.push(`${name}:${request.phase}`);
                return { success: true as const };
            },
        });
        await switchRelay({
            id: 'switch-1', serverUrl: 'https://new.test/relay/',
            participants: [participant('daemon'), participant('session')],
            authenticate: async () => 'new-relay-token',
            save: async (url, token) => { events.push(`save:${url}:${token}`); },
        });
        expect(events).toEqual([
            'daemon:prepare', 'session:prepare', 'daemon:commit', 'session:commit',
            'daemon:finish', 'session:finish', 'save:https://new.test/relay:new-relay-token',
        ]);
    });

    it('keeps the old login and rolls back all participants when one connection fails', async () => {
        const events: string[] = [];
        const participants = ['daemon', 'session'].map(name => ({
            name,
            call: async (request: { phase: string }) => {
                events.push(`${name}:${request.phase}`);
                if (name === 'session' && request.phase === 'commit') throw new Error('target unreachable');
                return { success: true as const };
            },
        }));
        await expect(switchRelay({
            id: 'switch-2', serverUrl: 'https://new.test', participants,
            authenticate: async () => 'new-token',
            save: async () => { events.push('save'); },
        })).rejects.toThrow('target unreachable');
        expect(events).toContain('daemon:rollback');
        expect(events).toContain('session:rollback');
        expect(events).not.toContain('save');
    });

    it('does not contact paired devices when the target rejects the account', async () => {
        let contacted = false;
        await expect(switchRelay({
            id: 'switch-3', serverUrl: 'https://private.test',
            participants: [{ name: 'daemon', call: async () => { contacted = true; return { success: true as const }; } }],
            authenticate: async () => { throw new Error('HTTP 403'); },
            save: async () => { throw new Error('must not save'); },
        })).rejects.toThrow('HTTP 403');
        expect(contacted).toBe(false);
    });

    it.each(['returned error', 'unregistered RPC'])('identifies an old client without asking it to roll back: %s', async mode => {
        const events: string[] = [];
        const legacy: RelaySwitchParticipant = {
            name: 'Old computer session',
            call: async request => {
                events.push(`old:${request.phase}`);
                if (mode === 'unregistered RPC') throw new Error('RPC method not available');
                return { error: 'Method not found' };
            },
        };
        const updated: RelaySwitchParticipant = {
            name: 'Updated computer',
            call: async request => { events.push(`new:${request.phase}`); return { success: true }; },
        };
        await expect(switchRelay({
            id: 'mixed-clients', serverUrl: 'https://new.test', participants: [updated, legacy],
            authenticate: async () => 'new-token', save: async () => { events.push('save'); },
        })).rejects.toThrow('Old computer session');
        expect(events).toContain('new:rollback');
        expect(events).not.toContain('old:rollback');
        expect(events.some(event => /commit|finish|save/.test(event))).toBe(false);
    });

    it('still rolls back a prepare whose acknowledgement was lost', async () => {
        const phases: string[] = [];
        await expect(switchRelay({
            id: 'lost-ack', serverUrl: 'https://new.test',
            participants: [{ name: 'Uncertain computer', call: async request => {
                phases.push(request.phase);
                if (request.phase === 'prepare') throw new Error('The computer did not respond');
                return { success: true };
            } }],
            authenticate: async () => 'new-token', save: async () => { throw new Error('must not save'); },
        })).rejects.toThrow('Uncertain computer: The computer did not respond');
        expect(phases).toEqual(['prepare', 'rollback']);
    });

    it('keeps malformed prepare acknowledgements uncertain and attempts cleanup', async () => {
        const call = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({ success: true });
        await expect(switchRelay({
            id: 'malformed-ack', serverUrl: 'https://new.test', participants: [{ name: 'Malformed client', call }],
            authenticate: async () => 'new-token', save: async () => { throw new Error('must not save'); },
        })).rejects.toThrow('Malformed client: Relay switch is not supported');
        expect(call.mock.calls.map(([request]) => request.phase)).toEqual(['prepare', 'rollback']);
    });

    it('preserves the initial failure and device name when rollback really cannot be confirmed', async () => {
        const attempted = switchRelay({
            id: 'failed-rollback', serverUrl: 'https://new.test',
            participants: [{ name: 'Disconnected computer', call: async request => {
                if (request.phase === 'prepare') return { success: true };
                throw new Error(request.phase === 'commit' ? 'target unreachable' : 'old connection unavailable');
            } }],
            authenticate: async () => 'new-token', save: async () => { throw new Error('must not save'); },
        });
        await expect(attempted).rejects.toThrow('Disconnected computer: target unreachable');
        await expect(attempted).rejects.toThrow('Keep the original relay available');
    });
});
