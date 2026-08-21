// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation';

describe('ConversationManager: undo/redo/getLastUserMessage', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  // ── undo ──────────────────────────────────────────────────────────────────

  test('undo: removes the last turn pair (user + assistant)', () => {
    cm.addUserMessage('hello');
    cm.addAssistantMessage('world');
    const beforeCount = cm.getMessageCount();
    expect(beforeCount).toBe(2);

    const result = cm.undo();
    expect(result).toBe(true);
    expect(cm.getMessageCount()).toBe(0);
    expect(cm.getMessagesForLLM()).toHaveLength(0);
  });

  test('undo: returns false when nothing to undo', () => {
    const result = cm.undo();
    expect(result).toBe(false);
    expect(cm.getMessageCount()).toBe(0);
  });

  test('undo: removes only the last user message and everything after it', () => {
    cm.addUserMessage('first');
    cm.addAssistantMessage('first response');
    cm.addUserMessage('second');
    cm.addAssistantMessage('second response');
    expect(cm.getMessageCount()).toBe(4);

    cm.undo();
    expect(cm.getMessageCount()).toBe(2);
    const msgs = cm.getMessagesForLLM();
    expect(msgs[0].content).toBe('first');
    expect(msgs[1].content).toBe('first response');
  });

  test('undo: multiple turns in sequence', () => {
    cm.addUserMessage('a');
    cm.addAssistantMessage('ra');
    cm.addUserMessage('b');
    cm.addAssistantMessage('rb');

    cm.undo(); // removes turn b
    expect(cm.getMessageCount()).toBe(2);

    cm.undo(); // removes turn a
    expect(cm.getMessageCount()).toBe(0);

    const third = cm.undo(); // nothing left
    expect(third).toBe(false);
  });

  test('undo: handles tool messages in the turn (removes all after user)', () => {
    cm.addUserMessage('use tools');
    cm.addAssistantMessage('calling tool', { toolCalls: [{ id: 'c1', name: 'myTool', arguments: {} }] });
    cm.addToolResults([{ callId: 'c1', success: true, output: 'done' }]);
    cm.addAssistantMessage('done using tools');
    expect(cm.getMessageCount()).toBe(4);

    cm.undo();
    expect(cm.getMessageCount()).toBe(0);
  });

  // ── redo ──────────────────────────────────────────────────────────────────

  test('redo: restores the last undone turn', () => {
    cm.addUserMessage('hello');
    cm.addAssistantMessage('world');
    cm.undo();
    expect(cm.getMessageCount()).toBe(0);

    const result = cm.redo();
    expect(result).toBe(true);
    expect(cm.getMessageCount()).toBe(2);
    const msgs = cm.getMessagesForLLM();
    expect(msgs[0].content).toBe('hello');
    expect(msgs[1].content).toBe('world');
  });

  test('redo: returns false when nothing to redo', () => {
    const result = cm.redo();
    expect(result).toBe(false);
  });

  test('redo: stacks correctly with multiple undos', () => {
    cm.addUserMessage('a');
    cm.addAssistantMessage('ra');
    cm.addUserMessage('b');
    cm.addAssistantMessage('rb');

    cm.undo(); // undoes turn b
    cm.undo(); // undoes turn a
    expect(cm.getMessageCount()).toBe(0);

    cm.redo(); // restores turn a
    expect(cm.getMessageCount()).toBe(2);

    cm.redo(); // restores turn b
    expect(cm.getMessageCount()).toBe(4);
  });

  // ── undo stack cleared on new message ─────────────────────────────────────

  test('undo clears redo stack when a new user message is added', () => {
    cm.addUserMessage('first');
    cm.addAssistantMessage('first response');
    cm.undo();
    expect(cm.getMessageCount()).toBe(0);

    // New user input: clears undo stack
    cm.addUserMessage('new message');
    const redoResult = cm.redo();
    expect(redoResult).toBe(false); // undo stack was cleared
    expect(cm.getMessageCount()).toBe(1);
  });

  // ── getLastUserMessage ─────────────────────────────────────────────────────

  test('getLastUserMessage: returns last user message content', () => {
    cm.addUserMessage('hello world');
    cm.addAssistantMessage('response');
    expect(cm.getLastUserMessage()).toBe('hello world');
  });

  test('getLastUserMessage: returns null when no messages', () => {
    expect(cm.getLastUserMessage()).toBeNull();
  });

  test('getLastUserMessage: returns null when content is ContentPart[]', () => {
    cm.addUserMessage([{ type: 'text', text: 'hello' }, { type: 'image', data: 'abc', mediaType: 'image/png' }]);
    // Content is ContentPart[], not string, should return null
    expect(cm.getLastUserMessage()).toBeNull();
  });

  test('getLastUserMessage: returns the most recent user message when multiple exist', () => {
    cm.addUserMessage('first');
    cm.addAssistantMessage('response');
    cm.addUserMessage('second');
    expect(cm.getLastUserMessage()).toBe('second');
  });

  // ── retry flow ────────────────────────────────────────────────────────────

  test('retry flow: getLastUserMessage returns content before undo', () => {
    cm.addUserMessage('hello');
    cm.addAssistantMessage('world');
    // Simulate retry: get last message, then undo
    const lastMsg = cm.getLastUserMessage();
    expect(lastMsg).toBe('hello');
    const undone = cm.undo();
    expect(undone).toBe(true);
    expect(cm.getMessageCount()).toBe(0);
  });

  test('retry flow: getLastUserMessage returns null when no messages exist', () => {
    expect(cm.getLastUserMessage()).toBeNull();
  });

  test('retry flow: after undo, state is clean for re-submission', () => {
    cm.addUserMessage('first');
    cm.addAssistantMessage('first response');
    cm.addUserMessage('second');
    cm.addAssistantMessage('second response');

    const lastMsg = cm.getLastUserMessage();
    expect(lastMsg).toBe('second');

    cm.undo();
    expect(cm.getMessageCount()).toBe(2);

    // After undo, getLastUserMessage reflects the remaining turn
    expect(cm.getLastUserMessage()).toBe('first');
  });

  test('resetAll: clears undoStack so redo returns false', () => {
    cm.addUserMessage('hello');
    cm.addAssistantMessage('world');
    cm.undo();
    // Before reset, redo should be possible
    const beforeReset = new ConversationManager(() => 80);
    beforeReset.addUserMessage('hello');
    beforeReset.addAssistantMessage('world');
    beforeReset.undo();
    expect(beforeReset.redo()).toBe(true);

    // After resetAll, undo stack is cleared
    cm.resetAll();
    expect(cm.redo()).toBe(false);
    expect(cm.getMessageCount()).toBe(0);
  });
});
