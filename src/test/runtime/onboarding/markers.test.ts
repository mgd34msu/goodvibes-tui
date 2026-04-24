import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import {
  clearOnboardingCompletionMarker,
  getOnboardingCompletionMarkerPath,
  readOnboardingCompletionMarkers,
  writeOnboardingCompletionMarker,
} from '../../../runtime/onboarding/index.ts';

function createShellPaths() {
  const root = join(tmpdir(), `gv-onboarding-marker-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return createShellPathService({
    workingDirectory: join(root, 'workspace'),
    homeDirectory: join(root, 'home'),
  });
}

describe('onboarding completion marker helpers', () => {
  test('writes and reads user and project markers with project precedence', () => {
    const shellPaths = createShellPaths();

    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'user',
      completedAt: 100,
      updatedAt: 110,
      source: 'wizard',
      mode: 'new',
    });
    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'project',
      completedAt: 200,
      updatedAt: 210,
      source: 'command',
      mode: 'edit',
    });

    const markers = readOnboardingCompletionMarkers(shellPaths);

    expect(markers.user.payload?.completedAt).toBe(100);
    expect(markers.user.payload?.workspaceRoot).toBe(shellPaths.workingDirectory);
    expect(markers.project.payload?.completedAt).toBe(200);
    expect(markers.effective?.scope).toBe('project');
    expect(markers.effective?.payload?.mode).toBe('edit');
  });

  test('falls back to a valid user marker when the project marker is invalid', () => {
    const shellPaths = createShellPaths();

    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'user',
      completedAt: 300,
      source: 'wizard',
    });

    const projectPath = getOnboardingCompletionMarkerPath(shellPaths, 'project');
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, '{invalid-json', 'utf-8');

    const markers = readOnboardingCompletionMarkers(shellPaths);

    expect(markers.project.exists).toBe(true);
    expect(markers.project.payload).toBeNull();
    expect(markers.project.parseError).toBeTruthy();
    expect(markers.effective?.scope).toBe('user');

    clearOnboardingCompletionMarker(shellPaths, 'user');
    expect(readOnboardingCompletionMarkers(shellPaths).user.exists).toBe(false);
  });
});
