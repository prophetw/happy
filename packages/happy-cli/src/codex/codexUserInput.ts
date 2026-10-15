import type { PendingAttachment } from '@/utils/MessageQueue2';
import { enqueueCodexUserText } from './codexClearCommand';

export async function deliverCodexUserInput<T>(options: {
    text: string;
    mode: T;
    attachments?: PendingAttachment[];
    immediately: boolean;
    queue: Parameters<typeof enqueueCodexUserText<T>>[0]['queue'];
    trySteer: (text: string, attachments?: PendingAttachment[]) => Promise<boolean>;
}): Promise<'steered' | 'queued' | 'clear'> {
    // Slash commands affect the next turn/thread and must retain queue ordering.
    if (options.immediately && !options.text.trim().startsWith('/')) {
        if (await options.trySteer(options.text, options.attachments)) return 'steered';
    }
    return enqueueCodexUserText(options);
}
