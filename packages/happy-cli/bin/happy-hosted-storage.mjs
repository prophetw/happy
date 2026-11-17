#!/usr/bin/env node
// Explicit offline maintenance. Happy's lifecycle implementation owns all locks and validation.
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { changeHostedDotStorage } from '../dist/codex/hostedDotLifecycle.mjs';

try {
    const [action, file, ...extra] = process.argv.slice(2);
    if (!['migrate', 'rollback', 'recover'].includes(action) || !file || extra.length || !isAbsolute(file) || resolve(file) !== file)
        throw Error('Usage: happy-hosted-storage.mjs migrate|rollback|recover /absolute/path/to/config.json');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw Error('hosted_storage_config_invalid');
    const { directory, dotId, sessionId } = JSON.parse(readFileSync(file, 'utf8'));
    console.log(JSON.stringify(changeHostedDotStorage({ directory, dotId, sessionId }, { migrate: 'sqlite', rollback: 'json', recover: 'recover' }[action])));
} catch (error) { console.error(error.message); process.exitCode = 1; }
