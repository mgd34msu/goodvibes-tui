import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import type { ConversationManager as SdkConversationManager } from '@pellux/goodvibes-sdk/platform/core';
import { prepareConversationForTurn } from '@pellux/goodvibes-sdk/platform/core';

const providerRegistry = {
  getCurrentModel: () => ({
    id: 'mock-model',
    provider: 'mock',
    registryKey: 'mock:mock-model',
    displayName: 'Mock',
    description: '',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
  }),
};

describe('prepareConversationForTurn', () => {
  test('does not inject project mode for long single-task implementation prompts', () => {
    const conversation = new ConversationManager(() => 80);
    prepareConversationForTurn(
      conversation as unknown as SdkConversationManager,
      providerRegistry,
      'Update src/runtime/bootstrap.ts so the session restore path preserves the current provider selection, retains the existing lifecycle hooks, and keeps the shutdown semantics intact. This should be a single focused change in one source area with careful handling of the current bootstrap flow and no architectural planning output.',
      undefined,
      'session-1',
      null,
    );

    const messages = conversation.getMessageSnapshot();
    expect(messages.some((message) => (
      message.role === 'system' && message.content.includes('[Project mode]')
    ))).toBe(false);
  });

  test('injects project mode when the prompt clearly signals multi-step project work', () => {
    const conversation = new ConversationManager(() => 80);
    prepareConversationForTurn(
      conversation as unknown as SdkConversationManager,
      providerRegistry,
      'Design the architecture for a new plugin system. Create the operator contract updates, implement the runtime integration, and add the release-gate coverage. Run the work in phases and keep the execution plan updated as each milestone lands.',
      undefined,
      'session-2',
      null,
    );

    const messages = conversation.getMessageSnapshot();
    expect(messages.some((message) => (
      message.role === 'system' && message.content.includes('[Project mode]')
    ))).toBe(true);
  });
});
