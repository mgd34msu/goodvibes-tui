import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation';

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
    // 'rerun' was a dead action — always listed but never actually did
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
    // Force thinking display by patching — just check thinking block registers via direct addAssistantMessage with reasoningContent
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

describe('ConversationManager.getErrorLines — kind-based navigation', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('returns empty when no system messages', () => {
    cm.addUserMessage('hello');
    cm.addAssistantMessage('hi');
    cm.getDisplayBlocks();
    expect(cm.getErrorLines()).toHaveLength(0);
  });

  test('addSystemMessage (bare, no kind) is navigable — defaults to system kind', () => {
    cm.addUserMessage('run tool');
    cm.addSystemMessage('request failed: timeout');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    // 'system' kind is navigable even without the word "error" in the text
    expect(lines.length).toBeGreaterThan(0);
  });

  test('failure-kind message without the word "error" IS navigable', () => {
    cm.addUserMessage('run');
    // Use addTypedSystemMessage with 'system' kind — simulates a failure message
    // that never contains the word "error" (e.g. "rate limited", "request failed")
    cm.addTypedSystemMessage('rate limited: 429 Too Many Requests', 'system');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    expect(lines.length).toBe(1);
  });

  test('operational-kind message containing the word "error" is NOT navigable', () => {
    cm.addUserMessage('run');
    // [Tool] prefix → 'operational' kind → NOT navigable
    cm.addTypedSystemMessage('[Tool] edit error: file not found', 'operational');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    // Operational messages are excluded from navigation regardless of text content
    expect(lines.length).toBe(0);
  });

  test('wrfc-kind message IS navigable', () => {
    cm.addUserMessage('run');
    cm.addTypedSystemMessage('[WRFC] Chain abc123 failed', 'wrfc');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    expect(lines.length).toBe(1);
  });

  test('multiple messages: only navigable kinds register', () => {
    cm.addUserMessage('start');
    cm.addTypedSystemMessage('request failed', 'system');          // navigable
    cm.addTypedSystemMessage('[Scan] found 3 providers', 'operational'); // NOT navigable
    cm.addTypedSystemMessage('[WRFC] Chain done', 'wrfc');          // navigable
    cm.addTypedSystemMessage('[Tool] edit applied', 'operational'); // NOT navigable
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    expect(lines.length).toBe(2);
  });

  test('nextErrorLine wraps around correctly', () => {
    cm.addUserMessage('start');
    cm.addTypedSystemMessage('first failure', 'system');
    cm.addTypedSystemMessage('second failure', 'system');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    expect(lines.length).toBe(2);
    const [first, second] = lines as [number, number];

    // After last error, wraps to first
    expect(cm.nextErrorLine(second)).toBe(first);
    // Before first error, goes to first
    expect(cm.nextErrorLine(first - 1)).toBe(first);
  });

  test('prevErrorLine wraps around correctly', () => {
    cm.addUserMessage('start');
    cm.addTypedSystemMessage('first failure', 'system');
    cm.addTypedSystemMessage('second failure', 'system');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    const [first, second] = lines as [number, number];

    // Before first error, wraps to last
    expect(cm.prevErrorLine(first)).toBe(second);
    // After second error, goes to second
    expect(cm.prevErrorLine(second + 1)).toBe(second);
  });

  test('returns -1 when there are no navigable messages', () => {
    cm.addUserMessage('run');
    cm.addTypedSystemMessage('[Scan] provider discovered', 'operational');
    cm.getDisplayBlocks();

    expect(cm.nextErrorLine(0)).toBe(-1);
    expect(cm.prevErrorLine(0)).toBe(-1);
  });

  test('kind registry survives a width-change rebuild', () => {
    const getWidth = { value: 80 };
    const cm2 = new ConversationManager(() => getWidth.value);
    cm2.addUserMessage('start');
    cm2.addTypedSystemMessage('[Scan] noisy operational', 'operational'); // NOT navigable
    cm2.addTypedSystemMessage('actual failure', 'system'); // navigable
    cm2.getDisplayBlocks();

    const linesBefore = cm2.getErrorLines();
    expect(linesBefore.length).toBe(1);

    // Simulate width change — triggers rebuildHistory
    getWidth.value = 100;
    cm2.getDisplayBlocks();

    const linesAfter = cm2.getErrorLines();
    // Still exactly 1 navigable line after rebuild
    expect(linesAfter.length).toBe(1);
  });

  test('operational-kind messages added after clearDisplay() are NOT navigable', () => {
    // Regression: messageKindRegistry uses absolute indices; appendConversationMessages
    // loops with a slice-relative counter. Without the msgIndexOffset fix, a message
    // stored at absolute index N would be read at slice-relative index N - displayStart,
    // missing the registry lookup and falling back to navigable.
    cm.addUserMessage('before clear');
    cm.getDisplayBlocks();
    cm.clearDisplay();

    // Post-clear messages: these start at displayStart > 0 in the full snapshot
    cm.addTypedSystemMessage('[Scan] provider discovered', 'operational'); // NOT navigable
    cm.addTypedSystemMessage('request failed', 'system');                  // navigable
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    // Only the 'system' kind message should be navigable
    expect(lines.length).toBe(1);
  });

  test('wrfc-kind messages added after clearDisplay() remain navigable', () => {
    cm.addUserMessage('before clear');
    cm.getDisplayBlocks();
    cm.clearDisplay();

    cm.addTypedSystemMessage('[WRFC] Chain abc failed', 'wrfc');           // navigable
    cm.addTypedSystemMessage('[Tool] edit applied ok', 'operational');     // NOT navigable
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    expect(lines.length).toBe(1);
  });

  test('undo + bare addSystemMessage: stale operational kind cleared, bare add is navigable', () => {
    // Regression for registry desync via undo + bare addSystemMessage:
    // 1. Add a typed operational message at index N → registry has N → 'operational'
    // 2. undo() splices the tail → index N is freed
    // 3. bare addSystemMessage appends a new message at the same index N
    // Without the fix, the stale 'operational' entry would suppress navigation
    // (false negative). With the fix, both undo() and addSystemMessage clear stale
    // entries, so the bare add has no registry entry → defaults to 'system' → navigable.
    cm.addUserMessage('turn 1');
    cm.addTypedSystemMessage('[Scan] noisy operational info', 'operational');
    cm.getDisplayBlocks();

    // Undo frees the tail (user message + operational system message)
    cm.undo();

    // Bare addSystemMessage lands at the recycled index
    cm.addUserMessage('turn 2');
    cm.addSystemMessage('request failed: connection refused');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    // The bare add has no kind → renderer defaults to 'system' → navigable.
    // A stale 'operational' entry would produce length 0 (the bug).
    expect(lines.length).toBeGreaterThan(0);
  });

  test('undo + bare addSystemMessage: stale navigable kind cleared, bare add still navigable', () => {
    // Reverse case: stale 'wrfc' kind at a recycled index.
    // After undo clears the registry, bare addSystemMessage has no kind →
    // defaults to 'system' → still navigable. No false positive or miss.
    cm.addUserMessage('turn 1');
    cm.addTypedSystemMessage('[WRFC] chain failed', 'wrfc');
    cm.getDisplayBlocks();

    cm.undo();

    cm.addUserMessage('turn 2');
    cm.addSystemMessage('follow-up system message');
    cm.getDisplayBlocks();

    const lines = cm.getErrorLines();
    // Stale 'wrfc' cleared → bare add defaults to 'system' → navigable.
    expect(lines.length).toBeGreaterThan(0);
  });
});
