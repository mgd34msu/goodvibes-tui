import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import { BlockActionsMenu } from '../../renderer/block-actions.ts';

// ─── H8: Apply diff ───────────────────────────────────────────────────────────
describe('H8 — getDiffAtLine', () => {
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

// ─── H9: Block actions menu ───────────────────────────────────────────────────
describe('H9 — BlockActionsMenu', () => {
  test('opens with correct actions for tool block', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 5, rawContent: 'result', collapseKey: 'k0' });
    expect(menu.active).toBe(true);
    const ids = menu.actions.map(a => a.id);
    expect(ids).toContain('copy');
    expect(ids).toContain('bookmark');
    expect(ids).toContain('toggle');
    expect(ids).toContain('rerun');
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

  test('getActionForKey returns correct action', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 5, rawContent: 'result', collapseKey: 'k0' });
    expect(menu.getActionForKey('c')?.id).toBe('copy');
    expect(menu.getActionForKey('b')?.id).toBe('bookmark');
    expect(menu.getActionForKey('r')?.id).toBe('rerun');
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

// ─── H10: Code block collapse ─────────────────────────────────────────────────
describe('H10 — code block collapse', () => {
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
    // Simulate config that shows thinking
    // Force thinking display by patching — just check thinking block registers via direct addAssistantMessage with reasoningContent
    cm2.addUserMessage('think');
    // addAssistantMessage signature supports opts
    (cm2 as any).messages.push({ role: 'assistant', content: 'done', reasoningContent: bigThinking });
    (cm2 as any).dirty = true;
    (cm2 as any).configManager = { get: (k: string) => k === 'display.showThinking' ? true : (k === 'display.collapseThreshold' ? 30 : false) };
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

// ─── H11: Error navigation ────────────────────────────────────────────────────
describe('H11 — getErrorLines', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('returns empty when no error messages', () => {
    cm.addUserMessage('hello');
    cm.addAssistantMessage('hi');
    cm.getDisplayBlocks();
    expect(cm.getErrorLines()).toHaveLength(0);
  });

  test('returns line indices for system error messages', () => {
    cm.addUserMessage('run tool');
    cm.addSystemMessage('Error: command not found');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    expect(lines.length).toBeGreaterThan(0);
  });

  test('detects multiple error messages', () => {
    cm.addUserMessage('start');
    cm.addSystemMessage('Error: first failure');
    cm.addUserMessage('retry');
    cm.addSystemMessage('Error: second failure');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    expect(lines.length).toBe(2);
  });

  test('is case-insensitive for error detection', () => {
    cm.addUserMessage('run');
    cm.addSystemMessage('error: lowercase error');
    cm.addUserMessage('run2');
    cm.addSystemMessage('WARNING: some error occurred');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    expect(lines.length).toBe(2);
  });
});
