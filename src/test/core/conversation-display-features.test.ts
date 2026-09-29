import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation';
import { isNavigableSystemMessage } from '../../core/conversation-rendering.ts';
import type { SystemMessageKind } from '@/runtime/index.ts';

type ConversationManagerTestAccess = {
  messages: Array<{ role: string; content: string; reasoningContent?: string }>;
  dirty: boolean;
  _configManager: {
    get(key: string): unknown;
  };
};
import { BlockActionsMenu } from '../../renderer/block-actions.ts';

describe('ConversationManager.getDiffAtLine', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('returns null when no diff block registered', () => {
    cm.addUserMessage('hello');
    cm.getDisplayBlocks();
    expect(cm.getDiffAtLine(0)).toBeNull();
  });

  test('returns diff metadata for a diff block', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1 @@',
      '-const x = 1;',
      '+const x = 42;',
    ].join('\n');
    cm.addUserMessage('apply this');
    cm.addToolResults([{ callId: 'c1', success: true, output: diff }]);
    cm.getDisplayBlocks();

    const result = cm.getDiffAtLine(0);
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('src/foo.ts');
    expect(result!.original).toContain('const x = 1;');
    expect(result!.updated).toContain('const x = 42;');
  });
});

describe('tool result rendering', () => {
  test('renders the human-readable tool name instead of only the opaque call id when available', () => {
    const cm = new ConversationManager(() => 80);
    const callId = 'chatcmpl-tool-b697f24c7516250';
    cm.addAssistantMessage('Running web search.', {
      toolCalls: [{ id: callId, name: 'web_search', arguments: { query: 'dllm language model' } }],
    });
    cm.addToolResults([{ callId, success: true, output: '1 line' }]);

    const text = cm.getDisplayBlocks()
      .map((line) => line.map((cell) => cell.char).join(''))
      .join('\n');

    // The human-readable name now lives once, on the CALL row that owns the
    // result, instead of being repeated on the result row underneath it. The
    // guarantee this test exists for is unchanged: the transcript names the
    // tool in words and never falls back to the opaque call id.
    expect(text).toContain('web_search');
    expect(text).not.toContain(callId);
    // The result still declares its own size, which is what makes it
    // discoverable as expandable.
    expect(text).toMatch(/\d+ lines?/);
  });
});

describe('BlockActionsMenu', () => {
  test('opens with correct actions for tool block', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 5, rawContent: 'result', collapseKey: 'k0' });
    expect(menu.active).toBe(true);
    const ids = menu.actions.map(a => a.id);
    expect(ids).toContain('copy');
    expect(ids).toContain('bookmark');
    expect(ids).toContain('toggle');
    // 'rerun' was a dead action, always listed but never actually did
    // anything (handleBlockRerun only called requestRender()). Removed
    // rather than kept as a lie.
    expect(ids).not.toContain('rerun');
    expect(ids).not.toContain('apply');
  });

  test('shows apply action only for diff blocks', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'diff', startLine: 0, lineCount: 5, rawContent: 'diff', collapseKey: 'k0' });
    const ids = menu.actions.map(a => a.id);
    expect(ids).toContain('apply');
    expect(ids).not.toContain('rerun');
  });

  test('shows all base actions for code blocks', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'code', startLine: 0, lineCount: 5, rawContent: 'code', collapseKey: 'k0' });
    const ids = menu.actions.map(a => a.id);
    expect(ids).toContain('copy');
    expect(ids).toContain('bookmark');
    expect(ids).toContain('toggle');
    expect(ids).not.toContain('apply');
    expect(ids).not.toContain('rerun');
  });

  test('getActionForKey returns correct action, and no key resolves to the removed rerun action', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 5, rawContent: 'result', collapseKey: 'k0' });
    expect(menu.getActionForKey('c')?.id).toBe('copy');
    expect(menu.getActionForKey('b')?.id).toBe('bookmark');
    expect(menu.getActionForKey('r')).toBeNull();
    expect(menu.getActionForKey('x')).toBeNull();
  });

  test('close resets state', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 5, rawContent: 'result', collapseKey: 'k0' });
    menu.close();
    expect(menu.active).toBe(false);
    expect(menu.block).toBeNull();
    expect(menu.actions).toHaveLength(0);
  });

  test('moveUp/moveDown wrap correctly', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 5, rawContent: 'r', collapseKey: 'k0' });
    menu.selectedIndex = 0;
    menu.moveUp(); // should wrap to last
    expect(menu.selectedIndex).toBe(menu.actions.length - 1);
    menu.moveDown(); // should wrap back to 0
    expect(menu.selectedIndex).toBe(0);
  });
});

