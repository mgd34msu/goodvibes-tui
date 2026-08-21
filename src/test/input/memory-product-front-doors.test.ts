import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { createMemoryApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import { MemorySpineClient, createLocalMemoryAccess, type LocalMemoryStore } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import { MemoryRegistry, MemoryStore } from '@pellux/goodvibes-sdk/platform/state';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Memory front-door scope isolation tests.
 *
 * Verifies that /session-memory queue and /team-memory queue are genuinely
 * scope-filtered first-class views, not identical delegates of recall queue.
 *
 * Core assertion: a session-scoped record appears in /session-memory queue
 * but NOT in /team-memory queue, and vice versa.
 */

function makeContext(registry: MemoryRegistry, printed: string[], dir: string): CommandContext & { executeCommand: (name: string, args: string[]) => Promise<boolean> } {
  const shellPaths = createShellPathService({ workingDirectory: dir, homeDirectory: dir });
  const ctx: CommandContext & { executeCommand?: (name: string, args: string[]) => Promise<boolean> } = {
    session: {
      conversationManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'test-session-1',
      },
    },
    provider: { providerRegistry: {} as never },
    workspace: { shellPaths },
    platform: { config: {} as never, configManager: {} as never },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: { listServerSecurity: () => [] } as never,
      memoryRegistry: registry,
    },
    clients: {
      knowledgeApi: {
        memory: createMemoryApi(registry),
      } as never,
      // The memory-scoped front doors (/session-memory, /team-memory,
      // /memory-sync, /incident capture) route through the memory spine now,
      // not knowledgeApi.memory, see recall-query.ts's getMemorySpine.
      memorySpine: new MemorySpineClient({
        local: createLocalMemoryAccess(registry as unknown as LocalMemoryStore),
      }),
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };

  const commandRegistry = new CommandRegistry();
  registerBuiltinCommands(commandRegistry);
  ctx.executeCommand = async (name: string, args: string[]) => {
    const cmd = commandRegistry.get(name);
    if (!cmd) return false;
    await cmd.handler(args, ctx as CommandContext);
    return true;
  };

  return ctx as CommandContext & { executeCommand: (name: string, args: string[]) => Promise<boolean> };
}

