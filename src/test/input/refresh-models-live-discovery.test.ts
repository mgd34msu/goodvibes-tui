import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerLocalRuntimeCommands } from '../../input/commands/local-runtime.ts';

function makeCtx(providerApi: unknown): { ctx: CommandContext; printed: string[] } {
  const printed: string[] = [];
  const ctx = {
    clients: { providerApi },
    print: (text: string) => { printed.push(text); },
  } as unknown as CommandContext;
  return { ctx, printed };
}

describe('/refresh-models live model discovery', () => {
  test('renders each provider\'s discovery delta ("N new, M retired")', async () => {
    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    const forced: Array<{ force?: boolean } | undefined> = [];
    const providerApi = {
      refreshCatalog: async () => ({ modelCount: 10, providerCount: 2 }),
      refreshBenchmarks: async () => 5,
      refreshModelLimits: async () => 7,
      refreshLiveModelDiscovery: async (_providerId?: string, options?: { force?: boolean }) => {
        forced.push(options);
        return [
          { providerId: 'openai', models: ['a', 'b', 'c'], source: 'live', added: ['a', 'b', 'c'], removed: ['old'] },
          { providerId: 'anthropic', models: ['x'], source: 'live', added: [], removed: [] },
        ];
      },
    };
    const { ctx, printed } = makeCtx(providerApi);

    await registry.execute('refresh-models', [], ctx);

    const text = printed.join('\n');
    // Explicit user refresh forces past the TTL cache.
    expect(forced).toEqual([{ force: true }]);
    // The delta is rendered, not a silent no-op.
    expect(text).toContain('openai: 3 new, 1 retired');
    expect(text).toContain('anthropic: no changes (1 models)');
    expect(text).not.toContain('Some refreshes failed');
  });

  test('renders the honest failure line when live discovery throws', async () => {
    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    const providerApi = {
      refreshCatalog: async () => ({ modelCount: 1, providerCount: 1 }),
      refreshBenchmarks: async () => 0,
      refreshModelLimits: async () => 0,
      refreshLiveModelDiscovery: async () => { throw new Error('network down'); },
    };
    const { ctx, printed } = makeCtx(providerApi);

    await registry.execute('refresh-models', [], ctx);

    const text = printed.join('\n');
    expect(text).toContain('Live model discovery failed: network down');
    expect(text).toContain('Some refreshes failed');
  });
});
