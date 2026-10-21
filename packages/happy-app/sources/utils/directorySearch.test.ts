import { describe, expect, it } from 'vitest';
import { formatDirectorySearchOption, searchDirectoryOptions } from './directorySearch';

describe('directory search', () => {
    it('shows a short folder name and its path without changing the selection key', () => {
        expect(formatDirectorySearchOption({ key: '/home/dev/code/happy', name: '~/code/happy' })).toEqual({
            key: '/home/dev/code/happy', name: 'happy', description: '~/code/happy',
        });
        expect(formatDirectorySearchOption({ key: 'C:\\code\\happy', name: 'C:\\code\\happy' })).toEqual({
            key: 'C:\\code\\happy', name: 'happy', description: 'C:\\code\\happy',
        });
        expect(formatDirectorySearchOption({ key: '/', name: '/' }).name).toBe('/');
    });

    it('preserves named projects, including projects that have no known directory', () => {
        const project = { key: 'project:internal-id', name: 'My project' };
        expect(formatDirectorySearchOption(project)).toBe(project);
        expect(searchDirectoryOptions([project], 'My project')).toEqual([project]);
        expect(searchDirectoryOptions([project], 'internal-id')).toEqual([]);
        expect(formatDirectorySearchOption({ key: '/work/repo', name: 'Project name', description: '~/repo' })).toEqual({
            key: '/work/repo', name: 'Project name', description: '~/repo',
        });
    });

    it('ranks exact names, prefixes, contained text and typos in that order', () => {
        const options = [
            { key: '/work/typo', name: 'hapy' },
            { key: '/work/container', name: 'my-happy-project' },
            { key: '/work/prefix', name: 'happy-app' },
            { key: '/work/exact', name: 'happy' },
        ];
        expect(searchDirectoryOptions(options, ' HAPPY ').map((option) => option.key)).toEqual([
            '/work/exact', '/work/prefix', '/work/container', '/work/typo',
        ]);
        expect(searchDirectoryOptions(options, '   ')).toEqual(options);
    });

    it('matches full paths, home-relative descriptions and Windows separators', () => {
        const options = [{ key: 'C:\\work\\happy', name: 'Repo', description: '~/code/happy' }];
        expect(searchDirectoryOptions(options, 'c:/work/ha')).toEqual(options);
        expect(searchDirectoryOptions(options, '~/CODE/ha')).toEqual(options);
        expect(searchDirectoryOptions(options, 'unrelated-project')).toEqual([]);
        expect(searchDirectoryOptions([
            { key: '/work/repo/a-dir', name: 'a-dir' },
            { key: '/work/repo/z-dir', name: 'z-dir' },
        ], '/work/repo/a-').map((option) => option.name)).toEqual(['a-dir']);
    });
});
