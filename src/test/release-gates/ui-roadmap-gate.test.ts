import { describe, expect, test } from 'bun:test';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { DEFAULT_CONFIG } from '@pellux/goodvibes-sdk/platform/config';
import { ConversationManager } from '../../core/conversation';
import type { CommandContext } from '../../input/command-registry.ts';
import { GLYPHS } from '../../renderer/ui-primitives.ts';
import { modalGeometry, standardModalWidth } from '../../renderer/surface-kit.ts';
import { wireShellUiOpeners } from '../../shell/ui-openers.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { makeTestShellViews } from '../helpers/shell-views.ts';

describe('UI roadmap gate', () => {
  test('locks the canonical Unicode primitive set', () => {
    expect(GLYPHS.frame.vertical).toBe('│');
    expect(GLYPHS.surface.top).toBe('▄');
    expect(GLYPHS.surface.bottom).toBe('▀');
    expect(GLYPHS.surface.cursor).toBe('█');
    expect(GLYPHS.navigation.collapsed).toBe('▸');
    expect(GLYPHS.navigation.expanded).toBe('▾');
    expect(GLYPHS.status.success).toBe('✓');
    expect(GLYPHS.status.pending).toBe('•');
  });

  test('keeps non-conversational routing defaults out of the main transcript', () => {
    expect(DEFAULT_CONFIG.ui.systemMessages).toBe('panel');
    expect(DEFAULT_CONFIG.ui.operationalMessages).toBe('panel');
    expect(DEFAULT_CONFIG.ui.wrfcMessages).toBe('both');
  });

  test('supports line-accurate conversation navigation by transcript event family', () => {
    const conversation = new ConversationManager(() => 100);
    conversation.addUserMessage('review the file');
    conversation.addAssistantMessage('Running checks.', {
      toolCalls: [{ id: 'call-1', name: 'exec', arguments: { command: 'git diff --stat' } }],
      model: 'gpt-5.4',
      provider: 'openai',
    });
    conversation.addToolResults([{ callId: 'call-1', success: true, output: '1 file changed' }]);
    conversation.addSystemMessage('[Approval] Waiting for operator input');

    const toolLine = conversation.nextTranscriptEventLine(0, 'tool_result');
    expect(toolLine).toBeGreaterThanOrEqual(0);
    expect(conversation.prevTranscriptEventLine(999, 'tool_result')).toBe(toolLine);
  });

  test('opens views through the shared shell opener path: an old view name lands on its modal, focus stays in the composer', () => {
    const testManagers = createTestManagers();
    const surfaceModals = new SurfaceModalHost();
    const input = {
      indicatorFocused: false,
      modalOpened: () => {},
      modelPicker: {} as never,
      openSelection: () => {},
      contextInspectorModal: { open: () => {} },
      bookmarkModal: { open: () => {} },
      helpOverlayActive: false,
      helpScrollOffset: 0,
      shortcutsOverlayActive: false,
      shortcutsScrollOffset: 0,
      profilePickerModal: { open: () => {} },
      settingsModal: { open: () => {} },
      sessionPickerModal: { open: () => {} },
      surfaceModals,
    } as unknown as Parameters<typeof wireShellUiOpeners>[0]['input'];
    const commandContext = { print: () => {} } as unknown as CommandContext;

    wireShellUiOpeners({
      commandContext,
      input,
      ...makeTestShellViews({ configManager: testManagers.configManager }),
      configManager: testManagers.configManager,
      providerRegistry: { getSelectableModels: () => [], listModels: () => [] } as never,
      runtime: { model: 'gpt-5.4', provider: 'openai' } as never,
      featureFlags: {} as never,
      mcpRegistry: {} as never,
      subscriptionManager: testManagers.subscriptionManager,
      serviceRegistry: testManagers.serviceRegistry,
      memoryEmbeddingRegistry: {} as never,
      workingDirectory: process.cwd(),
      homeDirectory: process.env.HOME ?? process.cwd(),
      getConfiguredProviderIds: () => [],
      getPinned: async () => [],
      render: () => {},
      trustPromptRef: { requestTrustDecision: async () => 'restricted' as const },
    });

    expect(commandContext.openView?.('fleet')).toBe(true);
    expect(surfaceModals.top()?.name).toBe('agents');
    expect(commandContext.openView?.('tokens')).toBe(true);
    expect(surfaceModals.top()?.name).toBe('usage');
    // The agents modal is still on the stack under usage; opening it again brings it back to the top.
    commandContext.openAgents?.();
    expect(surfaceModals.top()?.name).toBe('agents');
    expect(surfaceModals.depth).toBe(2);
    expect((input as unknown as { indicatorFocused: boolean }).indicatorFocused).toBe(false);
    surfaceModals.clear();
  });

  test('sizes every modal by the Measurements table: 86% wide (max 124), full width minus 1 per side below 90, top edge at 8%', () => {
    expect(standardModalWidth(70)).toBe(68);
    expect(standardModalWidth(89)).toBe(87);
    expect(standardModalWidth(100)).toBe(86);
    expect(standardModalWidth(200)).toBe(124);
    expect(modalGeometry(100, 24).y).toBe(2);
    expect(modalGeometry(100, 50).y).toBe(4);
  });
});
