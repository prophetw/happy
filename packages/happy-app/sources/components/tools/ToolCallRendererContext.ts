import * as React from 'react';
import type { ToolCall, ToolCallMessage } from '@/sync/typesMessage';

/**
 * Optional seam for a conversation host that wants to render selected tool
 * calls its own way. Returning `undefined` keeps the default ToolView, so
 * existing chats render exactly as before without a provider.
 */
export type ToolCallRenderer = (context: { tool: ToolCall; message: ToolCallMessage; sessionId: string }) => React.ReactNode | undefined;

export const ToolCallRendererContext = React.createContext<ToolCallRenderer | null>(null);