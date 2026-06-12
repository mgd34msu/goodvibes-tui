import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';
import {
  readOnboardingCheckMarker,
  readOnboardingCheckMarkers,
  writeOnboardingCheckMarker,
} from '@/runtime/onboarding/markers.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Minimal shell-paths stub (matches the Pick used inside markers.ts). */
interface MarkerShellPaths {
  workingDirectory: string;
  resolveProjectPath: (...segments: string[]) => string;
  resolveUserPath: (...segments: string[]) => string;
}

function makeShellPaths(base: string): MarkerShellPaths {
  return {
    workingDirectory: base,
    resolveProjectPath: (...segments: string[]) => join(base, 'project', ...segments),
    resolveUserPath: (...segments: string[]) => join(base, 'user', ...segments),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('onboarding markers', () => {
  let tmpDir: string;
  let shellPaths: MarkerShellPaths;

  beforeEach(() => {
    tmpDir = makeProjectTempDir('gv-ob-markers');
    shellPaths = makeShellPaths(tmpDir);
  });

  // ── read — missing file ─────────────────────────────────────────────────

  test('readOnboardingCheckMarker returns exists:false for missing file', () => {
    const result = readOnboardingCheckMarker(shellPaths, 'user');
    expect(result.exists).toBe(false);
    expect(result.payload).toBeNull();
  });

  // ── round-trip ──────────────────────────────────────────────────────────

  test('write + read round-trips a user-scope marker', () => {
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', source: 'wizard' });

    const result = readOnboardingCheckMarker(shellPaths, 'user');
    expect(result.exists).toBe(true);
    expect(result.payload).not.toBeNull();
    expect(result.payload!.version).toBe(1);
    expect(result.payload!.source).toBe('wizard');
  });

  test('write + read round-trips a project-scope marker', () => {
    writeOnboardingCheckMarker(shellPaths, { scope: 'project', source: 'command' });

    const result = readOnboardingCheckMarker(shellPaths, 'project');
    expect(result.exists).toBe(true);
    expect(result.payload!.source).toBe('command');
  });

  test('user and project markers are independent files', () => {
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', source: 'wizard' });
    writeOnboardingCheckMarker(shellPaths, { scope: 'project', source: 'command' });

    const user = readOnboardingCheckMarker(shellPaths, 'user');
    const project = readOnboardingCheckMarker(shellPaths, 'project');
    expect(user.payload!.source).toBe('wizard');
    expect(project.payload!.source).toBe('command');
  });

  test('readOnboardingCheckMarkers returns both scopes and effective marker', () => {
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', source: 'wizard' });

    const state = readOnboardingCheckMarkers(shellPaths);
    expect(state.user.exists).toBe(true);
    expect(state.project.exists).toBe(false);
    // effective is user when user is the only one with a payload
    expect(state.effective).not.toBeNull();
    expect(state.effective!.payload!.source).toBe('wizard');
  });

  test('checkedAt and updatedAt are recorded', () => {
    const t = Date.now();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: t, updatedAt: t + 100, source: 'import' });

    const result = readOnboardingCheckMarker(shellPaths, 'user');
    expect(result.payload!.checkedAt).toBe(t);
    expect(result.payload!.updatedAt).toBe(t + 100);
  });

  test('mode and workspaceRoot are round-tripped', () => {
    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      source: 'wizard',
      mode: 'edit',
      workspaceRoot: '/some/project',
    });

    const result = readOnboardingCheckMarker(shellPaths, 'user');
    expect(result.payload!.mode).toBe('edit');
    expect(result.payload!.workspaceRoot).toBe('/some/project');
  });

  // ── readVersioned integration: corrupt + unknown version ────────────────

  test('corrupt JSON marker is quarantined and read returns error state', () => {
    const markerDir = join(tmpDir, 'user', 'tui');
    mkdirSync(markerDir, { recursive: true });
    const markerPath = join(markerDir, 'onboarding-checked.json');
    writeFileSync(markerPath, '{ bad json }}');

    const result = readOnboardingCheckMarker(shellPaths, 'user');
    expect(result.payload).toBeNull();
    expect(result.parseError).toBeDefined();
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(`${markerPath}.unrecognized`)).toBe(true);
  });

  test('unknown future version marker is quarantined', () => {
    const markerDir = join(tmpDir, 'user', 'tui');
    mkdirSync(markerDir, { recursive: true });
    const markerPath = join(markerDir, 'onboarding-checked.json');
    writeFileSync(markerPath, JSON.stringify({ version: 99, checkedAt: 0, updatedAt: 0, source: 'wizard' }));

    const result = readOnboardingCheckMarker(shellPaths, 'user');
    expect(result.payload).toBeNull();
    expect(existsSync(`${markerPath}.unrecognized`)).toBe(true);
  });
});
