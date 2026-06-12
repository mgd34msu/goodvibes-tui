import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerChannelRuntimeCommands } from '../../input/commands/channel-runtime.ts';
import type { CommandContext } from '../../input/command-registry.ts';

// ---------------------------------------------------------------------------
// Minimal command context stub for /channel tests
// ---------------------------------------------------------------------------

function makeCtx(overrides: {
  integrationHelpers?: Partial<{
    buildReview: () => Record<string, unknown>;
    getRouteSnapshot: () => Record<string, unknown>;
    getDeliverySnapshot: () => Record<string, unknown>;
  }>;
  configGet?: (key: string) => unknown;
  showPanel?: (id: string) => void;
} = {}): CommandContext & { printed: string[] } {
  const printed: string[] = [];
  const helpers = overrides.integrationHelpers ?? {
    buildReview: () => ({
      apiFamilies: ['rest', 'sse'],
      routes: ['slack', 'webhook'],
      sessions: 3,
      tasks: 1,
      pendingApprovals: 0,
      remoteContracts: 2,
      panels: 5,
    }),
    getRouteSnapshot: () => ({ slack: { active: true }, webhook: { active: false } }),
    getDeliverySnapshot: () => ({ queued: 0, delivered: 12 }),
  };

  return {
    printed,
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    exit: () => {},
    showPanel: overrides.showPanel,
    session: {} as CommandContext['session'],
    provider: {} as CommandContext['provider'],
    workspace: {} as CommandContext['workspace'],
    platform: {
      config: {} as CommandContext['platform']['config'],
      configManager: {
        get: (key: string) => {
          if (overrides.configGet) return overrides.configGet(key);
          if (key === 'surfaces.slack.enabled') return true;
          if (key === 'surfaces.webhook.enabled') return true;
          return undefined;
        },
      } as CommandContext['platform']['configManager'],
    } as CommandContext['platform'],
    ops: {} as CommandContext['ops'],
    extensions: {
      integrationHelpers: helpers,
    } as CommandContext['extensions'],
  } as unknown as CommandContext & { printed: string[] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/channel command', () => {
  function makeRegistry() {
    const registry = new CommandRegistry();
    registerChannelRuntimeCommands(registry);
    return registry;
  }

  test('registers as "channel" with no aliases', () => {
    const registry = makeRegistry();
    expect(registry.get('channel')).toBeDefined();
  });

  test('opens routes panel when called with no args', () => {
    const registry = makeRegistry();
    const panelIds: string[] = [];
    const ctx = makeCtx({ showPanel: (id) => panelIds.push(id) });
    registry.get('channel')!.handler([], ctx);
    expect(panelIds).toEqual(['routes']);
  });

  test('opens routes panel when called with "panel"', () => {
    const registry = makeRegistry();
    const panelIds: string[] = [];
    const ctx = makeCtx({ showPanel: (id) => panelIds.push(id) });
    registry.get('channel')!.handler(['panel'], ctx);
    expect(panelIds).toEqual(['routes']);
  });

  test('status shows route count and families', () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    registry.get('channel')!.handler(['status'], ctx);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Channel Status');
    expect(output).toContain('routes:');
    expect(output).toContain('slack');
    expect(output).toContain('webhook');
  });

  test('status --json emits parseable JSON', () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    registry.get('channel')!.handler(['status', '--json'], ctx);
    const parsed = JSON.parse(ctx.printed[0]!) as Record<string, unknown>;
    expect(parsed).toHaveProperty('routes');
    expect(parsed).toHaveProperty('sessions');
  });

  test('routes shows binding snapshot entries', () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    registry.get('channel')!.handler(['routes'], ctx);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Channel Routes');
    expect(output).toContain('slack');
    expect(output).toContain('webhook');
  });

  test('routes --json emits parseable JSON', () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    registry.get('channel')!.handler(['routes', '--json'], ctx);
    const parsed = JSON.parse(ctx.printed[0]!) as Record<string, unknown>;
    expect(parsed).toHaveProperty('slack');
  });

  test('routes shows empty state when no bindings active', () => {
    const registry = makeRegistry();
    const ctx = makeCtx({
      integrationHelpers: {
        buildReview: () => ({ apiFamilies: [], routes: [], sessions: 0, tasks: 0, pendingApprovals: 0, remoteContracts: 0, panels: 0 }),
        getRouteSnapshot: () => ({}),
        getDeliverySnapshot: () => ({}),
      },
    });
    registry.get('channel')!.handler(['routes'], ctx);
    const output = ctx.printed.join('\n');
    expect(output).toContain('No route bindings active');
  });

  test('delivery shows snapshot entries', () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    registry.get('channel')!.handler(['delivery'], ctx);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Channel Delivery Snapshot');
    expect(output).toContain('queued');
    expect(output).toContain('delivered');
  });

  test('delivery --json emits parseable JSON', () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    registry.get('channel')!.handler(['delivery', '--json'], ctx);
    const parsed = JSON.parse(ctx.printed[0]!) as Record<string, unknown>;
    expect(parsed).toHaveProperty('queued');
  });

  test('policy shows enabled surfaces', () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    registry.get('channel')!.handler(['policy'], ctx);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Channel Ingress Policies');
    expect(output).toContain('slack');
    expect(output).toContain('webhook');
    expect(output).toContain('enabled=true');
  });

  test('policy shows empty state when no surfaces configured', () => {
    const registry = makeRegistry();
    const ctx = makeCtx({ configGet: () => undefined });
    registry.get('channel')!.handler(['policy'], ctx);
    const output = ctx.printed.join('\n');
    expect(output).toContain('No channel surfaces configured');
  });

  test('unknown subcommand prints usage', () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    registry.get('channel')!.handler(['bogus'], ctx);
    const output = ctx.printed.join('\n');
    expect(output).toContain('Usage: /channel');
    expect(output).toContain('status');
    expect(output).toContain('routes');
    expect(output).toContain('delivery');
    expect(output).toContain('policy');
  });
});
