import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '@/input/command-registry.ts';
import { registerPrincipalsRuntimeCommands, renderPrincipal } from '@/input/commands/principals-runtime.ts';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';

type Principal = OperatorMethodOutput<'principals.list'>['principals'][number];

function makeCtx(): CommandContext & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    print: (text: string) => { printed.push(text); },
    platform: {
      configManager: { get: () => undefined },
    },
    workspace: {},
  } as unknown as CommandContext & { printed: string[] };
}

function makeRegistry() {
  const registry = new CommandRegistry();
  registerPrincipalsRuntimeCommands(registry);
  return registry;
}

describe('/principals command', () => {
  test('registers as "principals"', () => {
    expect(makeRegistry().get('principals')).toBeDefined();
  });

  test('unknown subcommand prints usage without touching the operator connection', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('principals')!.handler(['bogus'], ctx);
    expect(ctx.printed.join('\n')).toContain('Usage: /principals <subcommand>');
  });

  test('get without an id prints usage', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('principals')!.handler(['get'], ctx);
    expect(ctx.printed.join('\n')).toBe('Usage: /principals get <id>');
  });

  test('create without a valid kind prints usage', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('principals')!.handler(['create', 'Alice', 'bogus-kind'], ctx);
    expect(ctx.printed.join('\n')).toContain('Usage: /principals create <name>');
  });

  test('update without an id prints usage', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('principals')!.handler(['update'], ctx);
    expect(ctx.printed.join('\n')).toContain('Usage: /principals update <id>');
  });

  test('delete without an id prints usage', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('principals')!.handler(['delete'], ctx);
    expect(ctx.printed.join('\n')).toBe('Usage: /principals delete <id>');
  });

  test('resolve without channel+value prints usage', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('principals')!.handler(['resolve', 'slack'], ctx);
    expect(ctx.printed.join('\n')).toContain('Usage: /principals resolve <channel> <value>');
  });

  test('list is honestly unavailable without a reachable control-plane base URL', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('principals')!.handler(['list'], ctx);
    expect(ctx.printed.join('\n')).toContain('no control-plane base URL is configured');
  });

  test('resolve with valid args is honestly unavailable without a reachable base URL', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('principals')!.handler(['resolve', 'slack', 'U123'], ctx);
    expect(ctx.printed.join('\n')).toContain('[principals]');
  });
});

describe('renderPrincipal', () => {
  function principal(overrides: Partial<Principal> = {}): Principal {
    return {
      id: 'p1',
      name: 'Alice',
      kind: 'user',
      identities: [],
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    } as Principal;
  }

  test('renders id, name, and kind', () => {
    const text = renderPrincipal(principal());
    expect(text).toContain('p1');
    expect(text).toContain('Alice');
    expect(text).toContain('[user]');
  });

  test('renders channel identities when present', () => {
    const text = renderPrincipal(principal({ identities: [{ channel: 'slack', value: 'U123' }] }));
    expect(text).toContain('slack:U123');
  });

  test('renders "(none)" when there are no identities', () => {
    const text = renderPrincipal(principal({ identities: [] }));
    expect(text).toContain('identities: (none)');
  });
});
