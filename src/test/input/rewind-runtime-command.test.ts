// ---------------------------------------------------------------------------
// rewind-runtime-command.test.ts — the unified message-anchored /rewind, plus
// /undo rewind and /redo rewind reversals.
//
// Uses the real WorkspaceCheckpointManager against a scratch workspace (turn
// checkpoints carry the same turnId the rewind anchor keys on) and the real
// DiffPanel confirm overlay; the conversation is a small fake that faithfully
// models truncation (removeMessagesAfter) + snapshot/restore (toJSON/fromJSON)
// so the conversation-scope rewind can be asserted end-to-end.
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import {
  registerRewindRuntimeCommands,
  undoLastRewind,
  redoLastRewind,
  resetRewindState,
} from '../../input/commands/rewind-runtime.ts';
import { recordTurnAnchor, clearTurnAnchors } from '@pellux/goodvibes-sdk/platform/rewind';
import { DiffPanel } from '../../panels/diff-panel.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SESSION = 's-rewind';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});
beforeEach(() => {
  resetRewindState(SESSION);
  clearTurnAnchors(SESSION);
});

function makeScratchWorkspace(): string {
  const dir = makeProjectTempDir('gv-rewind-runtime');
  tempDirs.push(dir);
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Minimal conversation that models truncation + snapshot/restore honestly. */
function makeFakeConversation(count: number) {
  let messages = Array.from({ length: count }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const systemMessages: string[] = [];
  return {
    conv: {
      getMessageCount: () => messages.length,
      getLastUserMessage: () => 'refactor the parser',
      toJSON: () => ({ messages: messages.map((m) => ({ ...m })) }),
      fromJSON: (data: { messages: unknown[] }) => { messages = data.messages.map((m) => ({ ...(m as object) })) as typeof messages; },
      removeMessagesAfter: (n: number) => { messages = messages.slice(0, n); },
      rebuildHistory: () => {},
      addTypedSystemMessage: (text: string) => { systemMessages.push(text); },
    },
    systemMessages,
    getMessages: () => messages,
  };
}

function makeCtx(dir: string, mgr: WorkspaceCheckpointManager | undefined, conv: ReturnType<typeof makeFakeConversation>['conv']) {
  const printed: string[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  let diffPanel: DiffPanel | null = null;
  const panelManager = {
    getAllOpen: () => (diffPanel ? [diffPanel] : []),
    open: (id: string) => { opened.push(id); diffPanel = new DiffPanel(dir, () => {}); return diffPanel; },
    close: (id: string) => { closed.push(id); if (id === 'diff') diffPanel = null; },
    activateById: () => {},
    isVisible: () => true,
    show: () => {},
  };
  const ctx = {
    print: (t: string) => { printed.push(t); },
    renderRequest: () => {},
    focusPanels: () => {},
    focusPrompt: () => {},
    exit: () => {},
    session: { conversationManager: conv, runtime: { model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: SESSION } },
    workspace: { workspaceCheckpointManager: mgr, panelManager },
    provider: {}, platform: {}, ops: {}, extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed, opened, closed, getDiffPanel: () => diffPanel };
}

// ---------------------------------------------------------------------------

describe('rewind-runtime registration', () => {
  test('registers /rewind', () => {
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);
    expect(registry.get('rewind')).toBeDefined();
  });
});

describe('/rewind — recent-turns picker', () => {
  test('bare /rewind with no recorded turns explains the current-run limitation', async () => {
    const dir = makeScratchWorkspace();
    const { conv } = makeFakeConversation(2);
    const { ctx, printed } = makeCtx(dir, new WorkspaceCheckpointManager({ workspaceRoot: dir }), conv);
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);

    await registry.execute('rewind', [], ctx);
    expect(printed.some((l) => /No completed turns recorded this run/i.test(l))).toBe(true);
  });

  test('bare /rewind lists a recorded turn newest-first', async () => {
    const dir = makeScratchWorkspace();
    const { conv } = makeFakeConversation(4);
    recordTurnAnchor(SESSION, { turnId: 't1', label: 'refactor the parser', messageCount: 2, at: Date.now() });
    const { ctx, printed } = makeCtx(dir, new WorkspaceCheckpointManager({ workspaceRoot: dir }), conv);
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);

    await registry.execute('rewind', [], ctx);
    expect(printed.some((l) => l.includes('1.') && l.includes('refactor the parser'))).toBe(true);
  });
});

