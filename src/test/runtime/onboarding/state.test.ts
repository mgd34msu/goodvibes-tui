import { beforeEach, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';
import {
  readOnboardingRuntimeState,
  writeOnboardingAcknowledgementState,
} from '@/runtime/onboarding/state.ts';
import type { OnboardingShellPaths } from '@/runtime/onboarding/types.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeShellPaths(base: string): OnboardingShellPaths {
  return {
    workingDirectory: base,
    resolveProjectPath: (...segments: string[]) => join(base, 'project', ...segments),
    resolveUserPath: (...segments: string[]) => join(base, 'user', ...segments),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('onboarding state', () => {
  let tmpDir: string;
  let shellPaths: OnboardingShellPaths;

  beforeEach(() => {
    tmpDir = makeProjectTempDir('gv-ob-state');
    shellPaths = makeShellPaths(tmpDir);
  });

  // ── read — missing file ─────────────────────────────────────────────────

  test('readOnboardingRuntimeState returns exists:false for missing file', () => {
    const result = readOnboardingRuntimeState(shellPaths, 'project');
    expect(result.exists).toBe(false);
    expect(result.payload).toBeNull();
  });

  // ── round-trip ──────────────────────────────────────────────────────────

  test('write + read round-trips a single acknowledgement', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers',
      acknowledged: true,
      source: 'test',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    expect(result.exists).toBe(true);
    expect(result.payload).not.toBeNull();
    expect(result.payload!.acknowledgements['providers']).toBe(true);
    expect(result.payload!.version).toBe(1);
    expect(result.payload!.source).toBe('test');
  });

  test('write + read round-trips multiple acknowledgements independently', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'test',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'subscriptions', acknowledged: true, source: 'test',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'auth', acknowledged: false, source: 'test',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    expect(result.payload!.acknowledgements['providers']).toBe(true);
    expect(result.payload!.acknowledgements['subscriptions']).toBe(true);
    expect(result.payload!.acknowledgements['auth']).toBe(false);
  });

  test('second write merges with existing acknowledgements (no lost updates)', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'first',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'subscriptions', acknowledged: true, source: 'second',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    // providers must survive the second write
    expect(result.payload!.acknowledgements['providers']).toBe(true);
    expect(result.payload!.acknowledgements['subscriptions']).toBe(true);
  });

  // ── scope — user vs project ─────────────────────────────────────────────

  test('user-scope and project-scope are independent files', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'test', scope: 'user',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: false, source: 'test', scope: 'project',
    });

    const user = readOnboardingRuntimeState(shellPaths, 'user');
    const project = readOnboardingRuntimeState(shellPaths, 'project');
    expect(user.payload!.acknowledgements['providers']).toBe(true);
    expect(project.payload!.acknowledgements['providers']).toBe(false);
  });

  // ── readVersioned integration: corrupt + unknown version ────────────────

  test('corrupt JSON is quarantined and read returns null payload', () => {
    // Pre-create directory so writeFileSync can place the corrupt file.
    const stateDir = join(tmpDir, 'project', 'tui');
    mkdirSync(stateDir, { recursive: true });
    const statePath = join(stateDir, 'onboarding-state.json');
    writeFileSync(statePath, '{ bad json }}');

    const result = readOnboardingRuntimeState(shellPaths, 'project');
    expect(result.payload).toBeNull();
    expect(result.parseError).toContain('quarantined');
    // Original file must be gone (quarantined).
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(`${statePath}.unrecognized`)).toBe(true);
  });

  test('unknown future version is quarantined and read returns null payload', () => {
    const stateDir = join(tmpDir, 'project', 'tui');
    mkdirSync(stateDir, { recursive: true });
    const statePath = join(stateDir, 'onboarding-state.json');
    writeFileSync(statePath, JSON.stringify({ version: 999, updatedAt: Date.now(), source: 'future', acknowledgements: {} }));

    const result = readOnboardingRuntimeState(shellPaths, 'project');
    expect(result.payload).toBeNull();
    expect(existsSync(`${statePath}.unrecognized`)).toBe(true);
  });

  // ── concurrent RMW simulation ───────────────────────────────────────────
  //
  // Simulates two interleaved RMW sequences by running two writes to different
  // targets without any mocking. Both acknowledgements must survive because the
  // lockfile serialises the RMW window. We sequence them synchronously in a
  // single process (daemon and TUI are both synchronous at the RMW point), so
  // a genuine concurrent test would require two child processes. Instead, we
  // verify the merge property: neither write clobbers the other's key.

  test('concurrent RMW simulation: both acks survive sequential interleaved writes', () => {
    // Simulate process A (daemon) writing 'providers'
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'daemon',
    });

    // Simulate process B (TUI) writing 'auth' immediately after
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'auth', acknowledged: true, source: 'tui',
    });

    // Both acks must be present in the final file.
    const result = readOnboardingRuntimeState(shellPaths);
    expect(result.payload!.acknowledgements['providers']).toBe(true);
    expect(result.payload!.acknowledgements['auth']).toBe(true);
  });

  test('concurrent RMW simulation: later write wins on same target', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'first',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: false, source: 'second',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    // Last writer wins on same key.
    expect(result.payload!.acknowledgements['providers']).toBe(false);
  });

  // ── lock primitive tests ────────────────────────────────────────────────

  test('stale lockfile is taken over and write succeeds', () => {
    // Write an initial ack so there is a state file to lock against.
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'setup',
    });

    // Create the lockfile and backdate its mtime by 6s (> LOCK_STALE_MS=5s).
    const stateDir = join(tmpDir, 'project', 'tui');
    const lockPath = join(stateDir, 'onboarding-state.json.lock');
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    const staleTs = new Date(Date.now() - 6_000);
    utimesSync(lockPath, staleTs, staleTs);

    // Despite the lockfile existing, writeOnboardingAcknowledgementState must
    // take over the stale lock and complete successfully.
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'subscriptions', acknowledged: true, source: 'stale-lock-test',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    expect(result.payload!.acknowledgements['subscriptions']).toBe(true);
    // Stale lock should have been removed (or replaced and released).
    expect(existsSync(lockPath)).toBe(false);
  });

  test('write succeeds (degraded path) when a fresh lockfile blocks all retries', () => {
    // Pre-place a fresh lockfile to simulate another process holding the lock
    // for longer than the retry budget. The writer must fall through to the
    // degraded path and still complete the write.
    const stateDir = join(tmpDir, 'project', 'tui');
    mkdirSync(stateDir, { recursive: true });
    const lockPath = join(stateDir, 'onboarding-state.json.lock');
    // Use 'w' (not 'wx') so this succeeds even if file exists.
    const fd = openSync(lockPath, 'w');
    closeSync(fd);

    // Write should still complete (degraded path — atomic write fires without lock).
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'auth', acknowledged: true, source: 'degraded-path-test',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    expect(result.payload!.acknowledgements['auth']).toBe(true);
  });
});
