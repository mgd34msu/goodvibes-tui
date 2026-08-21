import { describe, expect, test } from 'bun:test';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import {
  classifyMemoryDiagnosticsError,
  createMemoryDiagnosticsGateway,
  renderMemoryDiagnostics,
  MEMORY_DIAGNOSTICS_UNAVAILABLE,
  type MemoryDiagnosticsGatewayResolution,
} from '../../core/memory-diagnostics-gateway.ts';
import type { MemoryGovernorSnapshotResult } from '@pellux/goodvibes-sdk/platform/runtime/memory';
import { wireMemoryPressureNotice } from '../../runtime/notification-dispatch.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerHealthRuntimeCommands } from '../../input/commands/health-runtime.ts';
import type { CommandContext } from '../../input/command-registry.ts';

const SNAPSHOT: MemoryGovernorSnapshotResult = {
  tier: 'normal',
  budgetMb: 4096,
  rssMb: 512,
  heapUsedMb: 210,
  heapTotalMb: 300,
  usedPct: 12.5,
  refusingExpensiveWork: false,
  caches: [{ id: 'session-union', name: 'shared session broker', entries: 88 }],
  pausedJobs: [],
  tripwire: { armed: false, sustainedSec: 0, rateMbPerSec: 25 },
  thresholds: { elevatedPct: 60, highPct: 80, criticalPct: 95 },
} as MemoryGovernorSnapshotResult;

function readyResolution(snapshot: MemoryGovernorSnapshotResult = SNAPSHOT): MemoryDiagnosticsGatewayResolution {
  return { available: true, gateway: { fetchSnapshot: async () => snapshot } };
}
function failingResolution(error: unknown): MemoryDiagnosticsGatewayResolution {
  return { available: true, gateway: { fetchSnapshot: async () => { throw error; } } };
}

describe('classifyMemoryDiagnosticsError', () => {
  test('501 and 404 are "does not serve memory diagnostics"', () => {
    const f501 = classifyMemoryDiagnosticsError(new GoodVibesSdkError('x', { status: 501 }));
    expect(f501).toEqual({ kind: 'unavailable', reason: MEMORY_DIAGNOSTICS_UNAVAILABLE });
    expect(classifyMemoryDiagnosticsError(new GoodVibesSdkError('x', { status: 404 })).kind).toBe('unavailable');
  });
  test('500 / network errors are a generic error', () => {
    expect(classifyMemoryDiagnosticsError(new GoodVibesSdkError('boom', { status: 500 })).kind).toBe('error');
    expect(classifyMemoryDiagnosticsError(new Error('reset')).kind).toBe('error');
  });
});

describe('renderMemoryDiagnostics: mocked daemon (injected resolution)', () => {
  test('available renders the governor snapshot rows', async () => {
    const out = await renderMemoryDiagnostics(readyResolution());
    expect(out).toContain('Health Review: Memory');
    expect(out).toContain('tier: normal');
    expect(out).toContain('budget: 512 MB rss / 4096 MB budget');
  });
  test('unavailable resolution renders the honest reason (no fetch attempted)', async () => {
    const out = await renderMemoryDiagnostics({ available: false, reason: 'the daemon is disabled (daemon.enabled=false)' });
    expect(out).toContain('memory diagnostics unavailable: the daemon is disabled');
  });
  test('a 501 renders "daemon does not serve memory diagnostics"', async () => {
    const out = await renderMemoryDiagnostics(failingResolution(new GoodVibesSdkError('no governor', { status: 501 })));
    expect(out).toContain('does not serve memory diagnostics');
  });
  test('a network error renders an honest read failure, not empty state', async () => {
    const out = await renderMemoryDiagnostics(failingResolution(new Error('connection reset')));
    expect(out).toContain('could not read memory diagnostics');
    expect(out).toContain('connection reset');
  });
});

