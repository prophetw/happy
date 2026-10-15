import { describe, expect, it, vi } from 'vitest';
import { deliverCodexUserInput } from './codexUserInput';

function setup() {
    return {
        text: 'Focus on the failing test', mode: {}, attachments: undefined,
        immediately: true, queue: { push: vi.fn(), pushIsolateAndClear: vi.fn() },
        trySteer: vi.fn(async () => true),
    };
}

describe('Codex message delivery', () => {
    it('delivers immediate input to the running turn without also queueing it', async () => {
        const options = setup();
        expect(await deliverCodexUserInput(options)).toBe('steered');
        expect(options.trySteer).toHaveBeenCalledWith('Focus on the failing test', undefined);
        expect(options.queue.push).not.toHaveBeenCalled();
    });

    it('queues ordinary messages and slash commands without steering', async () => {
        const options = setup();
        await deliverCodexUserInput({ ...options, immediately: false });
        await deliverCodexUserInput({ ...options, text: '/clear' });
        expect(options.trySteer).not.toHaveBeenCalled();
        expect(options.queue.push).toHaveBeenCalledOnce();
        expect(options.queue.pushIsolateAndClear).toHaveBeenCalledWith('/clear', {}, undefined);
    });

    it('queues exactly once when the active turn finished before delivery', async () => {
        const options = setup();
        options.trySteer.mockResolvedValue(false);
        expect(await deliverCodexUserInput(options)).toBe('queued');
        expect(options.queue.push).toHaveBeenCalledExactlyOnceWith(options.text, {}, undefined);
    });

    it('does not replay input after an ambiguous transport failure', async () => {
        const options = setup();
        options.trySteer.mockRejectedValue(new Error('connection lost'));
        await expect(deliverCodexUserInput(options)).rejects.toThrow('connection lost');
        expect(options.queue.push).not.toHaveBeenCalled();
    });
});
