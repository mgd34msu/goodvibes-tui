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
import type { Line } from '../../types/grid.ts';

/** Plain-text rendering of a confirm-overlay line, same helper as confirm-state.test.ts. */
function lineText(line: Line): string {
  return line.map((c) => c.char ?? ' ').join('').trimEnd();
}

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
  const closed: string[] = [];
  let focusCalls = 0;
  let focusPromptCalls = 0;
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
    // Mirrors the real PanelManager.close() contract closely enough for
    // these tests: records the call and drops the panel so a caller that
    // re-checks getAllOpen()/getDiffPanel() after close sees it gone.
    close: (id: string) => {
      closed.push(id);
      if (id === 'diff') diffPanel = null;
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
    focusPrompt: () => { focusPromptCalls++; },
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
    closed,
    getFocusCalls: () => focusCalls,
    getFocusPromptCalls: () => focusPromptCalls,
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
    const { ctx, printed, opened, closed, getFocusCalls, getFocusPromptCalls, getDiffPanel } = makeCtx(dir, mgr);

    await registry.execute('rewind', [checkpoint1!.id], ctx);

    expect(opened).toEqual(['diff']);
    expect(getFocusCalls()).toBeGreaterThan(0);
    const panel = getDiffPanel();
    expect(panel).not.toBeNull();
    expect(panel!.confirmOverlay.pending).toBe(true);
    expect(printed.some((l) => l.includes('Previewing checkpoint'))).toBe(true);

    // Label correctness: renderConfirmLines builds `${verb} "${label}"?` itself
    // (panels/confirm-state.ts), so the armed label must be the bare subject —
    // no leading "Restore" and no quotes of its own — or the verb and quotes
    // end up duplicated (`Restore "Restore "baseline-pin"…`).
    const confirmLine = lineText(panel!.confirmOverlay.renderLines(80)![0]!);
    expect(confirmLine).toContain('Restore "first (');
    expect(confirmLine).not.toContain('Restore "Restore');
    expect((confirmLine.match(/Restore/g) ?? []).length).toBe(1);

    // Cancel — no restore should happen, and the preview panel auto-closes
    // (a denied restore leaves nothing actionable to look at).
    expect(panel!.handleInput('n')).toBe(true);
    expect(panel!.confirmOverlay.pending).toBe(false);
    expect(printed.some((l) => /Rewind cancelled/i.test(l))).toBe(true);
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('v2');
    expect(existsSync(join(dir, 'b.txt'))).toBe(true);
    expect(closed).toEqual(['diff']);
    expect(getFocusPromptCalls()).toBeGreaterThan(0);
    expect(getDiffPanel()).toBeNull();
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
    const { ctx, printed, systemMessages, closed, getFocusPromptCalls, getDiffPanel } = makeCtx(dir, mgr);

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

    // The diff preview panel auto-closes once the restore has actually
    // happened — it would otherwise linger open showing a now-stale preview
    // with no obvious way to dismiss it.
    expect(closed).toEqual(['diff']);
    expect(getFocusPromptCalls()).toBeGreaterThan(0);
    expect(getDiffPanel()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (h) /rewind — manager.list() rejects: resolveCheckpointTarget must guard it
// ---------------------------------------------------------------------------
//
// Regression coverage for the unguarded-await finding: resolveCheckpointTarget
// used to `await mgr.list()` with no try/catch, and the /rewind handler
// awaited it directly with no catch either — a rejected list() was a silent
// unhandled rejection (dead command, no message to the user). Both spots are
// exercised here with a `process.on('unhandledRejection', ...)` guard so a
// regression fails the test even if the honest-error text still happens to
// look right.

describe('/rewind — manager.list() rejects', () => {
  test('prints an honest error and never produces an unhandled rejection', async () => {
    const dir = makeScratchWorkspace();
    const rejectingMgr = {
      list: () => Promise.reject(new Error('list boom')),
      create: () => Promise.reject(new Error('create boom')),
      diff: () => Promise.reject(new Error('diff boom')),
      restore: () => Promise.reject(new Error('restore boom')),
    } as unknown as WorkspaceCheckpointManager;

    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(dir, rejectingMgr);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await registry.execute('rewind', ['last'], ctx);
      // Give any stray unhandled rejection a tick to surface before asserting.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(printed.some((l) => l.includes('Failed to list checkpoints') && l.includes('list boom'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (i) all three commands — manager present but its init() has already failed
// ---------------------------------------------------------------------------
//
// Reproduces the services.ts scenario the misleading comment used to
// describe as "degrades to manual-only": WorkspaceCheckpointManager caches an
// init() rejection on `initPromise` and never clears it, so create/list/diff/
// restore (each of which awaits init() first) reject FOREVER, not just once.
// Forced here via a `checkpointDir` whose parent path component is a regular
// file, which makes the side git repo's `mkdir` fail with ENOTDIR — a real
// failure inside the real SDK class, not a hand-rolled mock.

describe('checkpoint-runtime commands — manager present but init() failed', () => {
  test('all three commands report the failure instead of throwing or hanging', async () => {
    const dir = makeScratchWorkspace();
    const blockerFile = join(dir, 'blocker-file');
    writeFileSync(blockerFile, 'not a directory');
    const mgr = new WorkspaceCheckpointManager({
      workspaceRoot: dir,
      checkpointDir: join(blockerFile, 'checkpoints'),
    });

    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(dir, mgr);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await registry.execute('checkpoints', [], ctx);
      await registry.execute('checkpoint', ['label'], ctx);
      await registry.execute('rewind', ['last'], ctx);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(printed.filter((l) => /fail/i.test(l)).length).toBe(3);
    expect(printed.some((l) => l.startsWith('Failed to list checkpoints:'))).toBe(true);
    expect(printed.some((l) => l.startsWith('Checkpoint failed:'))).toBe(true);
  });
});
