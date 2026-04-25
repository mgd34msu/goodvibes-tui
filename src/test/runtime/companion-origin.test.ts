import { describe, expect, test } from 'bun:test';
import { companionMessageToOrchestratorInputOptions } from '../../runtime/bootstrap-core.ts';
import type { CompanionMessagePayload } from '../../runtime/bootstrap-core.ts';

describe('companion message origin routing', () => {
  test('preserves ntfy chat metadata for SDK reply correlation', () => {
    const payload: CompanionMessagePayload = {
      type: 'COMPANION_MESSAGE_RECEIVED',
      sessionId: 'session-1',
      messageId: 'ntfy-message-1',
      body: 'hello',
      source: 'ntfy-chat',
      timestamp: 1_800_000_000_000,
      metadata: {
        surface: 'ntfy',
        topic: 'goodvibes-chat',
        ntfyMessageId: 'ntfy-message-1',
      },
    };

    expect(companionMessageToOrchestratorInputOptions(payload)).toEqual({
      origin: {
        source: 'ntfy-chat',
        surface: 'ntfy',
        messageId: 'ntfy-message-1',
        topic: 'goodvibes-chat',
        metadata: {
          surface: 'ntfy',
          topic: 'goodvibes-chat',
          ntfyMessageId: 'ntfy-message-1',
        },
      },
    });
  });

  test('keeps non-ntfy companion messages correlated by source and message id', () => {
    const payload: CompanionMessagePayload = {
      type: 'COMPANION_MESSAGE_RECEIVED',
      sessionId: 'session-1',
      messageId: 'companion-message-1',
      body: 'status',
      source: 'companion',
      timestamp: 1_800_000_000_000,
    };

    expect(companionMessageToOrchestratorInputOptions(payload)).toEqual({
      origin: {
        source: 'companion',
        messageId: 'companion-message-1',
      },
    });
  });
});
