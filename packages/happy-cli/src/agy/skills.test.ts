import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkillFrontmatter,
  parseAgySkillsJson,
  parseAgySkillsText,
  getAgySkillCommandNames,
  discoverAgySkillsFilesystem,
  fetchAgySkills,
  formatAgySkillsMarkdown,
  formatAgySkillsTerminal,
  type AgySkill,
} from './skills';

describe('agy skills', () => {
  describe('parseSkillFrontmatter', () => {
    it('parses single line name and description', () => {
      const content = `---
name: test-skill
description: Simple test skill description.
---
# Content`;
      const res = parseSkillFrontmatter(content);
      expect(res.name).toBe('test-skill');
      expect(res.description).toBe('Simple test skill description.');
    });

    it('parses multi-line folded YAML description', () => {
      const content = `---
name: agy-customizations
description: >-
  Comprehensive guide and reference
  for Antigravity.
allowed-tools: Bash(*)
---`;
      const res = parseSkillFrontmatter(content);
      expect(res.name).toBe('agy-customizations');
      expect(res.description).toBe('Comprehensive guide and reference for Antigravity.');
    });

    it('handles content without frontmatter', () => {
      const content = '# Just markdown without yaml frontmatter';
      const res = parseSkillFrontmatter(content);
      expect(res.name).toBeUndefined();
      expect(res.description).toBeUndefined();
    });
  });

  describe('parseAgySkillsJson', () => {
    it('parses command.data.skills structure', () => {
      const json = JSON.stringify({
        command: {
          name: 'skills',
          data: {
            skills: [
              {
                name: 'antigravity-guide',
                description: 'Guide for Antigravity',
                path: '/path/to/SKILL.md',
                builtin: true,
              },
              {
                name: 'securecoder:audit',
                description: 'Run audit',
              },
            ],
          },
        },
      });

      const parsed = parseAgySkillsJson(json);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('antigravity-guide');
      expect(parsed[0].description).toBe('Guide for Antigravity');
      expect(parsed[0].builtin).toBe(true);
      expect(parsed[1].name).toBe('securecoder:audit');
    });

    it('returns empty array on invalid JSON', () => {
      expect(parseAgySkillsJson('not valid json')).toEqual([]);
      expect(parseAgySkillsJson('')).toEqual([]);
    });

    it('deduplicates skills by name', () => {
      const json = JSON.stringify({
        skills: [
          { name: 'duplicate', description: 'first' },
          { name: 'duplicate', description: 'second' },
        ],
      });
      const parsed = parseAgySkillsJson(json);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].description).toBe('first');
    });
  });

  describe('parseAgySkillsText', () => {
    it('parses space-aligned table output from agy --print /skills', () => {
      const text = `
Available skills:
agent-browser       Browser automation CLI for AI agents.
antigravity-guide   Provides a comprehensive guide.
custom-cmd          A custom skill.
`;
      const parsed = parseAgySkillsText(text);
      expect(parsed).toHaveLength(3);
      expect(parsed[0]).toEqual({
        name: 'agent-browser',
        description: 'Browser automation CLI for AI agents.',
      });
      expect(parsed[1]).toEqual({
        name: 'antigravity-guide',
        description: 'Provides a comprehensive guide.',
      });
      expect(parsed[2]).toEqual({
        name: 'custom-cmd',
        description: 'A custom skill.',
      });
    });

    it('parses tab-separated output', () => {
      const text = 'skill-one\tDescription for skill one\nskill-two\tDescription for skill two';
      const parsed = parseAgySkillsText(text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('skill-one');
      expect(parsed[0].description).toBe('Description for skill one');
    });

    it('strips ANSI color codes', () => {
      const text = '\u001b[32magent-browser\u001b[0m   \u001b[90mBrowser CLI\u001b[0m';
      const parsed = parseAgySkillsText(text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('agent-browser');
      expect(parsed[0].description).toBe('Browser CLI');
    });
  });

  describe('getAgySkillCommandNames', () => {
    it('returns unique sorted command names', () => {
      const skills: AgySkill[] = [
        { name: 'zebra', description: '' },
        { name: 'alpha', description: '' },
        { name: 'zebra', description: '' },
        { name: 'beta', description: '' },
      ];
      expect(getAgySkillCommandNames(skills)).toEqual(['alpha', 'beta', 'zebra']);
    });
  });

  describe('discoverAgySkillsFilesystem', () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await mkdtemp(join(tmpdir(), 'agy-skills-test-'));
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('discovers skills from workspace, builtin, and plugins folders', async () => {
      const cwd = join(tempRoot, 'workspace');
      const homeDir = join(tempRoot, 'home');

      // 1. Workspace skill
      const wsSkillDir = join(cwd, '.agents', 'skills', 'ws-skill');
      await mkdir(wsSkillDir, { recursive: true });
      await writeFile(
        join(wsSkillDir, 'SKILL.md'),
        '---\nname: ws-skill\ndescription: Workspace skill\n---\n',
      );

      // 2. Builtin skill
      const builtinSkillDir = join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'skills', 'guide');
      await mkdir(builtinSkillDir, { recursive: true });
      await writeFile(
        join(builtinSkillDir, 'SKILL.md'),
        '---\nname: antigravity-guide\ndescription: Builtin guide\n---\n',
      );

      // 3. Plugin skill
      const pluginSkillDir = join(homeDir, '.gemini', 'config', 'plugins', 'my-plugin', 'skills', 'test-tool');
      await mkdir(pluginSkillDir, { recursive: true });
      await writeFile(
        join(pluginSkillDir, 'SKILL.md'),
        '---\nname: test-tool\ndescription: Plugin skill\n---\n',
      );

      const discovered = await discoverAgySkillsFilesystem({ cwd, homeDir });
      expect(discovered).toHaveLength(3);

      const names = discovered.map((s) => s.name);
      expect(names).toContain('ws-skill');
      expect(names).toContain('antigravity-guide');
      expect(names).toContain('my-plugin:test-tool');
    });
  });

  describe('fetchAgySkills', () => {
    it('returns json result when agy json succeeds', async () => {
      const mockExecFile = vi.fn((_bin, _args, _opts, callback) => {
        const json = JSON.stringify({
          command: {
            name: 'skills',
            data: {
              skills: [{ name: 'json-skill', description: 'from json' }],
            },
          },
        });
        callback(null, json, '');
      });

      const res = await fetchAgySkills({
        execFileFn: mockExecFile as any,
      });

      expect(res.source).toBe('cli-json');
      expect(res.skills).toHaveLength(1);
      expect(res.skills[0].name).toBe('json-skill');
    });

    it('falls back to text print when json fails', async () => {
      let callCount = 0;
      const mockExecFile = vi.fn((_bin, args, _opts, callback) => {
        callCount++;
        if (args.includes('--output-format')) {
          callback(new Error('json flag unsupported'), '', 'unknown flag');
        } else {
          callback(null, 'text-skill   from text mode', '');
        }
      });

      const res = await fetchAgySkills({
        execFileFn: mockExecFile as any,
      });

      expect(res.source).toBe('cli-text');
      expect(res.skills).toHaveLength(1);
      expect(res.skills[0].name).toBe('text-skill');
      expect(res.skills[0].description).toBe('from text mode');
      expect(callCount).toBe(2);
    });

    it('falls back to filesystem when CLI execution fails completely', async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'agy-fallback-test-'));
      const cwd = join(tempRoot, 'ws');
      const wsSkillDir = join(cwd, '.agents', 'skills', 'fs-skill');
      await mkdir(wsSkillDir, { recursive: true });
      await writeFile(
        join(wsSkillDir, 'SKILL.md'),
        '---\nname: fs-skill\ndescription: FS fallback skill\n---\n',
      );

      const mockExecFile = vi.fn((_bin, _args, _opts, callback) => {
        callback(new Error('ENOENT agy not found'), '', '');
      });

      const res = await fetchAgySkills({
        cwd,
        homeDir: join(tempRoot, 'home'),
        execFileFn: mockExecFile as any,
      });

      expect(res.source).toBe('filesystem');
      expect(res.skills).toHaveLength(1);
      expect(res.skills[0].name).toBe('fs-skill');

      await rm(tempRoot, { recursive: true, force: true });
    });
  });

  describe('formatters', () => {
    const skills: AgySkill[] = [
      { name: 'agent-browser', description: 'Browser automation CLI' },
      { name: 'quick-cmd', description: '' },
    ];

    it('formats markdown list correctly', () => {
      const md = formatAgySkillsMarkdown(skills);
      expect(md).toContain('### 🛠️ Available Skills');
      expect(md).toContain('- **`/agent-browser`** — Browser automation CLI');
      expect(md).toContain('- **`/quick-cmd`**');
    });

    it('formats markdown when empty', () => {
      const md = formatAgySkillsMarkdown([]);
      expect(md).toContain('No skills available');
    });

    it('formats terminal output with chalk', () => {
      const term = formatAgySkillsTerminal(skills);
      expect(term).toContain('Available Skills');
      expect(term).toContain('/agent-browser');
    });
  });
});
