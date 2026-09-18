/**
 * Antigravity (agy) Skills Discovery and Execution
 *
 * agy does not support `/skills` in persistent `--input-format stream-json` mode:
 * the CLI answers `/skills` directly and rejects it when sent over stdin:
 *   "⚠️ /skills is answered by the CLI itself and is unavailable with --input-format stream-json;
 *    run it as its own --print /skills invocation"
 *
 * This module provides:
 * 1. CLI-based skills retrieval: executes `agy --add-dir <cwd> --output-format json --print /skills`
 *    (or plain text fallback `agy --add-dir <cwd> --print /skills`).
 * 2. Rapid filesystem skills discovery for session metadata initialization (<1ms).
 * 3. Markdown and Terminal formatters for surfacing skills in Happy mobile/web/desktop and TTY.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import chalk from 'chalk';
import { resolveAgyBin } from './constants';

export interface AgySkill {
  name: string;
  description: string;
  path?: string;
  plugin?: string;
  builtin?: boolean;
  model_invocable?: boolean;
}

export interface AgySkillsResult {
  skills: AgySkill[];
  source: 'cli-json' | 'cli-text' | 'filesystem';
}

/**
 * Parse YAML frontmatter of a SKILL.md file to extract `name` and `description`.
 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  if (!content || typeof content !== 'string') return {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const lines = match[1].split(/\r?\n/);
  let name: string | undefined;
  const descriptionLines: string[] = [];
  let inDesc = false;

  for (const line of lines) {
    if (!inDesc) {
      const nameMatch = line.match(/^name:\s*(.+)$/);
      if (nameMatch) {
        name = nameMatch[1].trim().replace(/^['"](.*)['"]$/, '$1');
        continue;
      }
      const descMatch = line.match(/^description:\s*(.*)$/);
      if (descMatch) {
        inDesc = true;
        const initial = descMatch[1].trim();
        if (initial && initial !== '>-' && initial !== '|' && initial !== '>') {
          descriptionLines.push(initial.replace(/^['"](.*)['"]$/, '$1'));
        }
        continue;
      }
    } else {
      if (/^[a-zA-Z0-9_-]+:/.test(line)) {
        inDesc = false;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed) {
        descriptionLines.push(trimmed);
      }
    }
  }

  const description = descriptionLines.join(' ').trim();
  return { name, description: description || undefined };
}

/**
 * Parse output from `agy --output-format json --print /skills`.
 */
export function parseAgySkillsJson(raw: string): AgySkill[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    const rawSkills = parsed?.command?.data?.skills ?? parsed?.skills;
    if (Array.isArray(rawSkills)) {
      const results: AgySkill[] = [];
      const seen = new Set<string>();
      for (const s of rawSkills) {
        if (s && typeof s.name === 'string' && !seen.has(s.name)) {
          seen.add(s.name);
          results.push({
            name: s.name,
            description: typeof s.description === 'string' ? s.description : '',
            path: typeof s.path === 'string' ? s.path : undefined,
            plugin: typeof s.plugin === 'string' ? s.plugin : undefined,
            builtin: typeof s.builtin === 'boolean' ? s.builtin : undefined,
            model_invocable: typeof s.model_invocable === 'boolean' ? s.model_invocable : undefined,
          });
        }
      }
      return results;
    }
  } catch {
    // Return empty array on parse failure to permit fallback to text parser
  }
  return [];
}

/**
 * Parse output from `agy --print /skills` (plain text mode).
 */
export function parseAgySkillsText(raw: string): AgySkill[] {
  if (!raw || typeof raw !== 'string') return [];
  const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  const lines = cleaned.split('\n');
  const skills: AgySkill[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.toLowerCase().startsWith('available skills:')) continue;
    if (line.startsWith('Usage:') || line.startsWith('Flags:')) continue;
    if (line.startsWith('Fetching') || /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)) continue;

    // Check tab separated or 2+ consecutive spaces
    const match = line.match(/^(\S+)(?:\t+|\s{2,})(.+)$/);
    if (match) {
      const name = match[1].trim();
      const description = match[2].trim();
      if (!seen.has(name)) {
        seen.add(name);
        skills.push({ name, description });
      }
    } else {
      const name = line.split(/\s+/)[0];
      if (name && !seen.has(name)) {
        seen.add(name);
        skills.push({ name, description: '' });
      }
    }
  }

  return skills;
}

export interface DiscoverAgySkillsFilesystemOptions {
  cwd?: string;
  homeDir?: string;
}

/**
 * Rapid filesystem scan to discover agy skills across workspace, builtins, and plugins.
 * Typically completes in < 1ms, ideal for populating session metadata at startup.
 */
