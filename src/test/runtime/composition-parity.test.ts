/**
 * Composition-parity gate — pins daemon-vs-interactive wiring facts that the
 * TUI's forked composition roots must keep in step with the SDK's own.
 *
 * These are source-level assertions on purpose: the wiring differences they
 * pin (observed foreign-agent detection, the startup retention sweep, live
 * config-file watching) are either host-nondeterministic to exercise
 * (observed detection scans the real process table / tmux) or lifecycle
 * side-effects with no return value to inspect, so a source pin is the honest,
 * deterministic way to catch a fork that silently drops one of them.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** The argument object literal passed to the first createRuntimeServices call in a file. */
function createRuntimeServicesCallArgs(source: string): string {
  const idx = source.indexOf('createRuntimeServices({');
  expect(idx, 'createRuntimeServices({ ... }) call not found').toBeGreaterThan(-1);
  // Walk from the opening brace to its matching close so we inspect only this
  // call's options, not the rest of the file.
  const open = source.indexOf('{', idx);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced createRuntimeServices call braces');
}

describe('composition parity — observed foreign-agent detection is daemon-side only', () => {
  test('the standalone daemon composes observed agents (observeExternalAgents: true)', () => {
    const args = createRuntimeServicesCallArgs(read('src/daemon/cli.ts'));
    expect(args).toContain('observeExternalAgents: true');
  });

  test('the interactive process does NOT observe (no double-detection; it reads the daemon snapshot)', () => {
    const args = createRuntimeServicesCallArgs(read('src/runtime/bootstrap-core.ts'));
    expect(args).not.toContain('observeExternalAgents');
  });

  test('createRuntimeServices threads the daemon opt-in into the fleet services helper', () => {
    const services = read('src/runtime/services.ts');
    expect(services).toContain('observeExternalAgents: options.observeExternalAgents');
  });

  test('the fleet services helper constructs the observed source only under the opt-in flag', () => {
    const helper = read('src/runtime/fleet-services.ts');
    // Constructed only when opted in (never unconditionally)...
    expect(helper).toMatch(/observeExternalAgents\s*\?\s*new ObservedAgentSource\(\)\s*:\s*undefined/);
    // ...and threaded into the shared registry as the observedAgents dep.
    expect(helper).toContain('observedAgents,');
  });
});

describe('composition parity — retention janitor and live config apply run on TUI-composed runtimes', () => {
  const durability = read('src/runtime/durability-services.ts');

  test('the startup append-only sweep runs with the FULL roots set', () => {
    expect(durability).toContain('runStartupAppendOnlySweep');
    // Every root the SDK passes must be present — omitting any silently skips
    // that store class on every sweep.
    for (const root of ['workingDirectory', 'surfaceRoot', 'homeDirectory', 'logDir', 'telemetryDir']) {
      expect(durability, `sweep root ${root} missing`).toContain(`${root}:`);
    }
  });

  test('live config-file watching is composed (external edits apply without a restart)', () => {
    expect(durability).toContain('configManager.watchConfigFiles()');
  });

  test('services.ts feeds the durability helper the sweep roots', () => {
    const services = read('src/runtime/services.ts');
    expect(services).toContain('surfaceRoot:');
    expect(services).toContain('shellPaths,');
  });
});
