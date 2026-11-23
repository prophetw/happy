import { afterEach, expect, it, vi } from 'vitest';
import { linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HOSTED_STORAGE_LIMIT, readHostedStorage } from './hostedDotStorage';

const hooks = vi.hoisted(() => ({
    paths: new Map<number, string>(),
    onOpen: undefined as undefined | ((file: string) => void),
    onRead: undefined as undefined | ((file: string) => void),
    onNamedStat: undefined as undefined | ((file: string) => boolean),
}));
vi.mock('node:fs', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return { ...fs,
        lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
            const stat = fs.lstatSync(...args);
            if (stat && (!args[1] || args[1].bigint) && hooks.onNamedStat?.(String(args[0])))
                Object.assign(stat, { nlink: typeof stat.nlink === 'bigint' ? 0n : 0 });
            return stat;
        },
        openSync: (...args: Parameters<typeof fs.openSync>) => {
            const fd = fs.openSync(...args), file = String(args[0]); hooks.paths.set(fd, file); hooks.onOpen?.(file); return fd;
        },
        readSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number | null) => {
            const size = fs.readSync(fd, bytes, offset, length, position); hooks.onRead?.(hooks.paths.get(fd) ?? ''); return size;
        },
        closeSync: (fd: number) => { hooks.paths.delete(fd); fs.closeSync(fd); },
    };
});

const roots: string[] = [];
const before = { version: 1, generation: 'before', payload: 'x'.repeat(4096) };
const after = { version: 1, generation: 'after', payload: 'y'.repeat(4096) };
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'hosted-storage-read-')); roots.push(directory);
    const file = join(directory, 'state.json'); writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
    return { directory, file };
}
function replace(file: string, value: unknown) {
    const temporary = file + '.' + randomUUID(); writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, file);
}
afterEach(() => {
    hooks.onOpen = hooks.onRead = hooks.onNamedStat = undefined; hooks.paths.clear();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const timing of ['onOpen', 'onRead'] as const) it(`${timing}: atomic rename discards old bytes and rereads the replacement`, () => {
    const f = fixture(); let replacements = 0;
    hooks[timing] = path => {
        if (path !== f.file) return;
        hooks[timing] = undefined; replacements++; replace(f.file, after);
    };
    expect(readHostedStorage(f.file)).toEqual(after);
    expect(replacements).toBe(1);
});

it('a pathname stat can observe the inode just detached by atomic publication', () => {
    const f = fixture(); let replacements = 0;
    hooks.onNamedStat = path => {
        if (path !== f.file) return false;
        hooks.onNamedStat = undefined; replacements++; replace(f.file, after);
        return true;
    };
    expect(readHostedStorage(f.file)).toEqual(after);
    expect(replacements).toBe(1);
});

it('holds the old descriptor while opening its replacement so its inode cannot be recycled', () => {
    const f = fixture(); let opens = 0, concurrent = 0;
    hooks.onOpen = path => {
        if (path !== f.file) return;
        opens++;
        if (opens === 1) replace(f.file, after);
        else concurrent = [...hooks.paths.values()].filter(value => value === f.file).length;
    };
    expect(readHostedStorage(f.file)).toEqual(after);
    expect(opens).toBe(2);
    expect(concurrent).toBe(2);
    expect(hooks.paths.size).toBe(0);
});

it('repeated inode replacement fails after one complete reopen', () => {
    const f = fixture(); let opens = 0, generation = 0;
    hooks.onOpen = path => {
        if (path !== f.file) return;
        opens++; replace(f.file, { ...after, generation: generation++ });
    };
    expect(() => readHostedStorage(f.file)).toThrow('hosted_storage_file_changed');
    expect(opens).toBe(2);
});

it('same-inode modification never retries or returns the earlier descriptor bytes', () => {
    const f = fixture(); let opens = 0;
    hooks.onOpen = path => { if (path === f.file) opens++; };
    hooks.onRead = path => {
        if (path !== f.file) return;
        hooks.onRead = undefined; writeFileSync(f.file, JSON.stringify(after));
    };
    expect(() => readHostedStorage(f.file)).toThrow('hosted_storage_file_changed');
    expect(opens).toBe(1);
});

for (const invalid of ['hardlink', 'symlink', 'size', 'json'] as const) it(`an invalid ${invalid} replacement is never accepted by the retry`, () => {
    const f = fixture();
    hooks.onOpen = path => {
        if (path !== f.file) return;
        hooks.onOpen = undefined; replace(f.file, after);
        if (invalid === 'hardlink') linkSync(f.file, f.file + '.other');
        if (invalid === 'symlink') { renameSync(f.file, f.file + '.other'); symlinkSync(f.file + '.other', f.file); }
        if (invalid === 'size') writeFileSync(f.file, 'x'.repeat(HOSTED_STORAGE_LIMIT + 1));
        if (invalid === 'json') writeFileSync(f.file, '{malformed');
    };
    expect(() => readHostedStorage(f.file)).toThrow();
});
