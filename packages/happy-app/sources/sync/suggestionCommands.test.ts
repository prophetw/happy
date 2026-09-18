import { describe, it, expect, vi } from 'vitest';

vi.mock('./storage', () => {
  let state = {
    sessions: {
      'test-session': {
        id: 'test-session',
        metadata: {
          slashCommands: ['custom-cmd'],
        },
      },
    },
  };
  return {
    storage: {
      getState: () => state,
      setState: (newState: any) => {
        state = { ...state, ...newState };
      },
    },
  };
});

import { getAllCommands, searchCommands } from './suggestionCommands';

describe('suggestionCommands', () => {
  it('includes default commands including usage', () => {
    const commands = getAllCommands('test-session');
    const commandNames = commands.map((c) => c.command);
    expect(commandNames).toContain('usage');
    expect(commandNames).toContain('compact');
    expect(commandNames).toContain('clear');
    expect(commandNames).toContain('custom-cmd');

    const usageCmd = commands.find((c) => c.command === 'usage');
    expect(usageCmd?.description).toBe('Show remaining quota and rate limits');
  });

  it('searches for usage command', async () => {
    const results = await searchCommands('test-session', 'usag');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].command).toBe('usage');
  });
});