export async function discoverAgySkillsFilesystem(
  opts: DiscoverAgySkillsFilesystemOptions = {},
): Promise<AgySkill[]> {
  const homeDir = opts.homeDir ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const skills: AgySkill[] = [];
  const seen = new Set<string>();

  async function scanSkillFolder(folderPath: string, defaultName: string, prefix = ''): Promise<void> {
    const skillFilePath = join(folderPath, 'SKILL.md');
    try {
      const fileStat = await stat(skillFilePath);
      if (fileStat.isFile()) {
        let content = '';
        try {
          content = await readFile(skillFilePath, 'utf8');
        } catch {
          // ignore read error
        }
        const frontmatter = parseSkillFrontmatter(content);
        const baseName = frontmatter.name || defaultName;
        const fullName = prefix ? `${prefix}:${baseName}` : baseName;

        if (!seen.has(fullName)) {
          seen.add(fullName);
          skills.push({
            name: fullName,
            description: frontmatter.description || '',
            path: skillFilePath,
          });
        }
      }
    } catch {
      // not a skill file
    }
  }

  async function scanDirForSkillFolders(dir: string, prefix = ''): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await scanSkillFolder(join(dir, entry.name), entry.name, prefix);
        }
      }
    } catch {
      // ignore missing directories
    }
  }

  // 1. Workspace skills: .agents/skills and .agent/skills in cwd
  await scanDirForSkillFolders(join(cwd, '.agents', 'skills'));
  await scanDirForSkillFolders(join(cwd, '.agent', 'skills'));

  // 2. Builtin skills
  const builtinDir = join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'skills');
  await scanDirForSkillFolders(builtinDir);

  // 3. Plugin skills: ~/.gemini/config/plugins/<pluginName>/skills/<skillFolder>/SKILL.md
  const pluginsDir = join(homeDir, '.gemini', 'config', 'plugins');
  try {
    const pluginEntries = await readdir(pluginsDir, { withFileTypes: true });
    for (const pluginEntry of pluginEntries) {
      if (pluginEntry.isDirectory()) {
        const pluginSkillsDir = join(pluginsDir, pluginEntry.name, 'skills');
        await scanDirForSkillFolders(pluginSkillsDir, pluginEntry.name);
      }
    }
  } catch {
    // ignore missing plugins dir
  }

  // 4. Global user skills: ~/.gemini/skills and ~/.gemini/config/skills
  await scanDirForSkillFolders(join(homeDir, '.gemini', 'skills'));
  await scanDirForSkillFolders(join(homeDir, '.gemini', 'config', 'skills'));

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extract sorted unique slash command names (without leading slash).
 */
export function getAgySkillCommandNames(skills: AgySkill[]): string[] {
  const set = new Set<string>();
  for (const skill of skills) {
    if (skill.name) {
      set.add(skill.name);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export type ExecFileFn = typeof execFile;

export interface FetchAgySkillsOptions {
  cwd?: string;
  bin?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
  execFileFn?: ExecFileFn;
  homeDir?: string;
}

/**
 * Fetch skills by running agy print mode directly (`agy --print /skills`),
 * falling back to text parsing, then local filesystem discovery.
 */
export async function fetchAgySkills(
  opts: FetchAgySkillsOptions = {},
): Promise<AgySkillsResult> {
  const cwd = opts.cwd ?? process.cwd();
  const bin = opts.bin ?? resolveAgyBin();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const log = opts.log ?? (() => {});
  const execFileFn = opts.execFileFn ?? execFile;

  // 1. Run `agy --add-dir <cwd> --output-format json --print /skills`
  try {
    const jsonOutput = await new Promise<string>((resolve, reject) => {
      execFileFn(
        bin,
        ['--add-dir', cwd, '--output-format', 'json', '--print', '/skills'],
        {
          cwd,
          timeout: timeoutMs,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            reject(error);
          } else {
            resolve(stdout);
          }
        },
      );
    });

    const parsedJson = parseAgySkillsJson(jsonOutput);
    if (parsedJson.length > 0) {
      log(`Fetched ${parsedJson.length} skills via agy JSON print`);
      return { skills: parsedJson, source: 'cli-json' };
    }
  } catch (err) {
    log(`Failed to fetch agy skills via JSON (${err instanceof Error ? err.message : String(err)}); falling back to text`);
  }

  // 2. Fallback: run `agy --add-dir <cwd> --print /skills` (plain text)
  try {
    const textOutput = await new Promise<string>((resolve, reject) => {
      execFileFn(
        bin,
        ['--add-dir', cwd, '--print', '/skills'],
        {
          cwd,
          timeout: timeoutMs,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            reject(error);
          } else {
            resolve(stdout);
          }
        },
      );
    });

    const parsedText = parseAgySkillsText(textOutput);
    if (parsedText.length > 0) {
      log(`Fetched ${parsedText.length} skills via agy text print`);
      return { skills: parsedText, source: 'cli-text' };
    }
  } catch (err) {
    log(`Failed to fetch agy skills via text print (${err instanceof Error ? err.message : String(err)}); falling back to filesystem`);
  }

  // 3. Fallback: discover from local filesystem
  const fsSkills = await discoverAgySkillsFilesystem({ cwd, homeDir: opts.homeDir });
  log(`Discovered ${fsSkills.length} skills from filesystem`);
  return { skills: fsSkills, source: 'filesystem' };
}

/**
 * Format skills list into Markdown for ACP session envelope / web / mobile clients.
 */
export function formatAgySkillsMarkdown(result: AgySkillsResult | AgySkill[]): string {
  const skills = Array.isArray(result) ? result : result.skills;
  if (!skills || skills.length === 0) {
    return 'No skills available. Session may still be initializing — try again after sending a message.';
  }

  const lines: string[] = ['### 🛠️ Available Skills', ''];
  for (const skill of skills) {
    if (skill.description) {
      lines.push(`- **\`/${skill.name}\`** — ${skill.description}`);
    } else {
      lines.push(`- **\`/${skill.name}\`**`);
    }
  }
  return lines.join('\n');
}

/**
 * Format skills list into colored terminal string for TTY MessageBuffer.
 */
export function formatAgySkillsTerminal(result: AgySkillsResult | AgySkill[]): string {
  const skills = Array.isArray(result) ? result : result.skills;
  if (!skills || skills.length === 0) {
    return chalk.yellow('No skills available.');
  }

  const lines: string[] = [chalk.bold.cyan('🛠️ Available Skills:'), ''];
  for (const skill of skills) {
    const cmd = chalk.bold.green(`/${skill.name}`);
    if (skill.description) {
      lines.push(`  ${cmd} ${chalk.dim('—')} ${chalk.gray(skill.description)}`);
    } else {
      lines.push(`  ${cmd}`);
    }
  }
  return lines.join('\n');
}
