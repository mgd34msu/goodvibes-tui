/**
 * runtime-services-disposal.test.ts
 *
 * This surface composes its own runtime graph and hands the SAME object to
 * DaemonServer. By the SDK's ownership rule the facade disposes only a graph it
 * built itself, so nothing upstream will ever stop these pollers for us — the
 * shutdown paths here (daemon/cli.ts, main.ts's teardown registry, the one-shot
 * CLI commands) are the only thing that can.
 *
 * createRuntimeServices() starts a config-file watch (250ms), a fleet registry
 * tick (750ms), the memory governor (5s), the watcher registry, the
 * cross-session orchestration sweep, the orchestration snapshot writer's reap,
 * the knowledge scheduler and the snapshot / append-only / consolidation
 * schedulers. Every one had a stop(); before dispose() existed nothing called
 * them.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';

import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';

/** Modules that own repeating work started by the graph. */
const POLLER_OWNERS = [
  'config/config-file-watcher',
  'runtime/fleet/registry',
  'runtime/memory/memory-governor',
  'watchers/registry',
  'sessions/orchestration/registry',
  'orchestration/persistence',
  'state/store-snapshots',
  'runtime/retention/append-only-registry',
  'state/memory-consolidation-scheduler',
  'knowledge/scheduling',
  'agents/wrfc-controller',
] as const;

interface Tracked { readonly kind: 'interval' | 'timeout'; readonly delayMs: number; readonly stack: string }

const live = new Map<unknown, Tracked>();
let created = 0;

const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearInterval = globalThis.clearInterval;
const realClearTimeout = globalThis.clearTimeout;

/** Timeouts are tracked too: three of the schedulers are self-rescheduling setTimeout chains. */
function install(): void {
  globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const handle = realSetInterval(fn as never, ms as never, ...(rest as never[]));
    created += 1;
    live.set(handle, { kind: 'interval', delayMs: ms ?? 0, stack: new Error().stack ?? '' });
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    let handle: unknown;
    const wrapped = (...a: unknown[]): void => { live.delete(handle); (fn as (...x: unknown[]) => void)(...a); };
    handle = realSetTimeout(wrapped as never, ms as never, ...(rest as never[]));
    created += 1;
    live.set(handle, { kind: 'timeout', delayMs: ms ?? 0, stack: new Error().stack ?? '' });
    return handle as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearInterval = ((h: never) => { live.delete(h); return realClearInterval(h); }) as typeof globalThis.clearInterval;
  globalThis.clearTimeout = ((h: never) => { live.delete(h); return realClearTimeout(h); }) as typeof globalThis.clearTimeout;
}

function restore(): void {
  globalThis.setInterval = realSetInterval;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearInterval = realClearInterval;
  globalThis.clearTimeout = realClearTimeout;
}

function siteOf(stack: string): string {
  for (const line of stack.split('\n').slice(2)) {
    const match = /([^\s()]+\.(?:ts|tsx|js|mjs)):\d+:\d+/.exec(line);
    if (!match) continue;
    if (/runtime-services-disposal|node:internal/.test(line)) continue;
    const fn = /at\s+(?:async\s+)?([^\s(]+)\s*\(/.exec(line)?.[1] ?? '';
    return `${fn} (${match[1].replace(/^.*\/(src|packages|dist)\//, '$1/')})`;
  }
  return '<unknown site>';
}

let root: string;
let services: RuntimeServices;
let liveBeforeDispose: string[] = [];
let liveAfterDispose: string[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tui-disposal-'));
  install();
  try {
    services = createRuntimeServices({
      configManager: new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, 'cfg'), workingDir: root, homeDir: root }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      workingDir: root,
      homeDirectory: root,
      getConversationTitle: () => 'disposal-test',
    });
    liveBeforeDispose = [...live.values()].map((t) => `${t.kind} ${t.delayMs}ms ${siteOf(t.stack)}`);
    services.dispose();
    liveAfterDispose = [...live.values()].map((t) => `${t.kind} ${t.delayMs}ms ${siteOf(t.stack)}`);
  } finally {
    restore();
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test('composing the graph really does start pollers — the measurement is not vacuous', () => {
  const started = liveBeforeDispose.filter((e) => POLLER_OWNERS.some((o) => e.includes(o)));
  expect(created).toBeGreaterThan(5);
  expect(started.length).toBeGreaterThan(0);
});

test('dispose() stops every poller the graph started', () => {
  const survivors = liveAfterDispose.filter((e) => POLLER_OWNERS.some((o) => e.includes(o)));
  expect(survivors).toEqual([]);
});

test('dispose() is idempotent', () => {
  expect(() => { services.dispose(); services.dispose(); }).not.toThrow();
});
