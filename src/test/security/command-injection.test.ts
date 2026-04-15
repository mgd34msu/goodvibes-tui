/**
 * Security: Command injection and normalization.
 *
 * Verifies that the command normalization pipeline correctly detects
 * injected destructive segments in compound commands and that the
 * classifier assigns highest-risk classification to such commands.
 */

import { describe, test, expect } from 'bun:test';
import { classifySegment, classifyCommand, higherPriority } from '@pellux/goodvibes-sdk/platform/runtime/permissions/normalization/classifier';
import { canonicalize } from '@pellux/goodvibes-sdk/platform/runtime/permissions/normalization/canonicalizer';
import type { CommandSegment } from '@pellux/goodvibes-sdk/platform/runtime/permissions/normalization/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSegment(partial: Partial<CommandSegment> & { command: string }): CommandSegment {
  return {
    args: [],
    flags: [],
    tokens: [],
    raw: partial.command,
    operator: undefined,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Classification of destructive base commands
// ---------------------------------------------------------------------------

describe('security: command injection', () => {
  describe('classifySegment — destructive base commands', () => {
    test('rm classifies as destructive', () => {
      expect(classifySegment(makeSegment({ command: 'rm', args: ['/tmp/file'] }))).toBe('destructive');
    });

    test('shred classifies as destructive', () => {
      expect(classifySegment(makeSegment({ command: 'shred' }))).toBe('destructive');
    });

    test('dd classifies as destructive', () => {
      expect(classifySegment(makeSegment({ command: 'dd' }))).toBe('destructive');
    });

    test('mkfs classifies as destructive', () => {
      expect(classifySegment(makeSegment({ command: 'mkfs' }))).toBe('destructive');
    });

    test('kill classifies as destructive', () => {
      expect(classifySegment(makeSegment({ command: 'kill', flags: ['-9'], args: ['1'] }))).toBe('destructive');
    });
  });

  describe('classifySegment — sudo wrapping elevates classification', () => {
    test('sudo ls is at least escalation', () => {
      const seg = makeSegment({ command: 'sudo', args: ['ls'], raw: 'sudo ls' });
      const cls = classifySegment(seg);
      expect(['escalation', 'destructive']).toContain(cls);
    });

    test('sudo rm is destructive (inner command takes priority)', () => {
      const seg = makeSegment({ command: 'sudo', args: ['rm', '-rf', '/'], flags: [], raw: 'sudo rm -rf /' });
      const cls = classifySegment(seg);
      expect(cls).toBe('destructive');
    });

    test('sudo docker is escalation', () => {
      const seg = makeSegment({ command: 'sudo', args: ['docker', 'run', 'ubuntu'], raw: 'sudo docker run ubuntu' });
      const cls = classifySegment(seg);
      expect(['escalation', 'destructive']).toContain(cls);
    });
  });

  describe('classifyCommand — compound command injection', () => {
    test('ls && rm: highest classification is destructive', () => {
      const segments: CommandSegment[] = [
        makeSegment({ command: 'ls', args: ['/tmp'], raw: 'ls /tmp' }),
        makeSegment({ command: 'rm', args: ['-rf', '/'], flags: ['-rf'], raw: 'rm -rf /' }),
      ];
      const result = classifyCommand('ls /tmp && rm -rf /', segments);
      expect(result.highestClassification).toBe('destructive');
    });

    test('echo hello | rm: highest classification is destructive', () => {
      const segments: CommandSegment[] = [
        makeSegment({ command: 'echo', args: ['hello'], raw: 'echo hello' }),
        makeSegment({ command: 'rm', args: ['/etc/passwd'], raw: 'rm /etc/passwd' }),
      ];
      const result = classifyCommand('echo hello | rm /etc/passwd', segments);
      expect(result.highestClassification).toBe('destructive');
    });

    test('git status && DROP TABLE: hasDangerousPatterns detected', () => {
      const segments: CommandSegment[] = [
        makeSegment({ command: 'git', args: ['status'], raw: 'git status' }),
        makeSegment({ command: 'DROP TABLE users', args: [], raw: 'DROP TABLE users' }),
      ];
      const result = classifyCommand('git status && DROP TABLE users', segments);
      // SQL pattern matched in raw
      expect(result.hasDangerousPatterns).toBe(true);
    });

    test('npm run build: classifies as write (not destructive)', () => {
      const segments: CommandSegment[] = [
        makeSegment({ command: 'npm', args: ['run', 'build'], raw: 'npm run build' }),
      ];
      const result = classifyCommand('npm run build', segments);
      expect(result.highestClassification).toBe('write');
      expect(result.hasDangerousPatterns).toBe(false);
    });

    test('empty segments: defaults to read', () => {
      const result = classifyCommand('', []);
      expect(result.highestClassification).toBe('read');
      expect(result.hasDangerousPatterns).toBe(false);
    });
  });

  describe('classifyCommand — dangerous pattern flags', () => {
    test('rm -rf flags dangerous pattern', () => {
      const seg = makeSegment({ command: 'rm', flags: ['-r', '-f'], args: ['/home/user'], raw: 'rm -r -f /home/user' });
      const result = classifyCommand('rm -r -f /home/user', [seg]);
      expect(result.hasDangerousPatterns).toBe(true);
    });

    test('git reset --hard flags dangerous pattern', () => {
      const seg = makeSegment({ command: 'git', args: ['reset'], flags: ['--hard'], raw: 'git reset --hard' });
      const result = classifyCommand('git reset --hard', [seg]);
      expect(result.hasDangerousPatterns).toBe(true);
    });

    test('git push --force flags dangerous pattern', () => {
      const seg = makeSegment({ command: 'git', args: ['push', 'origin', 'main'], flags: ['--force'], raw: 'git push --force origin main' });
      const result = classifyCommand('git push --force origin main', [seg]);
      expect(result.hasDangerousPatterns).toBe(true);
    });

    test('docker exec flags dangerous pattern', () => {
      const seg = makeSegment({ command: 'docker', args: ['exec', 'mycontainer', 'bash'], raw: 'docker exec mycontainer bash' });
      const result = classifyCommand('docker exec mycontainer bash', [seg]);
      expect(result.hasDangerousPatterns).toBe(true);
    });
  });

  describe('canonicalize — command token normalization', () => {
    test('strips surrounding double quotes from command token', () => {
      // canonicalize takes a single command token (e.g. the command name)
      expect(canonicalize('"rm"')).toBe('rm');
    });

    test('strips surrounding single quotes from command token', () => {
      expect(canonicalize("'ls'")).toBe('ls');
    });

    test('strips leading env variable prefix, returns command', () => {
      expect(canonicalize('FOO=bar ls')).toBe('ls');
    });

    test('lowercases command name', () => {
      expect(canonicalize('RM')).toBe('rm');
    });

    test('strips path prefix to bare command name', () => {
      expect(canonicalize('/usr/bin/rm')).toBe('rm');
    });

    test('empty string returns empty string', () => {
      expect(canonicalize('')).toBe('');
    });

    test('returns bare name for relative path command', () => {
      expect(canonicalize('./scripts/deploy.sh')).toBe('deploy.sh');
    });
  });

  describe('higherPriority — classification precedence', () => {
    test('destructive beats escalation', () => {
      expect(higherPriority('destructive', 'escalation')).toBe('destructive');
    });

    test('escalation beats network', () => {
      expect(higherPriority('escalation', 'network')).toBe('escalation');
    });

    test('network beats write', () => {
      expect(higherPriority('network', 'write')).toBe('network');
    });

    test('write beats read', () => {
      expect(higherPriority('write', 'read')).toBe('write');
    });

    test('same classification returns itself', () => {
      expect(higherPriority('read', 'read')).toBe('read');
      expect(higherPriority('destructive', 'destructive')).toBe('destructive');
    });
  });
});
