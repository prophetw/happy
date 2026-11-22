import type { PromptResponse } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { getCodeBuddyPromptResult } from './runCodeBuddy';

function response(stopReason: string, outcome?: string, errorMessage?: string): PromptResponse {
  return {
    stopReason,
    _meta: {
      ...(outcome ? { 'codebuddy.ai/outcome': outcome } : {}),
      ...(errorMessage ? { 'codebuddy.ai/errorMessage': errorMessage } : {}),
    },
  } as PromptResponse;
}

describe('CodeBuddy prompt outcomes', () => {
  it('keeps partial work terminal and identifiable without turning it into an exception', () => {
    expect(getCodeBuddyPromptResult(response('end_turn', 'PARTIAL_SUCCESS'))).toMatchObject({
      status: 'partial', detail: expect.stringContaining('PARTIAL_SUCCESS'),
    });
  });

  it('preserves the provider detail for a partial result', () => {
    const result = getCodeBuddyPromptResult(response('end_turn', 'PARTIAL_SUCCESS', '{"message":"two edits applied; test command failed"}'));
    expect(result).toEqual({
      status: 'partial', detail: 'CodeBuddy partially completed the turn (PARTIAL_SUCCESS): two edits applied; test command failed',
    });
  });

  it('keeps cancellation ahead of a partial outcome', () => {
    expect(getCodeBuddyPromptResult(response('cancelled', 'PARTIAL_SUCCESS'))).toEqual({ status: 'cancelled' });
  });

  it('preserves explicit failures and authentication formatting', () => {
    expect(getCodeBuddyPromptResult(response('end_turn', 'FAILED_MODEL_REQUEST', '401 unauthorized'))).toEqual({
      status: 'failed', detail: 'CodeBuddy authentication is required. Run `codebuddy` and use `/login` on this machine, then try again.',
    });
    expect(getCodeBuddyPromptResult(response('end_turn', 'REFUSED_OR_BLOCKED'))).toEqual({
      status: 'failed', detail: 'CodeBuddy reported REFUSED_OR_BLOCKED.',
    });
  });

  it('preserves permission and non-terminal stop failures', () => {
    expect(getCodeBuddyPromptResult(response('end_turn', 'PERMISSION_DENIED')).status).toBe('failed');
    expect(getCodeBuddyPromptResult(response('max_tokens', 'PARTIAL_SUCCESS')).status).toBe('failed');
  });

  it('keeps ordinary end_turn results successful', () => {
    expect(getCodeBuddyPromptResult(response('end_turn', 'SUCCESS'))).toEqual({ status: 'completed' });
  });
});