describe('memory product front-door scope isolation', () => {
  let dir: string;
  let store: MemoryStore;
  let registry: MemoryRegistry;
  let printed: string[];

  beforeEach(async () => {
    dir = makeProjectTempDir('gv-front-door');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(dir, '.goodvibes', 'tui'),
      workingDir: dir,
    });
    store = new MemoryStore(join(dir, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    await store.init();
    registry = new MemoryRegistry(store);
    printed = [];
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('/session-memory queue shows session records and hides team records', async () => {
    await registry.add({ cls: 'decision', summary: 'Session-only decision', scope: 'session' });
    await registry.add({ cls: 'decision', summary: 'Team-only decision', scope: 'team' });

    const commandRegistry = new CommandRegistry();
    registerBuiltinCommands(commandRegistry);
    const sessionMemory = commandRegistry.get('session-memory');
    expect(sessionMemory).toBeDefined();

    const ctx = makeContext(registry, printed, dir);
    await sessionMemory!.handler(['queue', '20'], ctx);

    const output = printed.join('\n');
    expect(output).toContain('Session-only decision');
    expect(output).not.toContain('Team-only decision');
  });

  test('/team-memory queue shows team records and hides session records', async () => {
    await registry.add({ cls: 'decision', summary: 'Session-only decision', scope: 'session' });
    await registry.add({ cls: 'decision', summary: 'Team-only decision', scope: 'team' });

    const commandRegistry = new CommandRegistry();
    registerBuiltinCommands(commandRegistry);
    const teamMemory = commandRegistry.get('team-memory');
    expect(teamMemory).toBeDefined();

    const ctx = makeContext(registry, printed, dir);
    await teamMemory!.handler(['queue', '20'], ctx);

    const output = printed.join('\n');
    expect(output).toContain('Team-only decision');
    expect(output).not.toContain('Session-only decision');
  });

  test('/session-memory queue is empty when no session-scoped records exist', async () => {
    await registry.add({ cls: 'pattern', summary: 'Only a team record', scope: 'team' });

    const commandRegistry = new CommandRegistry();
    registerBuiltinCommands(commandRegistry);
    const sessionMemory = commandRegistry.get('session-memory');
    expect(sessionMemory).toBeDefined();

    const ctx = makeContext(registry, printed, dir);
    await sessionMemory!.handler(['queue'], ctx);

    expect(printed.join('\n')).toContain('Review queue is empty');
  });

  test('/team-memory queue is empty when no team-scoped records exist', async () => {
    await registry.add({ cls: 'pattern', summary: 'Only a session record', scope: 'session' });

    const commandRegistry = new CommandRegistry();
    registerBuiltinCommands(commandRegistry);
    const teamMemory = commandRegistry.get('team-memory');
    expect(teamMemory).toBeDefined();

    const ctx = makeContext(registry, printed, dir);
    await teamMemory!.handler(['queue'], ctx);

    expect(printed.join('\n')).toContain('Review queue is empty');
  });

  test('scope isolation holds when both scopes have multiple records', async () => {
    await registry.add({ cls: 'decision', summary: 'Session decision A', scope: 'session' });
    await registry.add({ cls: 'runbook', summary: 'Session runbook B', scope: 'session' });
    await registry.add({ cls: 'decision', summary: 'Team decision X', scope: 'team' });
    await registry.add({ cls: 'risk', summary: 'Team risk Y', scope: 'team' });
    await registry.add({ cls: 'fact', summary: 'Project fact Z', scope: 'project' });

    const commandRegistry = new CommandRegistry();
    registerBuiltinCommands(commandRegistry);
    const sessionMemory = commandRegistry.get('session-memory');
    const teamMemory = commandRegistry.get('team-memory');

    const ctx = makeContext(registry, printed, dir);

    // Session queue must contain only session-scoped records.
    await sessionMemory!.handler(['queue', '20'], ctx);
    const sessionOutput = printed.join('\n');
    expect(sessionOutput).toContain('Session decision A');
    expect(sessionOutput).toContain('Session runbook B');
    expect(sessionOutput).not.toContain('Team decision X');
    expect(sessionOutput).not.toContain('Team risk Y');
    expect(sessionOutput).not.toContain('Project fact Z');

    printed.length = 0;

    // Team queue must contain only team-scoped records.
    await teamMemory!.handler(['queue', '20'], ctx);
    const teamOutput = printed.join('\n');
    expect(teamOutput).toContain('Team decision X');
    expect(teamOutput).toContain('Team risk Y');
    expect(teamOutput).not.toContain('Session decision A');
    expect(teamOutput).not.toContain('Session runbook B');
    expect(teamOutput).not.toContain('Project fact Z');
  });

  test('/session-memory and /team-memory descriptions state their scope honestly', () => {
    const commandRegistry = new CommandRegistry();
    registerBuiltinCommands(commandRegistry);
    const sessionMemory = commandRegistry.get('session-memory');
    const teamMemory = commandRegistry.get('team-memory');
    expect(sessionMemory?.description).toContain('session');
    expect(teamMemory?.description).toContain('team');
    // session-memory: ALL subcommands pass --scope session, so the broad claim is accurate.
    expect(sessionMemory?.description).toContain('scope=session');
    // team-memory: only queue and export pass --scope team; import and capture policy do not.
    // Description must name the scoped subcommands explicitly, not over-claim for all four.
    expect(teamMemory?.description).toContain('scope=team');
    // Must NOT claim ALL subcommands are filtered (import and capture policy are not).
    expect(teamMemory?.description).not.toContain('All subcommands are filtered to scope=team');
    // Must explicitly scope the claim to queue and export.
    expect(teamMemory?.description).toContain('queue and export subcommands are filtered to scope=team');
  });

  test('/memory-sync and /handoff are honest: export delegates with explicit scope', async () => {
    // memory-sync export with explicit scope arg passes it through to recall export
    const commandRegistry = new CommandRegistry();
    registerBuiltinCommands(commandRegistry);
    const memorySync = commandRegistry.get('memory-sync');
    const handoff = commandRegistry.get('handoff');
    expect(memorySync).toBeDefined();
    expect(handoff).toBeDefined();

    await registry.add({ cls: 'decision', summary: 'Project decision to export', scope: 'project' });

    const ctx = makeContext(registry, printed, dir);
    const exportPath = join(dir, 'memory-export.json');
    await memorySync!.handler(['export', exportPath, 'project'], ctx);
    expect(printed.join('\n')).toContain('Exported');

    printed.length = 0;
    const handoffPath = join(dir, 'handoff-export.json');
    await handoff!.handler(['export', handoffPath, 'project'], ctx);
    expect(printed.join('\n')).toContain('handoff bundle');
  });
});