describe('createMemoryDiagnosticsGateway: resolution', () => {
  test('refuses honestly when the daemon is disabled', () => {
    const resolution = createMemoryDiagnosticsGateway({
      configManager: { get: (k: string) => (k === 'daemon.enabled' ? false : undefined) } as never,
      homeDirectory: '/home/test',
    });
    expect(resolution.available).toBe(false);
    if (!resolution.available) expect(resolution.reason).toContain('daemon is disabled');
  });
});

// --- OPS_MEMORY_PRESSURE -> notice bridge ---
type OpsCb = (envelope: { type: string; ts: number; traceId?: string; payload: unknown }) => void;
function fakeBus() {
  let opsCb: OpsCb | null = null;
  return {
    bus: { onDomain: (domain: string, cb: OpsCb) => { if (domain === 'ops') opsCb = cb; return () => { opsCb = null; }; } },
    emitOps: (envelope: { type: string; ts: number; traceId?: string; payload: unknown }) => opsCb?.(envelope),
  };
}

describe('wireMemoryPressureNotice', () => {
  test('lifts OPS_MEMORY_PRESSURE into a notice and ignores other ops events', () => {
    const dispatched: Array<{ level: string; title: string; domain: string }> = [];
    const dispatcher = { dispatch: (n: { level: string; title: string; domain: string }) => { dispatched.push(n); return { target: 'panel_only' } as never; } };
    const { bus, emitOps } = fakeBus();
    wireMemoryPressureNotice(bus as never, dispatcher as never);

    // An unrelated ops event is ignored.
    emitOps({ type: 'OPS_AUDIT', ts: 1, payload: { action: 'x' } });
    expect(dispatched).toHaveLength(0);

    // A high-tier pressure event surfaces as a warning notice.
    emitOps({ type: 'OPS_MEMORY_PRESSURE', ts: 2, traceId: 't1', payload: { type: 'OPS_MEMORY_PRESSURE', tier: 'high', previousTier: 'elevated', rssMb: 3600, heapMb: 900, budgetMb: 4096, usedPct: 88 } });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.domain).toBe('ops');
    expect(dispatched[0]!.level).toBe('warning');
    expect(dispatched[0]!.title).toContain('memory pressure: elevated → high');

    // A tripwire firing escalates to critical.
    emitOps({ type: 'OPS_MEMORY_PRESSURE', ts: 3, payload: { type: 'OPS_MEMORY_PRESSURE', tier: 'critical', previousTier: 'high', rssMb: 3900, heapMb: 950, budgetMb: 4096, usedPct: 95, tripwire: { rateMbPerSec: 40, sustainedSec: 60, action: 'exit' } } });
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]!.level).toBe('critical');
    expect(dispatched[1]!.title).toContain('leak tripwire fired');
  });
});

// --- /health memory command wire ---
function makeCtx(configGet?: (key: string) => unknown): CommandContext & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    openModal: () => {},
    workspace: {
      shellPaths: { homeDirectory: '/home/test', workingDirectory: '/work', resolveProjectPath: (...a: string[]) => a.join('/'), resolveUserPath: (...a: string[]) => a.join('/') },
    },
    platform: {
      configManager: { get: (key: string) => (configGet ? configGet(key) : undefined), setDynamic: () => {} },
      readModels: {},
    },
  } as unknown as CommandContext & { printed: string[] };
}

describe('/health memory: command wire', () => {
  test('honestly reports the daemon disabled rather than fabricating a snapshot', async () => {
    const registry = new CommandRegistry();
    registerHealthRuntimeCommands(registry);
    const ctx = makeCtx((key) => (key === 'daemon.enabled' ? false : undefined));
    await registry.get('health')!.handler(['memory'], ctx);
    const text = ctx.printed.join('\n');
    expect(text).toContain('Health Review: Memory');
    expect(text).toContain('memory diagnostics unavailable');
    expect(text).toContain('daemon is disabled');
  });
});