describe('code block collapse', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('code blocks over threshold are registered and auto-collapsed', () => {
    const codeLines = Array.from({ length: 35 }, (_, i) => `  line${i + 1};`).join('\n');
    cm.addUserMessage('look at this');
    cm.addAssistantMessage('Here:\n```ts\n' + codeLines + '\n```');
    cm.getDisplayBlocks();

    const registry = cm.getBlockRegistry();
    const codeBlock = registry.find(b => b.type === 'code');
    expect(codeBlock).toBeDefined();
    // Auto-collapsed when over threshold
    expect(cm.isCollapsed(codeBlock!.blockIndex)).toBe(true);
  });

  test('short code blocks are registered but not auto-collapsed', () => {
    cm.addUserMessage('look at this');
    cm.addAssistantMessage('Here:\n```ts\nconst x = 1;\n```');
    cm.getDisplayBlocks();

    const registry = cm.getBlockRegistry();
    const codeBlock = registry.find(b => b.type === 'code');
    expect(codeBlock).toBeDefined();
    expect(cm.isCollapsed(codeBlock!.blockIndex)).toBe(false);
  });

  test('thinking blocks are registered', () => {
    const bigThinking = Array.from({ length: 35 }, (_, i) => `thought ${i}`).join('\n');
    const cm2 = new ConversationManager(() => 80);
    const testAccess = cm2 as unknown as ConversationManagerTestAccess;
    // Simulate config that shows thinking
    // Force thinking display by patching, just check thinking block registers via direct addAssistantMessage with reasoningContent
    cm2.addUserMessage('think');
    // addAssistantMessage signature supports opts
    testAccess.messages.push({ role: 'assistant', content: 'done', reasoningContent: bigThinking });
    testAccess.dirty = true;
    testAccess._configManager = {
      get: (k: string) => k === 'display.showThinking'
        ? true
        : (k === 'display.collapseThreshold' ? 30 : false),
    };
    cm2.getDisplayBlocks();

    const registry = cm2.getBlockRegistry();
    const thinkingBlock = registry.find(b => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
  });

  test('toggleCollapseAtLine works for code blocks', () => {
    const codeLines = Array.from({ length: 35 }, (_, i) => `  line${i + 1};`).join('\n');
    cm.addUserMessage('look at this');
    cm.addAssistantMessage('Here:\n```ts\n' + codeLines + '\n```');
    cm.getDisplayBlocks();

    const registry = cm.getBlockRegistry();
    const codeBlock = registry.find(b => b.type === 'code');
    expect(codeBlock).toBeDefined();

    // Toggle: collapse → expand
    cm.toggleCollapseAtLine(codeBlock!.startLine);
    expect(cm.isCollapsed(codeBlock!.blockIndex)).toBe(false);

    // Toggle again: expand → collapse
    cm.toggleCollapseAtLine(codeBlock!.startLine);
    expect(cm.isCollapsed(codeBlock!.blockIndex)).toBe(true);
  });
});

describe('ConversationManager.getErrorLines: notices leave the transcript', () => {
  // System notices are toasts and notification-history entries (core/notices.ts,
  // ui-live-run-5 item 9), so the main transcript draws no row for them and
  // error navigation has nothing of theirs to land on. The kind rule itself
  // still decides navigability where notices are drawn (an agent view).
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('a notice of any kind registers no transcript error line', () => {
    cm.addUserMessage('run tool');
    cm.addSystemMessage('request failed: timeout');
    cm.addTypedSystemMessage('rate limited: 429 Too Many Requests', 'system');
    cm.addTypedSystemMessage('[WRFC] Chain wrfc-1 FAILED: gates red', 'wrfc');
    cm.addTypedSystemMessage('[Tool] edit error: file not found', 'operational');
    cm.getDisplayBlocks();
    expect(cm.getErrorLines()).toHaveLength(0);
  });

  test('the kind rule: system and wrfc kinds are navigable, operational is not, unknown defaults to system', () => {
    const registry = new Map<number, SystemMessageKind>([[0, 'system'], [1, 'wrfc'], [2, 'operational']]);
    const context = { messageKindRegistry: registry };
    expect(isNavigableSystemMessage(context, 0)).toBe(true);
    expect(isNavigableSystemMessage(context, 1)).toBe(true);
    expect(isNavigableSystemMessage(context, 2)).toBe(false);
    expect(isNavigableSystemMessage(context, 3)).toBe(true);
  });
});

