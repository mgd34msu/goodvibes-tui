// ---------------------------------------------------------------------------
// checkpoint-runtime-command.test.ts — /checkpoints, /checkpoint, /rewind
//
// Exercises the real WorkspaceCheckpointManager (@pellux/goodvibes-sdk,
// installed in node_modules — no mock needed for the manager itself) against
// a scratch workspace directory. Only the TUI context plumbing (panelManager,
// conversationManager, print/render/focus) is mocked, per the project's
// existing command-test pattern (see diff-runtime.test.ts, tts-runtime-command.test.ts).
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerCheckpointRuntimeCommands } from '../../input/commands/checkpoint-runtime.ts';
import { DiffPanel } from '../../panels/diff-panel.ts';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeScratchWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-checkpoint-runtime-'));
  tempDirs.push(dir);
  return dir;
}

/** Poll `predicate` until it returns true or `timeoutMs` elapses. Used to wait
 * on the fire-and-forget restore triggered by DiffPanel.handleInput('y'). */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

function makeCtx(dir: string, mgr?: WorkspaceCheckpointManager) {
  const printed: string[] = [];
  const systemMessages: string[] = [];
  const opened: string[] = [];
  let focusCalls = 0;
  let renderCalls = 0;
  let diffPanel: DiffPanel | null = null;

  const panelManager = {
    getAllOpen: () => (diffPanel ? [diffPanel] : []),
    open: (id: string) => {
      opened.push(id);
      if (id !== 'diff') throw new Error(`unexpected panel id: ${id}`);
      diffPanel = new DiffPanel(dir, () => { renderCalls++; });
      return diffPanel;
    },
    activateById: () => {},
    isVisible: () => true,
    show: () => {},
  };

  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => { renderCalls++; },
    exit: () => {},
    focusPanels: () => { focusCalls++; },
    session: {
      conversationManager: {
        addSystemMessage: (text: string) => { systemMessages.push(text); },
      },
      runtime: { model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 's' },
    },
    workspace: {
      workspaceCheckpointManager: mgr,
      panelManager,
    },
    provider: {},
    platform: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;

  return {
    ctx,
    printed,
    systemMessages,
    opened,
    getFocusCalls: () => focusCalls,
    getRenderCalls: () => renderCalls,
    getDiffPanel: () => diffPanel,
  };
}

// ---------------------------------------------------------------------------
// (a) command registration
// ---------------------------------------------------------------------------

