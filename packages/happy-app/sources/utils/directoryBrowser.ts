import { resolveAbsolutePath } from './pathUtils';

/** Paths belong to the remote computer, which can use a different OS. */
export function getDirectoryBrowserPath(value: string | null, homeDir?: string): string | null {
    const input = value?.trim() || '~';
    const expanded = input === '~' && homeDir
        ? homeDir
        : resolveAbsolutePath(input.replace(/^~\\/, '~/'), homeDir);
    if (/^[A-Za-z]:[\\/]/.test(expanded) || expanded.startsWith('\\\\')) {
        const path = expanded.replace(/\//g, '\\');
        if (/^[A-Za-z]:\\$/.test(path)) return path;
        return path.replace(/\\+$/, '');
    }
    if (expanded.startsWith('/')) return expanded.replace(/\/+$/, '') || '/';
    // The daemon's cwd is unrelated to the user's chosen project. Never use it
    // to silently resolve a relative path or an unknown home directory.
    return input !== '~' && homeDir ? getDirectoryBrowserPath(homeDir) : null;
}

function directorySeparator(path: string): '/' | '\\' {
    return /^[A-Za-z]:\\/.test(path) || path.startsWith('\\\\') ? '\\' : '/';
}

export function getParentDirectory(path: string): string | null {
    const separator = directorySeparator(path);
    if (path === '/' || /^[A-Za-z]:\\$/.test(path) || /^\\\\[^\\]+\\[^\\]+$/.test(path)) return null;
    const index = path.lastIndexOf(separator);
    if (index < 0) return null;
    if (index === 0) return '/';
    if (index === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3);
    return path.slice(0, index);
}

export function joinDirectoryPath(path: string, name: string): string {
    const separator = directorySeparator(path);
    return `${path}${path.endsWith(separator) ? '' : separator}${name}`;
}
