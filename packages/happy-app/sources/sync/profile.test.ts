import { describe, expect, it, vi } from 'vitest';
import { profileParse } from './profile';

// Regression: the server stores and forwards the raw GitHub OAuth profile,
// where name/email are null unless the user made them public. Parsing used to
// reject that shape, log a ZodError, and silently fall back to defaults.
describe('profileParse', () => {
    it('accepts a GitHub profile with null name and email', () => {
        const parsed = profileParse({
            id: 'user_1',
            timestamp: 1720000000000,
            firstName: null,
            lastName: null,
            username: 'octocat',
            avatar: null,
            github: {
                id: 583231,
                login: 'octocat',
                type: 'User',
                site_admin: false,
                avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
                gravatar_id: null,
                name: null,
                company: null,
                blog: null,
                location: null,
                email: null,
                hireable: null,
                bio: null
            },
            connectedServices: []
        });

        expect(parsed.id).toBe('user_1');
        expect(parsed.github?.login).toBe('octocat');
        expect(parsed.github?.name).toBeNull();
        expect(parsed.github?.email).toBeNull();
    });

    it('accepts a GitHub profile with the email key missing entirely', () => {
        const parsed = profileParse({
            id: 'user_1',
            timestamp: 1720000000000,
            firstName: 'Ada',
            lastName: null,
            avatar: null,
            github: {
                id: 583231,
                login: 'octocat',
                name: 'The Octocat',
                avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
                bio: null
            },
            connectedServices: []
        });

        expect(parsed.github?.name).toBe('The Octocat');
    });

    it('still falls back to defaults for structurally invalid profiles', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const parsed = profileParse({
                id: 'user_1',
                timestamp: 1720000000000,
                firstName: null,
                lastName: null,
                avatar: null,
                github: { id: 'not-a-number', login: 42 },
                connectedServices: []
            });

            expect(parsed).toEqual({
                id: '',
                timestamp: 0,
                firstName: null,
                lastName: null,
                avatar: null,
                github: null,
                connectedServices: []
            });
        } finally {
            errorSpy.mockRestore();
        }
    });
});
