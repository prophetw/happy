import Fuse from 'fuse.js';

export type DirectorySearchOption = {
    key: string;
    name: string;
    description?: string | null;
};

/** Keep the actual path/project key separate from its short display name. */
export function formatDirectorySearchOption<T extends DirectorySearchOption>(option: T): T {
    if (option.key.startsWith('project:')) return option;
    const isPath = option.name === option.key || /^(?:[~\\/]|[A-Za-z]:[\\/])/.test(option.name);
    if (!isPath) return option;
    const name = option.name.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || option.name;
    return { ...option, name, description: option.description || option.name };
}

function normalize(value: string): string {
    return value.trim().replace(/\\/g, '/').toLowerCase();
}

/** Search only supplied candidates; typing never scans the remote filesystem. */
export function searchDirectoryOptions<T extends DirectorySearchOption>(options: readonly T[], query: string): T[] {
    const input = normalize(query);
    if (!input) return [...options];

    const candidates = options.map((option, index) => ({
        option,
        index,
        name: normalize(option.name),
        path: option.key.startsWith('project:') ? '' : normalize(option.key),
        description: normalize(option.description ?? ''),
    }));
    // A shared parent path must not make every sibling look like a typo match.
    const fuse = new Fuse(candidates, {
        keys: [{ name: 'name', weight: 0.7 }, { name: 'path', weight: 0.2 }, { name: 'description', weight: 0.1 }],
        threshold: 0.3,
        ignoreLocation: true,
        includeScore: true,
    });
    const fuzzyResults = input.includes('/') ? [] : fuse.search(input);
    const scores = new Map(fuzzyResults.map((result) => [result.item.index, result.score ?? 1]));
    const rank = (candidate: typeof candidates[number]): number => {
        if (candidate.name === input || candidate.path === input) return 0;
        if (candidate.name.startsWith(input)) return 1;
        if ([candidate.name, candidate.path, candidate.description].some((field) => field.includes(input))) return 2;
        return 3;
    };

    return candidates
        .filter((candidate) => rank(candidate) < 3 || scores.has(candidate.index))
        .sort((a, b) => rank(a) - rank(b)
            || (rank(a) === 3 ? (scores.get(a.index) ?? 1) - (scores.get(b.index) ?? 1) : 0)
            || a.index - b.index)
        .map((candidate) => candidate.option);
}
