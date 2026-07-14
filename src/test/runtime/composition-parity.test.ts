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

  test('createRuntimeServices wires the observed source into the fleet registry only when opted in', () => {
    const services = read('src/runtime/services.ts');
    // The dep is threaded into the shared fleet registry...
    expect(services).toContain('observedAgents,');
    // ...and constructed only under the opt-in flag (never unconditionally).
    expect(services).toMatch(/options\.observeExternalAgents\s*\?\s*new ObservedAgentSource\(\)\s*:\s*undefined/);
  });
});