describe('/rewind both — files + conversation confirm flow', () => {
  test('previews, confirms, restores files, truncates the conversation, and renders a [Rewind] receipt', async () => {
    const dir = makeScratchWorkspace();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const cp = await mgr.create({ kind: 'turn', turnId: 't1', label: 'turn t1', retentionClass: 'standard' });
    expect(cp).not.toBeNull();
    // Drift the workspace past the checkpoint so restore actually changes files.
    writeFileSync(join(dir, 'a.txt'), 'v2');
    writeFileSync(join(dir, 'b.txt'), 'added later');

    const fake = makeFakeConversation(4); // 4 messages now; anchor keeps 2 → drop 2
    recordTurnAnchor(SESSION, { turnId: 't1', label: 'refactor the parser', messageCount: 2, at: Date.now() });

    const { ctx, printed, opened, getDiffPanel } = makeCtx(dir, mgr, fake.conv);
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);

    await registry.execute('rewind', ['1', 'both'], ctx);
    expect(opened).toEqual(['diff']);
    const panel = getDiffPanel()!;
    expect(panel.confirmOverlay.pending).toBe(true);
    expect(printed.some((l) => l.includes('Previewing rewind'))).toBe(true);

    expect(panel.handleInput('y')).toBe(true);
    await waitFor(() => fake.systemMessages.length > 0);

    // Files restored to the checkpoint state.
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('v1');
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    // Conversation truncated to the recorded boundary (2 kept).
    expect(fake.getMessages().length).toBe(2);
    // Receipt rendered as a [Rewind] block, mentioning both halves + undo.
    const receipt = fake.systemMessages[0]!;
    expect(receipt.startsWith('[Rewind] Receipt')).toBe(true);
    expect(receipt).toContain('Files:');
    expect(receipt).toContain('Conversation: dropped 2 messages');
    expect(receipt).toContain('/undo rewind');
  });
});

describe('/rewind conversation — no checkpoint required', () => {
  test('rewinds conversation only, then /undo rewind restores and /redo rewind re-applies', async () => {
    const dir = makeScratchWorkspace();
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const fake = makeFakeConversation(5); // keep 3 → drop 2
    recordTurnAnchor(SESSION, { turnId: 't1', label: 'do the thing', messageCount: 3, at: Date.now() });

    const { ctx, getDiffPanel } = makeCtx(dir, mgr, fake.conv);
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);

    await registry.execute('rewind', ['1', 'conversation'], ctx);
    const panel = getDiffPanel()!;
    expect(panel.confirmOverlay.pending).toBe(true);
    expect(panel.handleInput('y')).toBe(true);
    await waitFor(() => fake.systemMessages.length > 0);
    expect(fake.getMessages().length).toBe(3);

    // Undo the rewind: conversation returns to its pre-rewind 5 messages.
    const undo = await undoLastRewind(ctx);
    expect(undo.handled).toBe(true);
    expect(fake.getMessages().length).toBe(5);

    // Redo re-applies the truncation.
    const redo = await redoLastRewind(ctx);
    expect(redo.handled).toBe(true);
    expect(fake.getMessages().length).toBe(3);
  });

  test('/undo rewind with nothing applied reports it is not handled', async () => {
    const dir = makeScratchWorkspace();
    const fake = makeFakeConversation(2);
    const { ctx } = makeCtx(dir, new WorkspaceCheckpointManager({ workspaceRoot: dir }), fake.conv);
    const result = await undoLastRewind(ctx);
    expect(result.handled).toBe(false);
    expect(result.message).toMatch(/No applied rewind/i);
  });
});

