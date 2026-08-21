import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerCostRuntimeCommands } from '../../input/commands/cost-runtime.ts';
import type { CommandContext } from '../../input/command-registry.ts';

function makeCtx(configGet?: (key: string) => unknown): CommandContext & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    workspace: {},
    platform: {
      configManager: {
        get: (key: string) => (configGet ? configGet(key) : undefined),
      },
    },
  } as unknown as CommandContext & { printed: string[] };
}

describe('/cost attribution', () => {
  function makeRegistry() {
    const registry = new CommandRegistry();
    registerCostRuntimeCommands(registry);
    return registry;
  }

  test('honestly reports the daemon as disabled rather than fabricating a report', async () => {
    const registry = makeRegistry();
    const ctx = makeCtx((key) => (key === 'daemon.enabled' ? false : undefined));
    await registry.get('cost')!.handler(['attribution'], ctx);
    const text = ctx.printed.join('\n');
    expect(text).toContain('[cost attribution]');
    expect(text).toContain('daemon is disabled');
  });

  test('accepts a 7d window flag alongside the default 24h', async () => {
    const registry = makeRegistry();
    const ctx = makeCtx((key) => (key === 'daemon.enabled' ? false : undefined));
    await registry.get('cost')!.handler(['attribution', '7d'], ctx);
    // Still refused honestly (no daemon), this asserts the flag is accepted without throwing.
    expect(ctx.printed.join('\n')).toContain('[cost attribution]');
  });

  test('usage message for an unknown subcommand mentions attribution', async () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    await registry.get('cost')!.handler(['bogus'], ctx);
    expect(ctx.printed.join('\n')).toContain('attribution');
  });
});
