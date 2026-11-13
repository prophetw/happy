import { describe, expect, it, vi } from 'vitest';

const appendFileSync = vi.hoisted(() => vi.fn());
vi.mock('fs', () => ({ appendFileSync }));
vi.mock('@/configuration', () => ({ configuration: { logsDir: '/fixture', isDaemonProcess: false } }));

import { logger } from './logger';

describe('task title log redaction', () => {
    it('redacts task titles in spawn environments and session metadata', () => {
        logger.debugLargeJson('fixture', {
            environmentVariables: { HAPPY_TASK_TITLE: 'sensitive task title' },
            happyTask: { displayTitle: 'sensitive task title', origin: { path: '/project' } },
        });

        const output = appendFileSync.mock.calls.map(call => String(call[1])).join('\n');
        expect(output).not.toContain('sensitive task title');
        expect(output).toContain('[REDACTED]');
        expect(output).toContain('/project');
    });
});
