#!/usr/bin/env node
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { migrateHostedDotJournal } from '../dist/codex/hostedDotLifecycle.mjs';

try {
    const [action, file, ...extra] = process.argv.slice(2);
    if (action !== 'migrate' || !file || extra.length || !isAbsolute(file) || realpathSync(file) !== file
        || join(dirname(file), 'config.json') !== file) throw Error('hosted_storage_usage');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let config;
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 65536)
            throw Error('hosted_storage_config_invalid');
        config = JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
    if (config.directory !== dirname(file)) throw Error('hosted_storage_config_invalid');
    console.log(JSON.stringify(migrateHostedDotJournal({ directory: config.directory, dotId: config.dotId, sessionId: config.sessionId })));
} catch (error) {
    // Validation failures can contain configuration or journal fields.
    const code = error?.message;
    console.error(typeof code === 'string' && /^([a-z]+_)+[a-z]+$/.test(code) ? code : 'hosted_storage_migration_failed');
    process.exitCode = 1;
}
