/**
 * GC-ARCH-004: Shell control cutover enforcement.
 *
 * These legacy shell control events have been replaced by direct controller
 * callbacks and must not reappear in production call sites:
 * - input:submit
 * - cancel:generation
 * - model-picker:complete
 * - command:model-changed
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

function walkTs(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'test') continue;
      walkTs(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const FORBIDDEN_EVENTS = [
  'input:submit',
  'cancel:generation',
  'model-picker:complete',
  'command:model-changed',
  'clear:screen',
  'session:resume',
  'plan:activate',
];

describe('GC-ARCH-004: shell control cutover enforcement', () => {
  const projectRoot = join(import.meta.dir, '../../..');
  const srcDir = join(projectRoot, 'src');
  const files = walkTs(srcDir);

  test('forbidden legacy shell control events do not appear in production call sites', () => {
    const violations: string[] = [];

    for (const absPath of files) {
      const relPath = relative(projectRoot, absPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const eventName of FORBIDDEN_EVENTS) {
          if (line.includes(eventName)) {
            violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: legacy shell control event reference(s) detected in production code.',
          'Use direct controller callbacks or typed/store-owned flow instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('legacy EventBus module is removed from the runtime tree', () => {
    const legacyBusPaths = [
      'src/core/event-bus.ts',
      'src/core/event-bus.test.ts',
    ];
    const present = legacyBusPaths.filter((relPath) => existsSync(join(projectRoot, relPath)));
    expect(present).toEqual([]);
  });

  test('bootstrap does not use render:request for local invalidation', () => {
    const violations: string[] = [];
    // Orchestrator itself is the SDK's (`@pellux/goodvibes-sdk/platform/core`);
    // this repo carries no local copy for a content check to read.
    const restrictedFiles = [
      'src/runtime/bootstrap.ts',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('render:request')) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: bootstrap reintroduced render:request local invalidation.',
          'Use injected requestRender() callbacks instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('known view-local repaint files do not emit render:request', () => {
    const violations: string[] = [];
    // (the purge): the debug view file was DELETE-disposition and no longer
    // exists, removed from this list (a deleted file trivially can't emit
    // render:request).
    // (config-modal migration, same wave): the provider-health view file was
    // migrated to a config-modal surface and deleted, removed from this
    // list for the same reason.
    const restrictedFiles: string[] = [];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('render:request')) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: view-local repaint paths reintroduced render:request.',
          'Use injected requestRender() callbacks instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('typed turn-consumer views do not subscribe to legacy turn bus events', () => {
    const violations: string[] = [];
    // (the purge): the thinking and debug view files were
    // DELETE-disposition and no longer exist, removed from this list (a
    // deleted file trivially can't subscribe to anything).
    // (config-modal migration, same wave): the provider-health view file was
    // migrated to a config-modal surface and deleted, removed from this
    // list for the same reason.
    const restrictedFiles = [
      // The token-budget and cost-tracker views were replaced by the Usage
      // modal; its always-on data source, usage-tracker.ts, inherits the ban.
      'src/runtime/usage-tracker.ts',
      'src/main.ts',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("bus.on('turn:") || line.includes('bus.on("turn:')) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: typed turn-consumer views reintroduced legacy turn bus subscriptions.',
          'Use RuntimeEventBus turn events for these views instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('typed agent-consumer files do not subscribe to legacy subagent bus events', () => {
    const violations: string[] = [];
    // (the purge): the agent-inspector view file ('inspector') was
    // RETIRE-INTO-FLEET and no longer exists, removed from this list.
    const restrictedFiles = [
      'src/runtime/bootstrap.ts',
      // Successor of the old cost-tracker view's per-agent cost ledger.
      'src/runtime/usage-tracker.ts',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("bus.on('subagent:") || line.includes('bus.on("subagent:')) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: typed agent-consumer files reintroduced legacy subagent bus subscriptions.',
          'Use RuntimeEventBus agent events for these files instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('WRFC typed-consumer files do not subscribe to legacy wrfc bus events', () => {
    const violations: string[] = [];
    // (the purge): the WRFC view file was RETIRE-INTO-FLEET and no longer
    // exists, removed from this list.
    const restrictedFiles = [
      'src/runtime/bootstrap.ts',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("bus.on('wrfc:") || line.includes('bus.on("wrfc:')) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: WRFC typed-consumer files reintroduced legacy wrfc bus subscriptions.',
          'Use RuntimeEventBus workflow events for these files instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('provider and planner typed-consumer files do not subscribe to legacy provider/planner bus events', () => {
    const violations: string[] = [];
    // (the purge): the ops-strategy view file ('ops') was RETIRE-INTO-FLEET
    // and no longer exists, removed from this list.
    // (config-modal migration, same wave): the provider-health view file was
    // migrated to a config-modal surface and deleted, removed from this
    // list for the same reason.
    const restrictedFiles = [
      'src/runtime/bootstrap.ts',
    ];
    const legacyTokens = [
      "providers:changed",
      "model:fallback",
      "plan:strategy-selected",
      "plan:strategy-override",
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('bus.on(') && !line.includes('.on(')) continue;
        if (legacyTokens.some((token) => line.includes(token))) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: provider/planner typed-consumer files reintroduced legacy bus subscriptions.',
          'Use RuntimeEventBus provider/planner events for these files instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('tool typed-consumer files do not subscribe to legacy tool bus events', () => {
    const violations: string[] = [];
    // (the purge): the tool-inspector view file ('tools') was
    // DELETE-disposition and no longer exists, removed from this list.
    const restrictedFiles = [
      'src/main.ts',
    ];
    const legacyTokens = [
      'turn:tool-executing',
      'turn:tool-result',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('bus.on(') && !line.includes('.on(')) continue;
        if (legacyTokens.some((token) => line.includes(token))) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: tool typed-consumer files reintroduced legacy tool bus subscriptions.',
          'Use RuntimeEventBus tool events for these files instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('input command routing does not emit legacy command/bookmark/scroll relay events', () => {
    const violations: string[] = [];
    const restrictedFiles = [
      'src/input/commands.ts',
      'src/input/handler.ts',
    ];
    const legacyTokens = [
      'command:execute',
      'bookmark:jump',
      'scroll:to',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('.emit(')) continue;
        if (legacyTokens.some((token) => line.includes(token))) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: input command routing reintroduced legacy command/bookmark/scroll relays.',
          'Use direct CommandContext callbacks instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('orchestrator is the SDK\'s, not a local re-implementation the repo could regress', () => {
    // The enforcement this test used to run, reading src/core/orchestrator.ts's
    // content for legacy turn/tool lifecycle emits, has nothing left to read:
    // Orchestrator is `@pellux/goodvibes-sdk/platform/core`'s own class, and the
    // SDK owns that regression check on its own source. This repo only needs to
    // confirm it is not carrying a local re-implementation that could drift.
    expect(existsSync(join(projectRoot, 'src/core/orchestrator.ts'))).toBe(false);
  });

  test('bootstrap does not use legacy context/cache/helper telemetry events for active runtime flow', () => {
    const violations: string[] = [];
    const relPath = 'src/runtime/bootstrap.ts';
    const legacyTokens = [
      'context:warning',
      'cache:metrics',
      'helper:usage',
    ];

    const absPath = join(projectRoot, relPath);
    const content = readFileSync(absPath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('bus.on(')) continue;
      if (legacyTokens.some((token) => line.includes(token))) {
        violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: legacy context/cache/helper telemetry was reintroduced into active runtime flow.',
          'Use typed RuntimeEventBus ops events instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('subagent lifecycle producers and WRFC runtime listener no longer depend on legacy subagent events in production flow', () => {
    const removedLocalProducers = [
      'src/agents/orchestrator.ts',
      'src/acp/manager.ts',
      'src/acp/connection.ts',
    ];
    for (const relPath of removedLocalProducers) {
      const absPath = join(projectRoot, relPath);
      expect(existsSync(absPath)).toBe(false);
    }

    const violations: string[] = [];
    const legacyTokens = [
      'subagent:spawned',
      'subagent:update',
      'subagent:complete',
      'subagent:error',
      'subagent:stream-delta',
      'subagent:progress',
    ];
    const currentTuiSurfaces = [
      'src/runtime/services.ts',
      'src/input/commands/runtime-services.ts',
      // The old operations registrations were replaced
      // by the built-in views and the Agents modal.
      'src/views/builtin-views.ts',
      'src/input/agents-modal.ts',
    ];

    for (const relPath of currentTuiSurfaces) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('.emit(')) continue;
        if (legacyTokens.some((token) => line.includes(token))) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: subagent lifecycle production flow reintroduced legacy subagent event wiring.',
          'Use RuntimeEventBus agent events for active runtime flow instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('WRFC producer-side flow no longer depends on legacy EventBus wiring', () => {
    const removedLocalController = join(projectRoot, 'src/agents/wrfc-controller.ts');
    expect(existsSync(removedLocalController)).toBe(false);

    // The old agent registrations were replaced by
    // the built-in views and the Agents modal; they inherit the ban.
    const relPaths = ['src/views/builtin-views.ts', 'src/input/agents-modal.ts', 'src/shell/view-openers.ts'];
    const violations: string[] = [];
    const legacyTokens = [
      "from '../core/event-bus.ts'",
      'this.eventBus.',
      'requires EventBus',
    ];

    for (const relPath of relPaths) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (legacyTokens.some((token) => line.includes(token))) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: WRFC producer code reintroduced legacy EventBus coupling.',
          'Use RuntimeEventBus agent/workflow events only for WRFC runtime flow.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('notification integrations do not expose legacy EventBus attachment paths', () => {
    const violations: string[] = [];
    const restrictedFiles: string[] = [];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('attachToEventBus(')) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: notification integrations reintroduced legacy EventBus attachment paths.',
          'Use RuntimeEventBus attachment only.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('replay engine does not emit replay events through the legacy global bus path', () => {
    const resolvedPath = import.meta.resolve('@pellux/goodvibes-sdk/platform/core');
    const absPath = resolvedPath.startsWith('file:') ? fileURLToPath(resolvedPath) : resolvedPath;
    const relPath = relative(projectRoot, absPath);
    const content = readFileSync(absPath, 'utf8');
    const lines = content.split('\n');
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('EventBus.getInstance()') || line.includes('replay:loaded') || line.includes('replay:position-changed') || line.includes('replay:diff-complete')) {
        violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: replay engine reintroduced legacy global replay event emission.',
          'Use the replay engine subscription model directly instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });
});
