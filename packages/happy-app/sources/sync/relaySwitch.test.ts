import { describe, expect, it } from 'vitest';
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
});
