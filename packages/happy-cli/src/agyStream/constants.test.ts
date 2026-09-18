import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AGY_EFFORTS, DEFAULT_AGY_EFFORT, findAgyBin, normalizeAgyEffort, resolveAgyBin } from './constants';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);

describe('resolveAgyBin', () => {
  const orig = process.env.HAPPY_AGY_PATH;

  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.alloc(0));
  });

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.HAPPY_AGY_PATH;
    } else {
      process.env.HAPPY_AGY_PATH = orig;
    }
  });

  it('uses HAPPY_AGY_PATH when it points at an existing file', () => {
    // node's own binary is guaranteed to exist on every platform
    process.env.HAPPY_AGY_PATH = process.execPath;
    expect(findAgyBin()).toBe(process.execPath);
    expect(resolveAgyBin()).toBe(process.execPath);
  });

  it('ignores HAPPY_AGY_PATH when the target does not exist', () => {
    process.env.HAPPY_AGY_PATH = '/nonexistent/path/to/agy-should-not-resolve';
    expect(resolveAgyBin()).not.toBe('/nonexistent/path/to/agy-should-not-resolve');
  });

  it('hides the PATH probe so detached Windows daemons do not flash a console', () => {
    delete process.env.HAPPY_AGY_PATH;

    findAgyBin();

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringMatching(/^(where|command -v) agy$/),
      { stdio: 'ignore', windowsHide: true },
    );
  });
});

describe('normalizeAgyEffort', () => {
  it('accepts the known effort levels', () => {
    for (const effort of AGY_EFFORTS) {
      expect(normalizeAgyEffort(effort)).toBe(effort);
    }
  });

  it('falls back to the default effort for null, undefined, and unknown values', () => {
    expect(normalizeAgyEffort(null)).toBe(DEFAULT_AGY_EFFORT);
    expect(normalizeAgyEffort(undefined)).toBe(DEFAULT_AGY_EFFORT);
    expect(normalizeAgyEffort('ultra')).toBe(DEFAULT_AGY_EFFORT);
    expect(normalizeAgyEffort('')).toBe(DEFAULT_AGY_EFFORT);
  });
});
