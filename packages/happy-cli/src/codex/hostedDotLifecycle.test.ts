import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareHostedStorage } from './hostedDotStorage';
import { statusHostedDot } from './hostedDotLifecycle';
import { HOSTED_STATE_MAX_BYTES } from './hostedDotState';

const hooks = vi.hoisted(() => ({
    paths: new Map<number, string>(),
    onOpen: undefined as undefined | ((file: string) => void),
    onRead: undefined as undefined | ((file: string) => void),
}));
vi.mock('node:fs', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return { ...fs,
        openSync: (...args: Parameters<typeof fs.openSync>) => {
            const fd = fs.openSync(...args), file = String(args[0]); hooks.paths.set(fd, file); hooks.onOpen?.(file); return fd;
        },
        readSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number | null) => {
            const size = fs.readSync(fd, bytes, offset, length, position); hooks.onRead?.(hooks.paths.get(fd) ?? ''); return size;
        },
        closeSync: (fd: number) => { hooks.paths.delete(fd); fs.closeSync(fd); },
    };
});
afterEach(() => { hooks.onOpen = hooks.onRead = undefined; hooks.paths.clear(); });

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'lifecycle-read-'));
    const config = { version: 1 as const, dotId: randomUUID(), sessionId: 'fixture', happyHome: join(directory, 'happy'),
        serverUrl: 'https://relay.invalid', directory, executable: 'fixture', args: [], model: 'fixture', effort: 'xhigh' as const,
        provider: 'fixture', providerConfig: {}, instruction: 'fixture', codexHome: join(directory, 'codex'), environment: [] };
    const binding = { directory, dotId: config.dotId, sessionId: config.sessionId };
    prepareHostedStorage(directory);
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    return { directory, config, binding };
}
function replace(file: string, value: unknown, mode = 0o600) {
    const tmp = file + '.' + randomUUID(); writeFileSync(tmp, JSON.stringify(value), { mode }); chmodSync(tmp, mode); renameSync(tmp, file);
}
for (const target of ['config.json', 'reset-epoch.json'] as const) {
    for (const timing of ['onOpen', 'onRead'] as const) it(`${target}: ${timing} rename discards old bytes and reopens the current private inode`, () => {
        const f = fixture(), file = join(f.directory, target); let replacements = 0;
        if (target === 'reset-epoch.json') writeFileSync(file, JSON.stringify({ epoch: 2 }), { mode: 0o600 });
        try {
            hooks[timing] = path => {
                if (path !== file) return;
                hooks[timing] = undefined; replacements++;
                replace(file, target === 'config.json' ? f.config : { epoch: 2 });
            };
            const result = statusHostedDot(f.binding);
            expect(replacements).toBe(1);
            expect(result.status).toBe('not_started');
            expect(result.epoch).toBe(target === 'reset-epoch.json' ? 2 : 0);
        } finally { hooks.onOpen = hooks.onRead = undefined; rmSync(f.directory, { recursive: true, force: true }); }
    });
}
it('repeated config inode replacement fails after one full reopen', () => {
    const f = fixture(), file = join(f.directory, 'config.json'); let opens = 0;
    try {
        hooks.onOpen = path => { if (path === file) { opens++; replace(file, f.config); } };
        expect(() => statusHostedDot(f.binding)).toThrow('hosted_lifecycle_file_changed');
        expect(opens).toBe(2);
    } finally { hooks.onOpen = undefined; rmSync(f.directory, { recursive: true, force: true }); }
});
it('same-inode modification never retries or accepts an earlier descriptor snapshot', () => {
    const f = fixture(), file = join(f.directory, 'config.json'); let opens = 0;
    try {
        hooks.onOpen = path => { if (path === file) opens++; };
        hooks.onRead = path => {
            if (path !== file) return;
            hooks.onRead = undefined;
            writeFileSync(file, JSON.stringify({ ...f.config, sessionId: 'foreign-longer' }));
        };
        expect(() => statusHostedDot(f.binding)).toThrow('hosted_lifecycle_file_changed');
        expect(opens).toBe(1);
    } finally { hooks.onOpen = hooks.onRead = undefined; rmSync(f.directory, { recursive: true, force: true }); }
});
for (const invalid of ['mode', 'hardlink', 'symlink', 'size', 'json'] as const) it(`an invalid ${invalid} replacement cannot trigger a permissive retry`, () => {
    const f = fixture(), file = join(f.directory, 'config.json');
    try {
        hooks.onOpen = path => {
            if (path !== file) return;
            hooks.onOpen = undefined;
            replace(file, f.config, invalid === 'mode' ? 0o644 : 0o600);
            if (invalid === 'hardlink') linkSync(file, file + '.other');
            if (invalid === 'symlink') { renameSync(file, file + '.other'); symlinkSync(file + '.other', file); }
            if (invalid === 'size') writeFileSync(file, 'x'.repeat(HOSTED_STATE_MAX_BYTES + 1));
            if (invalid === 'json') writeFileSync(file, '{malformed');
        };
        expect(() => statusHostedDot(f.binding)).toThrow();
    } finally { hooks.onOpen = undefined; rmSync(f.directory, { recursive: true, force: true }); }
});
