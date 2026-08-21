import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '@pellux/goodvibes-sdk/platform/config';
import { ConversationManager } from '../../core/conversation';
import type { CommandContext } from '../../input/command-registry.ts';
import { GLYPHS } from '../../renderer/ui-primitives.ts';
import { getOverlayWidthClass } from '../../renderer/overlay-viewport.ts';
import { wireShellUiOpeners } from '../../shell/ui-openers.ts';
import { createTestManagers } from '../helpers/test-managers.ts';

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

  // item 1a: showPanel is the command path (every registered caller is a
  // slash command), it now opens/shows the panel but leaves keyboard focus
  // in the composer by default ("the user is mid-command-flow"). A chord
  // (F2/Ctrl+O/Ctrl+P/Alt+N) still grabs focus via panelManager.focusPanels()
  // directly, unaffected by this test.
  test('opens and shows panels through the shared shell opener path, leaving composer focus untouched by default', () => {
    const testManagers = createTestManagers();
    const input = {
      panelFocused: false,
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
    } as unknown as Parameters<typeof wireShellUiOpeners>[0]['input'];
    let visible = false;
    let focused = false;
    const panelManager = {
      isVisible: () => visible,
      getAllOpen: () => ['docs'],
      getFocusTarget: () => (focused ? 'panel' : 'prompt') as 'panel' | 'prompt',
      open: () => {},
      show: () => { visible = true; },
      hide: () => { visible = false; focused = false; },
      focusPanels: () => { focused = true; },
      focusPrompt: () => { focused = false; },
      setOpenModalCallback: () => {},
    };
    const conversation = {
      setSplashSuppressed: () => {},
      rebuildHistory: () => {},
    } as never;
    const commandContext = {} as CommandContext;

    wireShellUiOpeners({
      commandContext,
      input,
      panelManager: panelManager as unknown as Parameters<typeof wireShellUiOpeners>[0]['panelManager'],
      conversation,
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

    (commandContext as { showPanel?: (panelId: string, pane?: 'top' | 'bottom') => void }).showPanel?.('docs');
    // the command path no longer auto-focuses (focus stays wherever it
    // already was, the composer, since you can only type a command there).
    expect(panelManager.getFocusTarget()).toBe('prompt');
    expect(visible).toBe(true);

    // The escape hatch: a caller that explicitly asks for focus still gets it.
    // Reconciled signature (panelId, pane, target, opts), focus opt-in is arg 4.
    (commandContext as { showPanel?: (panelId: string, pane?: 'top' | 'bottom', target?: unknown, opts?: { focus?: boolean }) => void })
      .showPanel?.('docs', undefined, undefined, { focus: true });
    expect(panelManager.getFocusTarget()).toBe('panel');
  });

  test('keeps overlays on shared width bands for narrow, medium, and wide terminals', () => {
    expect(getOverlayWidthClass(70)).toBe('narrow');
    expect(getOverlayWidthClass(100)).toBe('medium');
    expect(getOverlayWidthClass(140)).toBe('wide');
  });
});
