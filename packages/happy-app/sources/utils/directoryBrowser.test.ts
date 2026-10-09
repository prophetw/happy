import { describe, expect, it } from 'vitest';
import { getDirectoryBrowserPath, getParentDirectory, joinDirectoryPath } from './directoryBrowser';

describe('remote directory paths', () => {
    it.each([
        [null, '/home/dev', '/home/dev'],
        ['~/code/repo/', '/home/dev', '/home/dev/code/repo'],
        ['/', '/home/dev', '/'],
        ['~', '/', '/'],
        ['~', 'C:\\', 'C:\\'],
        ['C:/Users/dev/code/', undefined, 'C:\\Users\\dev\\code'],
        ['C:\\', undefined, 'C:\\'],
        ['~\\code', 'C:\\Users\\dev', 'C:\\Users\\dev\\code'],
        ['\\\\server\\share\\repo\\', undefined, '\\\\server\\share\\repo'],
        ['relative', '/home/dev', '/home/dev'],
        ['relative', undefined, null],
        ['~', undefined, null],
    ])('starts from %s with remote home %s', (value, homeDir, expected) => {
        expect(getDirectoryBrowserPath(value, homeDir ?? undefined)).toBe(expected);
    });

    it.each([
        ['/home/dev/repo', '/home/dev'],
        ['/home', '/'],
        ['/', null],
        ['C:\\Users\\dev', 'C:\\Users'],
        ['C:\\Users', 'C:\\'],
        ['C:\\', null],
        ['\\\\server\\share\\repo', '\\\\server\\share'],
        ['\\\\server\\share', null],
        ['/home/folder\\name', '/home'],
    ])('finds the parent of %s without leaving a filesystem root', (path, expected) => {
        expect(getParentDirectory(path)).toBe(expected);
    });

    it.each([
        ['/', 'repo', '/repo'],
        ['/home/dev', '项目 with spaces', '/home/dev/项目 with spaces'],
        ['/home/dev', 'folder\\name', '/home/dev/folder\\name'],
        ['C:\\', 'repo', 'C:\\repo'],
        ['\\\\server\\share', 'repo', '\\\\server\\share\\repo'],
    ])('joins a child on the remote OS (%s)', (path, name, expected) => {
        expect(joinDirectoryPath(path, name)).toBe(expected);
    });
});