describe('/rewind — checkpoint-only fallback (no completed turns recorded this run)', () => {
  test('bare /rewind with real checkpoints on disk but zero turn anchors lists checkpoints, not the dead-end message', async () => {
    const dir = makeScratchWorkspace();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const cp = await mgr.create({ kind: 'manual', label: 'pre-restart checkpoint', retentionClass: 'standard' });
    expect(cp).not.toBeNull();

    const { conv } = makeFakeConversation(0);
    const { ctx, printed } = makeCtx(dir, mgr, conv);
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);

    await registry.execute('rewind', [], ctx);

    const output = printed.join('\n');
    expect(output).toContain('falling back to workspace checkpoints');
    expect(output).toContain('pre-restart checkpoint');
    expect(output).not.toContain('No completed turns recorded this run yet.');
  });

  test('bare /rewind with no checkpoints AND no turn anchors keeps the honest dead-end message', async () => {
    const dir = makeScratchWorkspace();
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const { conv } = makeFakeConversation(0);
    const { ctx, printed } = makeCtx(dir, mgr, conv);
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);

    await registry.execute('rewind', [], ctx);

    expect(printed.some((l) => l.includes('No completed turns recorded this run yet.'))).toBe(true);
  });

  test('/rewind <n> against the checkpoint fallback previews and, on confirm, restores files only (never touches conversation)', async () => {
    const dir = makeScratchWorkspace();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    await mgr.create({ kind: 'manual', label: 'checkpoint one', retentionClass: 'standard' });
    writeFileSync(join(dir, 'a.txt'), 'v2 — drifted after the checkpoint');

    const fake = makeFakeConversation(3);
    const { ctx, printed, opened, getDiffPanel } = makeCtx(dir, mgr, fake.conv);
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);

    await registry.execute('rewind', ['1'], ctx);
    expect(opened).toEqual(['diff']);
    expect(printed.some((l) => l.includes('Previewing checkpoint restore'))).toBe(true);
    expect(printed.some((l) => l.includes('FILES ONLY'))).toBe(true);

    const panel = getDiffPanel()!;
    expect(panel.confirmOverlay.pending).toBe(true);
    expect(panel.handleInput('y')).toBe(true);
    await waitFor(() => fake.systemMessages.length > 0);

    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('v1');
    // Conversation is completely untouched — still the original 3 messages.
    expect(fake.getMessages().length).toBe(3);
    const receipt = fake.systemMessages[0]!;
    expect(receipt).toContain('[Rewind]');
    expect(receipt).toContain('Files only');
  });

  test('an unknown checkpoint ref reports an honest error instead of opening the diff panel', async () => {
    const dir = makeScratchWorkspace();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const cp = await mgr.create({ kind: 'manual', label: 'only one', retentionClass: 'standard' });
    expect(cp).not.toBeNull();

    const { conv } = makeFakeConversation(0);
    const { ctx, printed, opened } = makeCtx(dir, mgr, conv);
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);

    await registry.execute('rewind', ['99'], ctx);

    expect(opened).toEqual([]);
    expect(printed.some((l) => l.includes('No checkpoint #99'))).toBe(true);
  });
});

describe('/rewind — single-use confirm token', () => {
  test('a stale plan cannot be applied twice (token consumed on first confirm)', async () => {
    const dir = makeScratchWorkspace();
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const fake = makeFakeConversation(4);
    recordTurnAnchor(SESSION, { turnId: 't1', label: 'x', messageCount: 2, at: Date.now() });
    const { ctx, printed, getDiffPanel } = makeCtx(dir, mgr, fake.conv);
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);

    await registry.execute('rewind', ['1', 'conversation'], ctx);
    const panel = getDiffPanel()!;
    panel.handleInput('y');
    await waitFor(() => fake.systemMessages.length > 0);
    expect(fake.getMessages().length).toBe(2);
    // The plan/token is single-use; re-confirming the same (now closed) panel
    // does nothing because the overlay resolved. No second receipt, no throw.
    expect(fake.systemMessages.length).toBe(1);
    expect(printed.some((l) => /Rewind failed/i.test(l))).toBe(false);
  });
});
