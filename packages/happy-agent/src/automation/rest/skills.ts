import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';

function findPackageRoot(): string {
    let directory = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(directory, 'package.json'))) {
        const parent = dirname(directory);
        if (parent === directory) throw new Error('HAPPY_AGENT_PACKAGE_ROOT_NOT_FOUND');
        directory = parent;
    }
    return directory;
}

/** Load the packaged catalog once at a process/startup boundary, not per request. */
export function loadControlSkills(): Promise<SkillCatalog> {
    return loadSkills(join(findPackageRoot(), 'skills'), { strict: true });
}
