// ---------------------------------------------------------------------------
// session-command-routing.test.ts
// TASK-032: Verify /session registration+domain split.
//
// Guards enforced:
//   1. Exactly one registration for session work: /session (alias: sess).
//   2. session-mgmt and smgmt are NOT registered (removed in TASK-032).
//   3. Every lifecycle subcommand routes through handleSessionWorkflowCommand
//      without relying on fallthrough — the switch is exhaustive for known subs.
//   4. Every orchestration subcommand routes to the correct handler.
//   5. Unknown subcommand prints usage (both domains documented).
//   6. No-arg invocation shows current session info (delegates to lifecycle handler).
// ---------------------------------------------------------------------------

import { describe, expect, test, beforeEach } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import type { CommandContext } from '../../input/command-registry.ts';

// ── Stub helpers ─────────────────────────────────────────────────────────────

function makeRuntime(
  overrides: Partial<CommandContext['session']['runtime']> = {},
): CommandContext['session']['runtime'] {
  return {
    sessionId: 'test-session-id',
    model: 'test-model',
    provider: 'test-provider',
    debugMode: false,
    systemPrompt: '',
    reasoningEffort: 'medium',
    ...overrides,
  };
}

function makeConversationManager(
  overrides: Partial<CommandContext['session']['conversationManager']> = {},
): CommandContext['session']['conversationManager'] {
  return {
    getMessageCount: () => 0,
    title: 'test-session',
    getTranscriptEventIndex: () => ({ events: [], groups: [] }),
    ...overrides,
  } as unknown as CommandContext['session']['conversationManager'];
}

// Minimal sessionManager stub satisfying requireSessionManager
const stubSessionManager = {
  getMeta: (_id: string) => null,
  list: () => [],
  save: () => ({ filePath: '/tmp/x', sanitizedName: 'x' }),
  load: (_name: string) => { throw new Error('not found'); },
  rename: (_old: string, _newName: string) => {},
  delete: (_name: string) => {},
  search: (_q: string) => [],
} as unknown as CommandContext['session']['sessionManager'];

// Minimal orchestration stub satisfying requireSessionOrchestration
const stubOrchestration = {
  snapshot: () => ({ refs: {}, edges: [], handoffs: [] }),
  getDependencies: (_sid: string, _tid: string) => [],
  getDependents: (_sid: string, _tid: string) => [],
  getHandoffs: () => [],
  linkTask: () => ({ ok: false, error: 'stub' }),
  initiateHandoff: () => ({ ok: false, error: 'stub' }),
  cancel: () => ({ ok: false, error: 'stub', cancelled: [], skipped: [] }),
} as unknown as NonNullable<CommandContext['ops']['sessionOrchestration']>;

type CtxWithPrinted = CommandContext & { printed: string[] };

