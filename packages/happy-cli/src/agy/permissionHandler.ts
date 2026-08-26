/**
 * Agy Permission Handler
 *
 * Handles tool permission requests and responses for Antigravity (agy) sessions.
 * Extends BasePermissionHandler with Agy-specific permission mode logic.
 */

import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import {
  BasePermissionHandler,
  type PermissionResult,
  type PendingRequest,
} from '@/utils/BasePermissionHandler';

// Re-export types for consumers
export type { PermissionResult, PendingRequest };

/**
 * Agy-specific permission handler with permission mode support.
 */
export class AgyPermissionHandler extends BasePermissionHandler {
  private currentPermissionMode: PermissionMode = 'default';

  constructor(session: ApiSessionClient) {
    super(session);
  }

  protected getLogPrefix(): string {
    return '[agy]';
  }

  /**
   * Update session reference (e.g. after session swap / reconnection)
   */
  updateSession(newSession: ApiSessionClient): void {
    super.updateSession(newSession);
  }

  /**
   * Set current permission mode
   */
  setPermissionMode(mode: PermissionMode): void {
    this.currentPermissionMode = mode;
    logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode}`);
  }

  /**
   * Get current permission mode
   */
  getPermissionMode(): PermissionMode {
    return this.currentPermissionMode;
  }

  /**
   * Check if a tool should be auto-approved based on permission mode
   */
  private shouldAutoApprove(toolName: string, toolCallId: string, _input: unknown): boolean {
    const alwaysAutoApproveNames: ReadonlySet<string> = new Set([
      'change_title',
      'happy__change_title',
      'mcp__happy__change_title',
      'AgyReasoning',
      'AntigravityReasoning',
      'GeminiReasoning',
      'think',
      'save_memory',
    ]);

    const alwaysAutoApproveIdPrefixes: readonly string[] = ['change_title', 'save_memory'];

    if (alwaysAutoApproveNames.has(toolName)) {
      return true;
    }

    for (const prefix of alwaysAutoApproveIdPrefixes) {
      if (toolCallId === prefix || toolCallId.startsWith(`${prefix}-`)) {
        return true;
      }
    }

    switch (this.currentPermissionMode) {
      case 'bypassPermissions':
      case 'yolo':
        return true;

      case 'safe-yolo':
      case 'read-only': {
        const dangerousKeywords = [
          'write',
          'edit',
          'create',
          'delete',
          'patch',
          'fs-edit',
          'bash',
          'shell',
          'execute',
          'run_command',
        ];
        const isDangerous = dangerousKeywords.some((keyword) =>
          toolName.toLowerCase().includes(keyword),
        );
        return !isDangerous;
      }

      case 'acceptEdits': {
        const commandKeywords = ['bash', 'shell', 'execute', 'run_command'];
        const isCommand = commandKeywords.some((keyword) =>
          toolName.toLowerCase().includes(keyword),
        );
        return !isCommand;
      }

      case 'default':
      default:
        return false;
    }
  }

  /**
   * Handle a tool permission request
   */
  async handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
  ): Promise<PermissionResult> {
    if (this.shouldAutoApprove(toolName, toolCallId, input)) {
      logger.debug(
        `${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`,
      );

      this.session.updateAgentState((currentState) => ({
        ...currentState,
        completedRequests: {
          ...currentState.completedRequests,
          [toolCallId]: {
            tool: toolName,
            arguments: input,
            createdAt: Date.now(),
            completedAt: Date.now(),
            status: 'approved',
            decision:
              this.currentPermissionMode === 'yolo' ||
              this.currentPermissionMode === 'bypassPermissions'
                ? 'approved_for_session'
                : 'approved',
          },
        },
      }));

      return {
        decision:
          this.currentPermissionMode === 'yolo' ||
          this.currentPermissionMode === 'bypassPermissions'
            ? 'approved_for_session'
            : 'approved',
      };
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, {
        resolve,
        reject,
        toolName,
        input,
      });

      this.addPendingRequestToState(toolCallId, toolName, input);

      logger.debug(
        `${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`,
      );
    });
  }

  /**
   * Mark a tool call as completed in agentState
   */
  completeToolCall(toolCallId: string, toolName: string, input: unknown): void {
    this.session.updateAgentState((currentState) => {
      const { [toolCallId]: pending, ...remainingRequests } = currentState.requests || {};
      const existingCompleted = currentState.completedRequests?.[toolCallId];

      if (!pending && existingCompleted) {
        return currentState;
      }

      return {
        ...currentState,
        requests: remainingRequests,
        completedRequests: {
          ...currentState.completedRequests,
          [toolCallId]: existingCompleted || {
            tool: toolName,
            arguments: input,
            createdAt: pending?.createdAt || Date.now(),
            completedAt: Date.now(),
            status: 'approved',
            decision: 'approved',
          },
        },
      };
    });
  }
}
