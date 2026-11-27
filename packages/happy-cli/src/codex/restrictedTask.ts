import { constants, chmodSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { startSessionMcp } from '@/claude/utils/startHappyServer';
import { CodexAppServerClient } from './codexAppServerClient';
import { disabledTaskFeatures } from './restrictedTaskFeatures';

export function createRestrictedTaskClient() {
    // Use the normal account credentials, without loading its project tools,
    // plugins, hooks, rules or MCP configuration into this restricted task.
    const home = join(process.cwd(), 'codex-home');
    mkdirSync(home, { mode: 0o700, recursive: true });
    const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
    const target = join(home, 'auth.json');
    if (existsSync(auth) && !existsSync(target)) {
        copyFileSync(auth, target, constants.COPYFILE_EXCL);
        chmodSync(target, 0o600);
    }
    return new CodexAppServerClient(undefined, {
        env: { CODEX_HOME: home }, disableApplyPatch: true,
        config: {
            features: { ...Object.fromEntries(disabledTaskFeatures.map(feature => [feature, false])), skip_host_skill_discovery: true },
            web_search: 'disabled', project_doc_max_bytes: 0,
        },
    });
}

const sourceInput = z.string().max(1024);
export function startInspectionServer() {
    const root = join(process.cwd(), 'source');
    const validate = async (path: string) => {
        if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').includes('..'))
            throw Error('source_path_invalid');
        const target = resolve(root, path);
        if (target !== root && !target.startsWith(root + sep) || await realpath(target) !== target)
            throw Error('source_path_invalid');
        return target;
    };
    const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
    return startSessionMcp(() => {
        const server = new McpServer({ name: 'task_source', version: '1.0.0' });
        server.registerTool('list_files', {
            description: 'List one directory from the sealed task source. Use an empty path for the root.',
            inputSchema: { path: sourceInput, offset: z.number().int().nonnegative().max(50000).default(0) },
            annotations: { readOnlyHint: true },
        }, async ({ path, offset }) => {
            const entries = await readdir(await validate(path), { withFileTypes: true });
            const names = entries.map(entry => entry.name + (entry.isDirectory() ? '/' : '')).sort();
            const next = offset + 500;
            return text(JSON.stringify({ entries: names.slice(offset, next), nextOffset: next < names.length ? next : null }));
        });
        server.registerTool('read_file', {
            description: 'Read bytes of a regular file from the sealed task source as UTF-8. Use offset for further chunks.',
            inputSchema: { path: sourceInput, offset: z.number().int().nonnegative().max(128 * 1024 * 1024).default(0) },
            annotations: { readOnlyHint: true },
        }, async ({ path, offset }) => {
            const file = await open(await validate(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const stat = await file.stat();
                if (!stat.isFile()) throw Error('source_not_a_file');
                const buffer = Buffer.alloc(16000);
                const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
                return text(JSON.stringify({
                    text: buffer.subarray(0, bytesRead).toString('utf8'),
                    nextOffset: offset + bytesRead < stat.size ? offset + bytesRead : null,
                }));
            } finally { await file.close(); }
        });
        return server;
    }, '/' + randomUUID());
}
