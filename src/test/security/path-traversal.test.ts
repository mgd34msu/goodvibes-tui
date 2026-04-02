/**
 * Security: Path traversal detection.
 *
 * Verifies that path escape attempts are detected and blocked
 * at the safety check layer, and that benign paths pass through.
 */

import { describe, test, expect } from 'bun:test';
import { runSafetyChecks } from '../../runtime/permissions/safety-checks.ts';
import { LayeredPolicyEvaluator } from '../../runtime/permissions/evaluator.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PATH_TOOLS = ['read', 'write', 'edit', 'file_read', 'file_write', 'file_edit', 'find', 'glob', 'list_dir'] as const;

function checkPath(toolName: string, path: string) {
  return runSafetyChecks(toolName, { path });
}

// ---------------------------------------------------------------------------
// Path traversal — safety checks
// ---------------------------------------------------------------------------

describe('security: path traversal', () => {
  describe('double-dot traversal sequences are blocked', () => {
    const TRAVERSAL_PATHS = [
      '/project/../../etc/passwd',
      '/home/user/../../../etc/shadow',
      '/../../../root/.ssh/id_rsa',
      '/var/www/app/../../../../../../etc/passwd',
    ];

    for (const tool of PATH_TOOLS) {
      for (const traversalPath of TRAVERSAL_PATHS) {
        test(`tool "${tool}" with "${traversalPath}" is blocked`, () => {
          const result = checkPath(tool, traversalPath);
          expect(result.blocked).toBe(true);
          expect(result.reason).toBe('SAFETY_DENY_PATH_ESCAPE');
        });
      }
    }
  });

  describe('null byte injection is blocked', () => {
    const NULL_BYTE_PATHS = [
      '/project/file.ts\0',
      '/tmp/safe\0/etc/passwd',
      '\0etc/shadow',
    ];

    for (const tool of PATH_TOOLS) {
      for (const nullPath of NULL_BYTE_PATHS) {
        test(`tool "${tool}" with null byte path is blocked`, () => {
          const result = checkPath(tool, nullPath);
          expect(result.blocked).toBe(true);
          expect(result.reason).toBe('SAFETY_DENY_PATH_ESCAPE');
        });
      }
    }
  });

  describe('benign paths are not blocked', () => {
    const SAFE_PATHS = [
      '/home/user/project/src/index.ts',
      '/tmp/output.txt',
      './relative/path.ts',
      'src/components/Button.tsx',
      '/var/log/app.log',
    ];

    for (const tool of PATH_TOOLS) {
      for (const safePath of SAFE_PATHS) {
        test(`tool "${tool}" with safe path "${safePath}" is not blocked`, () => {
          const result = checkPath(tool, safePath);
          expect(result.blocked).toBe(false);
        });
      }
    }
  });

  describe('path traversal blocked across all modes via evaluator', () => {
    const MODES = ['default', 'allow-all', 'plan', 'custom'] as const;

    for (const mode of MODES) {
      test(`mode "${mode}" does not allow path traversal for read tool`, () => {
        const evaluator = new LayeredPolicyEvaluator({ mode, rules: [] });
        const decision = evaluator.evaluate('read', { path: '/project/../../etc/passwd' });
        expect(decision.allowed).toBe(false);
        expect(decision.sourceLayer).toBe('safety');
        expect(decision.reason).toBe('SAFETY_DENY_PATH_ESCAPE');
      });
    }
  });

  describe('non-path-class tools are not subject to path checks', () => {
    test('exec tool with traversal-looking arg is not path-escape blocked', () => {
      // exec is not a path-class tool; its arg is a command, not a path.
      // The path escape check should not fire (other checks may fire instead).
      const result = runSafetyChecks('exec', { command: 'cat ../../etc/passwd' });
      // Should not be blocked by path-escape specifically
      if (result.blocked) {
        expect(result.reason).not.toBe('SAFETY_DENY_PATH_ESCAPE');
      } else {
        expect(result.blocked).toBe(false);
      }
    });
  });

  describe('classification on path escape', () => {
    test('path escape classification is "escalation"', () => {
      const result = runSafetyChecks('read', { path: '/project/../../etc/passwd' });
      expect(result.blocked).toBe(true);
      expect(result.classification).toBe('escalation');
    });
  });
});
