// ---------------------------------------------------------------------------
// checkpoint-runtime-command.test.ts — /checkpoints, /checkpoint
//
// Exercises the real WorkspaceCheckpointManager (@pellux/goodvibes-sdk,
// installed in node_modules — no mock needed for the manager itself) against
// a scratch workspace directory. Only the TUI context plumbing (print/render)
// is mocked, per the project's existing command-test pattern.
//
// Restoring a checkpoint moved to the unified message-anchored /rewind
// (rewind-runtime.ts, covered by rewind-runtime-command.test.ts); this file
// covers only the listing + manual-create commands that stayed here.
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerCheckpointRuntimeCommands } from '../../input/commands/checkpoint-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeScratchWorkspace(): string {
  const dir = makeProjectTempDir('gv-checkpoint-runtime');
  tempDirs.push(dir);
  return dir;
}

function makeCtx(dir: string, mgr?: WorkspaceCheckpointManager) {
  const printed: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    exit: () => {},
    session: {
      conversationManager: { addSystemMessage: () => {} },
      runtime: { model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 's' },
    },
    workspace: { workspaceCheckpointManager: mgr },
    provider: {},
    platform: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed };
}

// ---------------------------------------------------------------------------
// (a) command registration
// ---------------------------------------------------------------------------

describe('checkpoint-runtime commands registration', () => {
  test('registers /checkpoints and /checkpoint (rewind now lives in rewind-runtime)', () => {
    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    expect(registry.get('checkpoints')).toBeDefined();
    expect(registry.get('checkpoint')).toBeDefined();
    expect(registry.get('rewind')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (b) missing-service guard
// ---------------------------------------------------------------------------

describe('checkpoint-runtime commands — workspaceCheckpointManager not wired', () => {
  test('both commands print a graceful message and never throw', async () => {
    const dir = makeScratchWorkspace();
    const registry = new CommandRegistry();
    registerCheckpointRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(dir, undefined);

    await registry.execute('checkpoints', [], ctx);
    await registry.execute('checkpoint', ['label'], ctx);

    expect(printed.filter((l) => l.includes('not available in this session')).length).toBe(2);
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
    const dataRows = printed.filter((l) => l.startsWith('  '));
    expect(dataRows.length).toBe(2);
    expect(dataRows[0]).toContain('second');
    expect(dataRows[1]).toContain('first');
  });
});

// ---------------------------------------------------------------------------
// (f) manager present but init() has already failed — reject-forever guard
// ---------------------------------------------------------------------------

describe('checkpoint-runtime commands — manager present but init() failed', () => {
  test('both commands report the failure instead of throwing or hanging', async () => {
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
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(printed.some((l) => l.startsWith('Failed to list checkpoints:'))).toBe(true);
    expect(printed.some((l) => l.startsWith('Checkpoint failed:'))).toBe(true);
  });
});
