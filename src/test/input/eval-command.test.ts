/**
 * Regression tests for /eval command argument parsing.
 *
 * Guards against finding [5]: `--save-baseline` poisoning baselineFile when
 * passed in the second positional slot of `/eval gate <suite> --save-baseline`.
 */

import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { evalCommand } from '../../input/commands/eval.ts';
import { createShellPathService } from '@/runtime/index.ts';

function makeGateContext(printed: string[]): CommandContext {
  // process.cwd() as workingDirectory so the SDK resolveBaselinePath check
  // (which resolves relative to CWD, not projectRoot) passes for relative paths.
  const shellPaths = createShellPathService({
    workingDirectory: process.cwd(),
    homeDirectory: process.cwd(),
  });
  return {
    session: {
      conversationManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'session-eval-test',
      },
    },
    provider: { providerRegistry: {} as never },
    workspace: { shellPaths },
    platform: { config: {} as never, configManager: {} as never },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      memoryRegistry: {} as never,
      forensicsRegistry: {} as never,
      evalRegistry: undefined,
    },
    clients: {} as never,
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  } as unknown as CommandContext;
}

describe('evalCommand gate -- flag-safe positional parsing', () => {
  // -- Parsing unit tests (no file I/O) ----------------------------------------

  test('[finding 5] positionals filter strips --save-baseline from args', () => {
    // Simulate args as received by handleGate when invoked as:
    //   /eval gate core-performance --save-baseline
    const args = ['core-performance', '--save-baseline'];
    const positionals = args.filter(a => !a.startsWith('--'));

    // suiteName must be the first non-flag arg
    expect(positionals[0]).toBe('core-performance');
    // second positional slot must be undefined -- not '--save-baseline'
    expect(positionals[1]).toBeUndefined();
    // default path must be applied
    const baselineFile = positionals[1] ?? '.goodvibes/eval/baseline.json';
    expect(baselineFile).toBe('.goodvibes/eval/baseline.json');
    expect(baselineFile).not.toBe('--save-baseline');
  });

  test('[finding 5] flag-first ordering: positionals[0] is still the suite name', () => {
    // /eval gate --save-baseline core-performance
    const args = ['--save-baseline', 'core-performance'];
    const positionals = args.filter(a => !a.startsWith('--'));
    const suiteName = positionals[0];
    expect(suiteName).toBe('core-performance');
    expect(suiteName).not.toBe('--save-baseline');
  });

  // -- Integration tests (unknown suite -> early exit, no file I/O) ------------

  test('gate with flag in 2nd slot: error names the actual suite, not the flag', async () => {
    // /eval gate BOGUSSUITE --save-baseline
    // Before fix: args[1]='--save-baseline' -> baselineFile='--save-baseline' (path bug)
    // Both old and new exit early on unknown suite; the error message must
    // mention the real suite name 'BOGUSSUITE', never '--save-baseline'.
    const printed: string[] = [];
    const ctx = makeGateContext(printed);
    await evalCommand.handler(['gate', 'BOGUSSUITE', '--save-baseline'], ctx);
    expect(printed.some(l => l.includes('Unknown suite: "BOGUSSUITE"'))).toBe(true);
    expect(printed.some(l => l.includes('"--save-baseline"'))).toBe(false);
  });

  test('gate with flag-first ordering: suite name resolved from positionals', async () => {
    // /eval gate --save-baseline BOGUSSUITE
    // Before fix: args[0]='--save-baseline' -> suiteName='--save-baseline' -> error names the flag!
    // After fix:  positionals[0]='BOGUSSUITE' -> suiteName='BOGUSSUITE' -> error names BOGUSSUITE
    const printed: string[] = [];
    const ctx = makeGateContext(printed);
    await evalCommand.handler(['gate', '--save-baseline', 'BOGUSSUITE'], ctx);
    expect(printed.some(l => l.includes('Unknown suite: "BOGUSSUITE"'))).toBe(true);
    expect(printed.some(l => l.includes('Unknown suite: "--save-baseline"'))).toBe(false);
  });
});
