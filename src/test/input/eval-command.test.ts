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
