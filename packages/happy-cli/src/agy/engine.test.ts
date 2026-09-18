import { describe, expect, it } from 'vitest';
import { DEFAULT_AGY_ENGINE, resolveAgyEngine } from './engine';

describe('resolveAgyEngine', () => {
  it('defaults to stream-json when nothing is set', () => {
    expect(resolveAgyEngine()).toBe('stream-json');
    expect(DEFAULT_AGY_ENGINE).toBe('stream-json');
  });

  it('explicit value wins over env and settings', () => {
    expect(resolveAgyEngine('legacy', 'sdk', 'stream-json')).toBe('legacy');
    expect(resolveAgyEngine('sdk', 'legacy', 'legacy')).toBe('sdk');
  });

  it('env value wins over settings when no explicit value', () => {
    expect(resolveAgyEngine(undefined, 'legacy', 'sdk')).toBe('legacy');
    expect(resolveAgyEngine('', 'sdk', 'legacy')).toBe('sdk');
  });

  it('settings value is used when no explicit value or env', () => {
    expect(resolveAgyEngine(undefined, undefined, 'legacy')).toBe('legacy');
    expect(resolveAgyEngine(undefined, '', 'sdk')).toBe('sdk');
  });

  it('accepts cli as an alias for stream-json', () => {
    expect(resolveAgyEngine('cli')).toBe('stream-json');
    expect(resolveAgyEngine(undefined, 'cli')).toBe('stream-json');
    expect(resolveAgyEngine(undefined, undefined, 'cli')).toBe('stream-json');
  });

  it('falls through on invalid values at each level', () => {
    expect(resolveAgyEngine('bogus', 'legacy', 'sdk')).toBe('legacy');
    expect(resolveAgyEngine('bogus', 'bogus', 'sdk')).toBe('sdk');
    expect(resolveAgyEngine('bogus', 'bogus', 'bogus')).toBe('stream-json');
  });

  it('treats null-like values as unset', () => {
    expect(resolveAgyEngine(null as any, null as any, null as any)).toBe('stream-json');
    expect(resolveAgyEngine('  ', '  ', '  ')).toBe('stream-json');
  });

  it('matches case-insensitively and trims whitespace', () => {
    expect(resolveAgyEngine(' LEGACY ')).toBe('legacy');
    expect(resolveAgyEngine('Stream-JSON')).toBe('stream-json');
    expect(resolveAgyEngine('SDK')).toBe('sdk');
  });
});