function makeCtx(
  sessionOverrides: Partial<CommandContext['session']> = {},
  opsOverrides: Partial<CommandContext['ops']> = {},
): CtxWithPrinted {
  const printed: string[] = [];
  return {
    printed,
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    exit: () => {},
    session: {
      conversationManager: makeConversationManager(),
      runtime: makeRuntime(),
      sessionManager: stubSessionManager,
      ...sessionOverrides,
    } as CommandContext['session'],
    provider: {} as CommandContext['provider'],
    workspace: {} as CommandContext['workspace'],
    platform: {
      config: {} as CommandContext['platform']['config'],
      configManager: {} as CommandContext['platform']['configManager'],
    } as CommandContext['platform'],
    ops: {
      sessionOrchestration: stubOrchestration,
      ...opsOverrides,
    } as CommandContext['ops'],
    extensions: {} as CommandContext['extensions'],
  } as CtxWithPrinted;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('session-command-routing (TASK-032)', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
    registerBuiltinCommands(registry);
  });

  // ── Registration uniqueness ────────────────────────────────────────────────

  test('session is registered with alias sess', () => {
    const cmd = registry.get('session');
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe('session');
    expect(cmd?.aliases).toContain('sess');
    expect(registry.get('sess')?.name).toBe('session');
  });

  test('session-mgmt is NOT registered (removed in TASK-032)', () => {
    expect(registry.get('session-mgmt')).toBeUndefined();
  });

  test('smgmt is NOT registered (removed in TASK-032)', () => {
    expect(registry.get('smgmt')).toBeUndefined();
  });

  test('registry loads without collision (smoke)', () => {
    expect(registry.getAll().length).toBeGreaterThan(10);
  });

  // ── Help text accuracy ─────────────────────────────────────────────────────

  test('session argsHint documents both domains', () => {
    const cmd = registry.get('session')!;
    // Lifecycle subcommands
    expect(cmd.argsHint).toContain('list');
    expect(cmd.argsHint).toContain('resume');
    expect(cmd.argsHint).toContain('save');
    expect(cmd.argsHint).toContain('delete');
    expect(cmd.argsHint).toContain('export');
    expect(cmd.argsHint).toContain('search');
    // Orchestration subcommands
    expect(cmd.argsHint).toContain('link-task');
    expect(cmd.argsHint).toContain('handoff');
    expect(cmd.argsHint).toContain('graph');
    expect(cmd.argsHint).toContain('cancel');
  });

  test('session description mentions both domains', () => {
    const cmd = registry.get('session')!;
    // Description should cover both lifecycle and orchestration
    expect(cmd.description.toLowerCase()).toMatch(/list|resume|lifecycle/);
    expect(cmd.description.toLowerCase()).toMatch(/link-task|handoff|graph|cancel|orchestration/);
  });

  // ── Lifecycle subcommand routing ───────────────────────────────────────────

  test('no-arg invocation shows session info (delegates to lifecycle handler)', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx({
      conversationManager: makeConversationManager({ title: 'my-session' }),
      runtime: makeRuntime({ sessionId: 'abc-123', model: 'claude-4', provider: 'anthropic' }),
      sessionManager: { ...stubSessionManager, getMeta: (_id: string) => null } as typeof stubSessionManager,
    });
    await cmd.handler([], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    // Should print session info, not a "Usage: /session" error
    expect(output).not.toContain('Usage: /session <subcommand>');
    expect(output).toMatch(/abc-123|my-session|Current session/);
  });

  test('list subcommand routes to lifecycle handler', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx({
      sessionManager: { ...stubSessionManager, list: () => [] } as typeof stubSessionManager,
    });
    await cmd.handler(['list'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    // Lifecycle handler prints either a list or a "no sessions" message
    expect(output).toMatch(/session|No saved/);
    expect(output).not.toContain('Orchestration:');
  });

  test('events subcommand routes to lifecycle handler (transcript events)', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['events'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Transcript Events');
    expect(output).not.toContain('Usage: /session');
  });

  test('groups subcommand routes to lifecycle handler (transcript groups)', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['groups'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Transcript Groups');
    expect(output).not.toContain('Usage: /session');
  });

  test('hotspots subcommand routes to lifecycle handler (transcript hotspots)', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['hotspots'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Transcript Hotspots');
    expect(output).not.toContain('Usage: /session');
  });

  test('rename with no arg prints rename usage (not full /session usage)', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['rename'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Usage: /session rename');
    expect(output).not.toContain('Orchestration:');
  });

  test('delete with no arg prints delete usage (not full /session usage)', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['delete'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Usage: /session delete');
    expect(output).not.toContain('Orchestration:');
  });

  test('resume with no arg prints resume usage (not full /session usage)', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['resume'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Usage: /session resume');
    expect(output).not.toContain('Orchestration:');
  });

  test('export with no arg prints export usage (not full /session usage)', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['export'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Usage: /session export');
    expect(output).not.toContain('Orchestration:');
  });

  test('search with no arg prints search usage (not full /session usage)', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['search'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Usage: /session search');
    expect(output).not.toContain('Orchestration:');
  });

  // ── Orchestration subcommand routing ─────────────────────────────────────────

  test('graph with empty orchestration state prints empty-graph message', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['graph'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    // handleGraph prints an empty-graph message, not the full /session usage
    expect(output).not.toContain('Lifecycle:');
    expect(output).not.toContain('Usage: /session <subcommand>');
    expect(output).toMatch(/empty|No tasks/i);
  });

  test('link-task with no args prints link-task usage (not full /session usage)', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['link-task'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('[session] Usage: /session link-task');
    expect(output).not.toContain('Lifecycle:');
  });

  test('link alias routes to link-task handler', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['link'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    // Both 'link-task' and 'link' go to the same handler
    expect(output).toContain('[session] Usage: /session link-task');
  });

  test('handoff with no args prints handoff usage', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['handoff'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('[session] Usage: /session handoff');
    expect(output).not.toContain('Lifecycle:');
  });

  test('ho alias routes to handoff handler', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['ho'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('[session] Usage: /session handoff');
  });

  test('cancel with no scope-session and no taskId prints cancel usage', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['cancel'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('[session] Usage: /session cancel');
    expect(output).not.toContain('Lifecycle:');
  });

  // ── Unknown subcommand ──────────────────────────────────────────────────────────

  test('unknown subcommand prints usage covering both domains', async () => {
    const cmd = registry.get('session')!;
    const ctx = makeCtx();
    await cmd.handler(['unknown-subcommand-xyz'], ctx as unknown as CommandContext);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Usage: /session');
    // Usage must document lifecycle...
    expect(output).toMatch(/list/);
    expect(output).toMatch(/resume/);
    expect(output).toMatch(/save/);
    // ...and orchestration
    expect(output).toMatch(/link-task/);
    expect(output).toMatch(/handoff/);
    expect(output).toMatch(/graph/);
    expect(output).toMatch(/cancel/);
  });

  // ── sess alias ──────────────────────────────────────────────────────────────────

  test('sess alias resolves to the same command object as session', () => {
    const byName = registry.get('session');
    const byAlias = registry.get('sess');
    expect(byAlias).toBe(byName);
  });

  // ── /sessions resume <id> hygiene ───────────────────────────────────────
  //
  // splash-lines.ts advertises "/sessions resume <id>" (plural, matching the
  // registered command's own name), but the plural /sessions command took
  // (_args, ctx) and ignored args entirely — it always just listed sessions,
  // silently dropping the resume subcommand + id on the floor. The singular
  // /session command is what actually implements `resume`. /sessions now
  // forwards any args to /session's own handler instead of listing.

  test('/sessions resume <id> forwards to /session\'s resume handling instead of silently listing', async () => {
    const registryForSessions = new CommandRegistry();
    registerBuiltinCommands(registryForSessions);
    const ctx = makeCtx();

    await registryForSessions.execute('sessions', ['resume', 'nonexistent-session-id'], ctx as unknown as CommandContext);

    const output = ctx.printed.join('\n');
    // The stub sessionManager has no saved sessions, so /session resume's own
    // "not found" message is the proof the subcommand was actually routed —
    // the old behavior printed the flat "Saved sessions:" list instead and
    // never looked at 'resume'/'nonexistent-session-id' at all.
    expect(output).toContain('Session not found: nonexistent-session-id');
    expect(output).not.toContain('Saved sessions:');
  });

  test('/sessions resume with no id forwards to /session\'s own usage message', async () => {
    const registryForSessions = new CommandRegistry();
    registerBuiltinCommands(registryForSessions);
    const ctx = makeCtx();

    await registryForSessions.execute('sessions', ['resume'], ctx as unknown as CommandContext);

    const output = ctx.printed.join('\n');
    expect(output).toContain('Usage: /session resume');
  });

  test('/sessions with no args still lists sessions (unchanged)', async () => {
    const registryForSessions = new CommandRegistry();
    registerBuiltinCommands(registryForSessions);
    const ctx = makeCtx();

    await registryForSessions.execute('sessions', [], ctx as unknown as CommandContext);

    const output = ctx.printed.join('\n');
    expect(output).toContain('Saved sessions:');
  });
});
