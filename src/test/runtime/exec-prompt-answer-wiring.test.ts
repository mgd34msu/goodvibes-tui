import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Composition-parity guard for the interactive-exec prompt-answer wiring.
 *
 * The prompt-answer handler and the loopback-fetch ask are both built ONCE in
 * the services composition (services.ts) and shared. bootstrap-core then (a)
 * registers all tools and (b) calls agentOrchestrator.setDependencies, a
 * WHOLESALE replace that clobbers anything the in-services setDependencies
 * installed. So both fields must be re-passed at BOTH bootstrap-core call sites,
 * or an interactive command (ssh/sudo) that stops on a terminal prompt hangs to
 * timeout with no ask and no card.
 *
 * This test pins execPromptAnswerHandler AND localhostFetchApproval across the
 * tools registration and the post-clobber orchestrator dependencies (the same
 * clobber class that dropped localhostFetchApproval earlier this cycle), so the
 * next dependency threaded through services.ts cannot be silently dropped here.
 */

const ROOT = join(import.meta.dir, '..', '..', '..');

/** Extract the balanced-brace object literal that opens immediately after `marker`. */
function objectLiteralAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf('{', start);
  if (open < 0) throw new Error(`no object literal after: ${marker}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced object literal after: ${marker}`);
}

const REQUIRED_FIELDS = ['execPromptAnswerHandler', 'localhostFetchApproval'] as const;

describe('interactive-exec prompt-answer wiring: bootstrap-core composition parity', () => {
  const bootstrapCore = readFileSync(join(ROOT, 'src/runtime/bootstrap-core.ts'), 'utf8');
  const services = readFileSync(join(ROOT, 'src/runtime/services.ts'), 'utf8');

  const toolsRegistration = objectLiteralAfter(bootstrapCore, 'registerAllTools(toolRegistry,');
  const postClobberDeps = objectLiteralAfter(bootstrapCore, 'services.agentOrchestrator.setDependencies(');

  for (const field of REQUIRED_FIELDS) {
    test(`tools registration passes ${field}`, () => {
      expect(toolsRegistration).toContain(`${field}:`);
    });
    test(`post-clobber orchestrator dependencies pass ${field}`, () => {
      expect(postClobberDeps).toContain(`${field}:`);
    });
  }

  test('services builds and shares a single execPromptAnswerHandler', () => {
    // Built once, exposed on the returned services object, and consumed at BOTH
    // bootstrap-core sites via services.execPromptAnswerHandler.
    expect(services).toContain('const execPromptAnswerHandler = buildExecPromptAnswerHandler(');
    expect(bootstrapCore).toContain('services.execPromptAnswerHandler');
  });
});
