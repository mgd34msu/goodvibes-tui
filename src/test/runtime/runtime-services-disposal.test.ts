/**
 * runtime-services-disposal.test.ts
 *
 * This surface composes its own runtime graph and hands the SAME object to
 * DaemonServer. By the SDK's ownership rule the facade disposes only a graph it
 * built itself, so nothing upstream will ever stop these pollers for us, the
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
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';

import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Modules that own repeating work started by the graph.
 *
 * One repeating handle deliberately survives dispose() and is not listed:
 * `workspace/checkpoint/cross-process-lock`'s 5s mtime refresh, which exists
 * only while the checkpoint manager's async init holds a cross-process lock and
 * ends when that lock is released. It belongs to an operation that was
 * genuinely in flight, not to a subsystem the graph left running, the same
 * distinction the SDK's own daemon-shutdown test draws.
 */
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
  // The inbox retention sweep and the per-account inbound poll loops used to be
  // named here too. They moved to the daemon with the handler surfaces that
  // started them: this process no longer polls a mailbox, so there is no such
  // timer left to survive a dispose().
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

function describe(): string[] {
  return [...live.values()].map((t) => `${t.kind} ${t.delayMs}ms ${siteOf(t.stack)}`);
}

beforeAll(async () => {
  root = makeProjectTempDir('tui-disposal');
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
    // Not every poller is armed by the time the factory returns. The inbox
    // surface starts its store bootstrap without awaiting it and arms the
    // retention sweep two awaits later, so disposing the instant construction
    // returns would measure a timer that does not exist yet and pass for
    // entirely the wrong reason. Wait for it, bounded.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline
      && !describe().some((e) => e.includes('daemon/handlers/inbox/cursor-store'))) {
      await new Promise((resolve) => realSetTimeout(resolve, 25));
    }
    liveBeforeDispose = describe();
    services.dispose();
    liveAfterDispose = describe();
  } finally {
    restore();
  }
}, 30_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test('composing the graph really does start pollers; the measurement is not vacuous', () => {
  const started = liveBeforeDispose.filter((e) => POLLER_OWNERS.some((o) => e.includes(o)));
  expect(created).toBeGreaterThan(5);
  expect(started.length).toBeGreaterThan(0);
});

test('this composition starts no mailbox poller at all', () => {
  // The inverse of the assertion this used to make. The inbox retention sweep
  // was the poller the disposal owner list was missing, and it armed
  // asynchronously so a survivor check alone could pass on a timer that was
  // never created. Now the correct answer is that it is never created here:
  // a second process polling the same mailbox is exactly the double-answer the
  // cluster's single-reader election existed to prevent.
  expect(liveBeforeDispose.filter((e) => e.includes('daemon/handlers/inbox'))).toEqual([]);
});

test('dispose() stops every poller the graph started', () => {
  const survivors = liveAfterDispose.filter((e) => POLLER_OWNERS.some((o) => e.includes(o)));
  expect(survivors).toEqual([]);
});

test('dispose() is idempotent', () => {
  expect(() => { services.dispose(); services.dispose(); }).not.toThrow();
});
