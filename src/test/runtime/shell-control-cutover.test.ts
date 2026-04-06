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
            violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
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

  test('bootstrap and orchestrator do not use render:request for local invalidation', () => {
    const violations: string[] = [];
    const restrictedFiles = [
      'src/runtime/bootstrap.ts',
      'src/core/orchestrator.ts',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('render:request')) {
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: bootstrap/orchestrator reintroduced render:request local invalidation.',
          'Use injected requestRender() callbacks instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('known panel-local repaint files do not emit render:request', () => {
    const violations: string[] = [];
    const restrictedFiles = [
      'src/panels/provider-stats-panel.ts',
      'src/panels/provider-health-panel.ts',
      'src/panels/debug-panel.ts',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('render:request')) {
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: panel-local repaint paths reintroduced render:request.',
          'Use injected requestRender() callbacks instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('typed turn-consumer panels do not subscribe to legacy turn bus events', () => {
    const violations: string[] = [];
    const restrictedFiles = [
      'src/panels/thinking-panel.ts',
      'src/panels/context-visualizer-panel.ts',
      'src/panels/debug-panel.ts',
      'src/panels/provider-stats-panel.ts',
      'src/panels/provider-health-panel.ts',
      'src/panels/cost-tracker-panel.ts',
      'src/main.ts',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("bus.on('turn:") || line.includes('bus.on("turn:')) {
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: typed turn-consumer panels reintroduced legacy turn bus subscriptions.',
          'Use RuntimeEventBus turn events for these panels instead.',
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
    const restrictedFiles = [
      'src/runtime/bootstrap.ts',
      'src/panels/agent-logs-panel.ts',
      'src/panels/cost-tracker-panel.ts',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("bus.on('subagent:") || line.includes('bus.on("subagent:')) {
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
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
    const restrictedFiles = [
      'src/runtime/bootstrap.ts',
      'src/panels/wrfc-panel.ts',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("bus.on('wrfc:") || line.includes('bus.on("wrfc:')) {
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
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
    const restrictedFiles = [
      'src/runtime/bootstrap.ts',
      'src/panels/provider-stats-panel.ts',
      'src/panels/provider-health-panel.ts',
      'src/panels/ops-strategy-panel.ts',
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
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
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
    const restrictedFiles = [
      'src/panels/tool-inspector-panel.ts',
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
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
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
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
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

  test('orchestrator no longer emits legacy turn/tool lifecycle events for runtime-owned flow', () => {
    const relPath = 'src/core/orchestrator.ts';
    const absPath = join(projectRoot, relPath);
    const content = readFileSync(absPath, 'utf8');
    const lines = content.split('\n');
    const violations: string[] = [];
    const forbiddenTokens = [
      'turn:start',
      'turn:llm-response',
      'turn:tool-executing',
      'turn:tool-result',
      'turn:tool-reconciliation',
      'turn:complete',
      'turn:error',
      'turn:stream-start',
      'turn:stream-delta',
      'turn:stream-end',
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('this.bus.emit(')) continue;
      if (forbiddenTokens.some((token) => line.includes(token))) {
        violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: orchestrator reintroduced legacy turn/tool lifecycle emits.',
          'Use RuntimeEventBus turn/tool emitters for runtime-owned flow instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('orchestrator and bootstrap do not use legacy context/cache/helper telemetry events for active runtime flow', () => {
    const violations: string[] = [];
    const restrictedFiles = [
      'src/core/orchestrator.ts',
      'src/runtime/bootstrap.ts',
    ];
    const legacyTokens = [
      'context:warning',
      'cache:metrics',
      'helper:usage',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isLegacyEmit = relPath === 'src/core/orchestrator.ts' && line.includes('this.bus.emit(');
        const isLegacyListener = relPath === 'src/runtime/bootstrap.ts' && line.includes('bus.on(');
        if (!(isLegacyEmit || isLegacyListener)) continue;
        if (legacyTokens.some((token) => line.includes(token))) {
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
        }
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
    const violations: string[] = [];
    const restrictedFiles = [
      'src/agents/orchestrator.ts',
      'src/acp/manager.ts',
      'src/acp/connection.ts',
    ];
    const legacyTokens = [
      'subagent:spawned',
      'subagent:update',
      'subagent:complete',
      'subagent:error',
      'subagent:stream-delta',
      'subagent:progress',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('.emit(')) continue;
        if (legacyTokens.some((token) => line.includes(token))) {
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
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
    const relPath = 'src/agents/wrfc-controller.ts';
    const absPath = join(projectRoot, relPath);
    const content = readFileSync(absPath, 'utf8');
    const lines = content.split('\n');
    const violations: string[] = [];
    const legacyTokens = [
      "from '../core/event-bus.ts'",
      'this.eventBus.',
      'requires EventBus',
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (legacyTokens.some((token) => line.includes(token))) {
        violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
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
    const restrictedFiles = [
      'src/integrations/notifier.ts',
      'src/integrations/webhooks.ts',
    ];

    for (const relPath of restrictedFiles) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('attachToEventBus(')) {
          violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
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

  test('replay engine does not emit replay events through the legacy singleton bus', () => {
    const relPath = 'src/core/deterministic-replay.ts';
    const absPath = join(projectRoot, relPath);
    const content = readFileSync(absPath, 'utf8');
    const lines = content.split('\n');
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('EventBus.getInstance()') || line.includes('replay:loaded') || line.includes('replay:position-changed') || line.includes('replay:diff-complete')) {
        violations.push(`${relPath}:${i + 1} — ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-004 violation: replay engine reintroduced legacy singleton replay event emission.',
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