describe('checkpoint-runtime commands registration', () => {
  test('registers /checkpoints, /checkpoint, /rewind', () => {
    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    expect(registry.get('checkpoints')).toBeDefined();
    expect(registry.get('checkpoint')).toBeDefined();
    expect(registry.get('rewind')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (b) missing-service guard
// ---------------------------------------------------------------------------

describe('checkpoint-runtime commands — workspaceCheckpointManager not wired', () => {
  test('all three commands print a graceful message and never throw', async () => {
    const dir = makeScratchWorkspace();
    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(dir, undefined);

    await registry.execute('checkpoints', [], ctx);
    await registry.execute('checkpoint', ['label'], ctx);
    await registry.execute('rewind', ['last'], ctx);

    expect(printed.filter((l) => l.includes('not available in this session')).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// (c) /checkpoints — empty state
// ---------------------------------------------------------------------------

describe('/checkpoints — empty state', () => {
  test('prints a helpful message when no checkpoints exist yet', async () => {
    const dir = makeScratchWorkspace();
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(dir, mgr);

    await registry.execute('checkpoints', [], ctx);

    expect(printed.some((l) => /No checkpoints yet/i.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (d) /checkpoint — manual create (+ forensic retention, + no-op dedupe)
// ---------------------------------------------------------------------------

describe('/checkpoint — manual create', () => {
  test('creates a manual, forensic-retention checkpoint and prints its id/label', async () => {
    const dir = makeScratchWorkspace();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(dir, mgr);

    await registry.execute('checkpoint', ['before refactor'], ctx);

    expect(printed.some((l) => l.includes('Checkpoint created:') && l.includes('before refactor') && l.includes('forensic'))).toBe(true);

    const all = await mgr.list();
    expect(all.length).toBe(1);
    expect(all[0]!.kind).toBe('manual');
    expect(all[0]!.retentionClass).toBe('forensic');
    expect(all[0]!.label).toBe('before refactor');
  });

  test('a second /checkpoint with no intervening changes is a no-op, not a duplicate entry', async () => {
    const dir = makeScratchWorkspace();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(dir, mgr);

    await registry.execute('checkpoint', [], ctx);
    await registry.execute('checkpoint', [], ctx);

    expect((await mgr.list()).length).toBe(1);
    expect(printed.some((l) => /nothing to save/i.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) /checkpoints — listing, newest first
// ---------------------------------------------------------------------------

describe('/checkpoints — lists newest first', () => {
  test('shows both checkpoints with the most recent listed first', async () => {
    const dir = makeScratchWorkspace();
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(dir, mgr);

    writeFileSync(join(dir, 'a.txt'), 'v1');
    const first = await mgr.create({ kind: 'manual', label: 'first', retentionClass: 'forensic' });
    writeFileSync(join(dir, 'a.txt'), 'v2');
    const second = await mgr.create({ kind: 'manual', label: 'second', retentionClass: 'forensic' });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    await registry.execute('checkpoints', [], ctx);

    const header = printed.find((l) => l.startsWith('Checkpoints ('));
    expect(header).toContain('2, newest first');
    // Data rows are two-space indented; isolate them so the header's own
    // "newest first" text can't be mistaken for the "first" checkpoint's row.
    const dataRows = printed.filter((l) => l.startsWith('  '));
    expect(dataRows.length).toBe(2);
    expect(dataRows[0]).toContain('second');
    expect(dataRows[1]).toContain('first');
  });
});

// ---------------------------------------------------------------------------
// (f) /rewind — unknown id
// ---------------------------------------------------------------------------

describe('/rewind — unknown id', () => {
  test('prints an error and never opens the diff panel or arms a confirm', async () => {
    const dir = makeScratchWorkspace();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    await mgr.create({ kind: 'manual', label: 'only', retentionClass: 'forensic' });
    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed, opened, getDiffPanel } = makeCtx(dir, mgr);

    await registry.execute('rewind', ['not-a-real-id'], ctx);

    expect(printed.some((l) => /Unknown checkpoint id/i.test(l))).toBe(true);
    expect(opened).toEqual([]);
    expect(getDiffPanel()).toBeNull();
  });

  test('bare /rewind with no args prints usage instead of throwing', async () => {
    const dir = makeScratchWorkspace();
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed, opened } = makeCtx(dir, mgr);

    await registry.execute('rewind', [], ctx);

    expect(printed.some((l) => /Usage: \/rewind/i.test(l))).toBe(true);
    expect(opened).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (g) /rewind — confirm flow: preview, cancel, then confirm+restore
// ---------------------------------------------------------------------------

describe('/rewind — confirm flow', () => {
  test('opens+focuses the diff panel with a pending confirm; "n" cancels without restoring', async () => {
    const dir = makeScratchWorkspace();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const checkpoint1 = await mgr.create({ kind: 'manual', label: 'first', retentionClass: 'forensic' });
    expect(checkpoint1).not.toBeNull();
    writeFileSync(join(dir, 'a.txt'), 'v2');
    writeFileSync(join(dir, 'b.txt'), 'new file');
    const checkpoint2 = await mgr.create({ kind: 'manual', label: 'second', retentionClass: 'forensic' });
    expect(checkpoint2).not.toBeNull();

    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed, opened, getFocusCalls, getDiffPanel } = makeCtx(dir, mgr);

    await registry.execute('rewind', [checkpoint1!.id], ctx);

    expect(opened).toEqual(['diff']);
    expect(getFocusCalls()).toBeGreaterThan(0);
    const panel = getDiffPanel();
    expect(panel).not.toBeNull();
    expect(panel!.confirmOverlay.pending).toBe(true);
    expect(printed.some((l) => l.includes('Previewing checkpoint'))).toBe(true);

    // Cancel — no restore should happen.
    expect(panel!.handleInput('n')).toBe(true);
    expect(panel!.confirmOverlay.pending).toBe(false);
    expect(printed.some((l) => /Rewind cancelled/i.test(l))).toBe(true);
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('v2');
    expect(existsSync(join(dir, 'b.txt'))).toBe(true);
  });

  test('any key other than y/n/Enter/Esc is absorbed and keeps the confirm pending', async () => {
    const dir = makeScratchWorkspace();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    await mgr.create({ kind: 'manual', label: 'first', retentionClass: 'forensic' });
    writeFileSync(join(dir, 'a.txt'), 'v2');
    await mgr.create({ kind: 'manual', label: 'second', retentionClass: 'forensic' });

    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, getDiffPanel } = makeCtx(dir, mgr);

    await registry.execute('rewind', ['last'], ctx);
    const panel = getDiffPanel()!;
    expect(panel.confirmOverlay.pending).toBe(true);

    expect(panel.handleInput('x')).toBe(true); // absorbed
    expect(panel.confirmOverlay.pending).toBe(true);

    // Clean up: cancel so the fire-and-forget confirm doesn't leak into other tests.
    panel.handleInput('escape');
  });

  test('"y" confirms: restores files, prints an honest summary with a safety checkpoint id, and adds a transcript notice without touching conversation turns', async () => {
    const dir = makeScratchWorkspace();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const mgr = new WorkspaceCheckpointManager({ workspaceRoot: dir });
    const checkpoint1 = await mgr.create({ kind: 'manual', label: 'first', retentionClass: 'forensic' });
    writeFileSync(join(dir, 'a.txt'), 'v2');
    writeFileSync(join(dir, 'b.txt'), 'new file');
    await mgr.create({ kind: 'manual', label: 'second', retentionClass: 'forensic' });
    // Drift the working tree past the last checkpoint so restore()'s own
    // pre-restore safety snapshot isn't itself a no-op (create() returns null
    // — and thus safetyCheckpointId is null — when the tree is unchanged
    // since the most recent checkpoint).
    writeFileSync(join(dir, 'a.txt'), 'v3');

    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed, systemMessages, getDiffPanel } = makeCtx(dir, mgr);

    await registry.execute('rewind', [checkpoint1!.id], ctx);
    const panel = getDiffPanel()!;
    expect(panel.confirmOverlay.pending).toBe(true);

    expect(panel.handleInput('y')).toBe(true);
    await waitFor(() => printed.some((l) => l.startsWith('Rewind complete:')));

    // Honesty summary: restored count, removed count, and a real safety checkpoint id.
    const summary = printed.find((l) => l.startsWith('Rewind complete:'))!;
    expect(summary).toMatch(/restored 1 file/);
    expect(summary).toMatch(/removed 1 file/);
    expect(summary).not.toContain('(none');

    // Filesystem actually rewound to checkpoint1's state.
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('v1');
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);

    // A safety checkpoint was taken before restoring (restore() default).
    const all = await mgr.list();
    expect(all.some((c) => c.label.includes('pre-restore safety'))).toBe(true);

    // Transcript notice: NOT via ctx.print, but via conversationManager.addSystemMessage.
    expect(systemMessages.length).toBe(1);
    expect(systemMessages[0]).toContain('[Rewind] Restored checkpoint "first"');
    expect(systemMessages[0]).toContain('conversation history is unchanged');
  });
});
