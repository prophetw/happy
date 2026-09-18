import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findDshBin, resolveDshBin } from './constants';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);

describe('resolveDshBin', () => {
  const orig = process.env.HAPPY_DSH_PATH;

  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.alloc(0));
  });

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.HAPPY_DSH_PATH;
    } else {
      process.env.HAPPY_DSH_PATH = orig;
    }
  });

  it('uses HAPPY_DSH_PATH when it points at an existing file', () => {
    // node's own binary is guaranteed to exist on every platform
    process.env.HAPPY_DSH_PATH = process.execPath;
    expect(findDshBin()).toBe(process.execPath);
    expect(resolveDshBin()).toBe(process.execPath);
  });

  it('ignores HAPPY_DSH_PATH when the target does not exist', () => {
    process.env.HAPPY_DSH_PATH = '/nonexistent/path/to/dsh-should-not-resolve';
    expect(resolveDshBin()).not.toBe('/nonexistent/path/to/dsh-should-not-resolve');
  });

  it('hides the PATH probe so detached Windows daemons do not flash a console', () => {
    delete process.env.HAPPY_DSH_PATH;

    findDshBin();

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringMatching(/^(where|command -v) dsh$/),
      { stdio: 'ignore', windowsHide: true },
    );
  });
});
