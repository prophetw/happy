import { describe, expect, it } from 'vitest';
import { getDirectoryBreadcrumbs, getDirectoryBrowserPath, getParentDirectory, joinDirectoryPath, parseDirectoryInput } from './directoryBrowser';

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

    it.each([
        ['  D:/code/happy/  ', undefined, 'D:\\code\\happy'],
        ['~\\code', 'C:\\Users\\dev', 'C:\\Users\\dev\\code'],
        ['~/code', '/home/dev', '/home/dev/code'],
        ['~', undefined, '~'],
        ['\\\\server\\share\\repo', undefined, '\\\\server\\share\\repo'],
        ['relative/repo', '/home/dev', null],
        ['C:relative', undefined, null],
        ['~someone/repo', '/home/dev', null],
        ['\\\\server', undefined, null],
        ['  ', '/home/dev', null],
    ])('validates a manually entered path without falling back to home (%s)', (value, homeDir, expected) => {
        expect(parseDirectoryInput(value, homeDir ?? undefined)).toBe(expected);
    });

    it.each([
        ['/', [{ label: '/', path: '/' }]],
        ['/home/repo', [{ label: '/', path: '/' }, { label: 'home', path: '/home' }, { label: 'repo', path: '/home/repo' }]],
        ['D:\\code\\repo', [{ label: 'D:\\', path: 'D:\\' }, { label: 'code', path: 'D:\\code' }, { label: 'repo', path: 'D:\\code\\repo' }]],
        ['\\\\server\\share\\repo', [{ label: '\\\\server\\share', path: '\\\\server\\share' }, { label: 'repo', path: '\\\\server\\share\\repo' }]],
        ['/\\repo', [{ label: '/', path: '/' }, { label: '\\repo', path: '/\\repo' }]],
    ])('builds clickable breadcrumbs without leaving the remote root (%s)', (path, expected) => {
        expect(getDirectoryBreadcrumbs(path)).toEqual(expected);
    });
});
