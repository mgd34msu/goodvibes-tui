import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { saveWizardProgressForHandler } from '../../../input/handler-onboarding.ts';
import type { InputHandler } from '../../../input/handler.ts';
import {
  deleteWizardProgress,
  getWizardProgressPath,
  hasResumableWizardProgress,
  readWizardProgress,
  writeWizardProgress,
} from '../../../runtime/onboarding/index.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

describe('wizard progress persistence', () => {
  let root: string;
  let shellPaths: ReturnType<typeof createShellPathService>;

  beforeEach(() => {
    root = makeProjectTempDir('gv-progress');
    shellPaths = createShellPathService({
      workingDirectory: join(root, 'workspace'),
      homeDirectory: join(root, 'home'),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // readWizardProgress — missing file
  // ---------------------------------------------------------------------------

  test('returns exists=false when no progress file is present', () => {
    const state = readWizardProgress(shellPaths);
    expect(state.exists).toBe(false);
    expect(state.payload).toBeNull();
    expect(state.parseError).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // writeWizardProgress + readWizardProgress — round-trip
  // ---------------------------------------------------------------------------

  test('round-trips scalar fields correctly', () => {
    writeWizardProgress(shellPaths, {
      mode: 'new',
      stepIndex: 2,
      toggleState: [],
      radioState: [],
      textState: [],
      clock: () => 1_000_000,
    });

    const state = readWizardProgress(shellPaths);
    expect(state.exists).toBe(true);
    expect(state.parseError).toBeUndefined();
    expect(state.payload).not.toBeNull();
    expect(state.payload?.version).toBe(1);
    expect(state.payload?.savedAt).toBe(1_000_000);
    expect(state.payload?.mode).toBe('new');
    expect(state.payload?.stepIndex).toBe(2);
  });

  test('round-trips toggle, radio and text field maps', () => {
    writeWizardProgress(shellPaths, {
      mode: 'edit',
      stepIndex: 0,
      toggleState: [['stream', true], ['verbose', false]],
      radioState: [['theme', 'dark']],
      textState: [['host', 'localhost'], ['port', '8080']],
      clock: () => 5_000,
    });

    const { payload } = readWizardProgress(shellPaths);
    expect(payload).not.toBeNull();
    const toggle = new Map(payload?.toggleState ?? []);
    expect(toggle.get('stream')).toBe(true);
    expect(toggle.get('verbose')).toBe(false);
    const radio = new Map(payload?.radioState ?? []);
    expect(radio.get('theme')).toBe('dark');
    const text = new Map(payload?.textState ?? []);
    expect(text.get('host')).toBe('localhost');
    expect(text.get('port')).toBe('8080');
  });

  test('round-trips all OnboardingMode values', () => {
    for (const mode of ['new', 'edit', 'reopen'] as const) {
      writeWizardProgress(shellPaths, {
        mode,
        stepIndex: 0,
        toggleState: [],
        radioState: [],
        textState: [],
        clock: () => 1,
      });
      const { payload } = readWizardProgress(shellPaths);
      expect(payload?.mode).toBe(mode);
    }
  });

  test('overwrites an existing progress file on subsequent writes', () => {
    writeWizardProgress(shellPaths, {
      mode: 'new',
      stepIndex: 0,
      toggleState: [],
      radioState: [],
      textState: [],
      clock: () => 100,
    });
    writeWizardProgress(shellPaths, {
      mode: 'edit',
      stepIndex: 3,
      toggleState: [['a', true]],
      radioState: [],
      textState: [],
      clock: () => 200,
    });

    const { payload } = readWizardProgress(shellPaths);
    expect(payload?.mode).toBe('edit');
    expect(payload?.stepIndex).toBe(3);
    expect(payload?.savedAt).toBe(200);
  });

  test('progress file is created under the user-scoped path (not project path)', () => {
    writeWizardProgress(shellPaths, {
      mode: 'new',
      stepIndex: 0,
      toggleState: [],
      radioState: [],
      textState: [],
    });

    const progressPath = getWizardProgressPath(shellPaths);
    expect(existsSync(progressPath)).toBe(true);
    // Must live under the home directory, not the workspace directory.
    expect(progressPath.startsWith(join(root, 'home'))).toBe(true);
    expect(progressPath.startsWith(join(root, 'workspace'))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // readWizardProgress — corrupt file
  // ---------------------------------------------------------------------------

  test('returns exists=true, payload=null with parseError for non-JSON content', () => {
    const path = getWizardProgressPath(shellPaths);
    // Ensure parent dir exists by writing progress first.
    writeWizardProgress(shellPaths, { mode: 'new', stepIndex: 0, toggleState: [], radioState: [], textState: [] });
    // Overwrite with garbage.
    writeFileSync(path, 'not-json', 'utf-8');

    const state = readWizardProgress(shellPaths);
    expect(state.exists).toBe(true);
    expect(state.payload).toBeNull();
    expect(state.parseError).toBeDefined();
  });

  test('returns exists=true, payload=null with parseError for wrong schema version', () => {
    const path = getWizardProgressPath(shellPaths);
    writeWizardProgress(shellPaths, { mode: 'new', stepIndex: 0, toggleState: [], radioState: [], textState: [] });
    // Overwrite with a future/unknown version.
    writeFileSync(path, JSON.stringify({ version: 99, savedAt: 0, mode: 'new', stepIndex: 0, toggleState: [], radioState: [], textState: [] }), 'utf-8');

    const state = readWizardProgress(shellPaths);
    expect(state.exists).toBe(true);
    expect(state.payload).toBeNull();
    expect(state.parseError).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // deleteWizardProgress
  // ---------------------------------------------------------------------------

  test('removes an existing progress file', () => {
    writeWizardProgress(shellPaths, {
      mode: 'new',
      stepIndex: 0,
      toggleState: [],
      radioState: [],
      textState: [],
    });

    const path = getWizardProgressPath(shellPaths);
    expect(existsSync(path)).toBe(true);

    deleteWizardProgress(shellPaths);
    expect(existsSync(path)).toBe(false);
  });

  test('does not throw when progress file is already absent', () => {
    expect(() => deleteWizardProgress(shellPaths)).not.toThrow();
  });

  test('readWizardProgress returns exists=false after deleteWizardProgress', () => {
    writeWizardProgress(shellPaths, {
      mode: 'reopen',
      stepIndex: 1,
      toggleState: [],
      radioState: [],
      textState: [],
    });
    deleteWizardProgress(shellPaths);

    const state = readWizardProgress(shellPaths);
    expect(state.exists).toBe(false);
    expect(state.payload).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // hasResumableWizardProgress
  // ---------------------------------------------------------------------------

  test('returns false when no progress file exists', () => {
    expect(hasResumableWizardProgress(shellPaths)).toBe(false);
  });

  test('returns true for a progress file saved moments ago', () => {
    const now = Date.now();
    writeWizardProgress(shellPaths, {
      mode: 'new',
      stepIndex: 0,
      toggleState: [],
      radioState: [],
      textState: [],
      clock: () => now - 1_000, // 1 second ago
    });

    expect(hasResumableWizardProgress(shellPaths, { now })).toBe(true);
  });

  test('returns false when progress is older than 7 days', () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const savedAt = 1_000_000;
    writeWizardProgress(shellPaths, {
      mode: 'new',
      stepIndex: 0,
      toggleState: [],
      radioState: [],
      textState: [],
      clock: () => savedAt,
    });

    // now = savedAt + 7 days + 1ms → expired
    expect(hasResumableWizardProgress(shellPaths, { now: savedAt + sevenDaysMs + 1 })).toBe(false);
  });

  test('returns true when progress is exactly under 7 days old', () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const savedAt = 2_000_000;
    writeWizardProgress(shellPaths, {
      mode: 'edit',
      stepIndex: 1,
      toggleState: [],
      radioState: [],
      textState: [],
      clock: () => savedAt,
    });

    // now = savedAt + 7 days - 1ms → still valid
    expect(hasResumableWizardProgress(shellPaths, { now: savedAt + sevenDaysMs - 1 })).toBe(true);
  });

  test('returns false when progress file is corrupt (unreadable payload)', () => {
    const path = getWizardProgressPath(shellPaths);
    writeWizardProgress(shellPaths, { mode: 'new', stepIndex: 0, toggleState: [], radioState: [], textState: [] });
    writeFileSync(path, 'bad json', 'utf-8');

    expect(hasResumableWizardProgress(shellPaths)).toBe(false);
  });

  test('returns false after deleteWizardProgress', () => {
    writeWizardProgress(shellPaths, {
      mode: 'new',
      stepIndex: 0,
      toggleState: [],
      radioState: [],
      textState: [],
      clock: () => Date.now() - 1_000,
    });

    expect(hasResumableWizardProgress(shellPaths)).toBe(true);
    deleteWizardProgress(shellPaths);
    expect(hasResumableWizardProgress(shellPaths)).toBe(false);
  });

  test('returns false when savedAt is in the future (future-dated / tampered file)', () => {
    const now = Date.now();
    // Write a progress file whose savedAt is 1 hour in the future.
    writeWizardProgress(shellPaths, {
      mode: 'new',
      stepIndex: 0,
      toggleState: [],
      radioState: [],
      textState: [],
      clock: () => now + 3_600_000,
    });

    // age = now - (now + 3600000) = -3600000 < 0 → non-resumable.
    expect(hasResumableWizardProgress(shellPaths, { now })).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Masked field exclusion (contract between caller and writeWizardProgress)
  // ---------------------------------------------------------------------------

  test('writes only non-masked textState entries passed by the caller', () => {
    // Simulates what saveWizardProgressForHandler does: it strips masked
    // fields before calling writeWizardProgress. The function itself does
    // not filter — the contract is at the call site. This test documents
    // that whatever is passed in is faithfully persisted (no surprise stripping).
    writeWizardProgress(shellPaths, {
      mode: 'new',
      stepIndex: 0,
      toggleState: [],
      radioState: [],
      textState: [['apiHost', 'localhost']], // masked fields were stripped by caller
      clock: () => 1,
    });

    const { payload } = readWizardProgress(shellPaths);
    const text = new Map(payload?.textState ?? []);
    expect(text.has('apiHost')).toBe(true);
    // No masked key was passed in, so none should appear.
    expect(text.has('password')).toBe(false);
    expect(text.has('apiKey')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // saveWizardProgressForHandler — masked-field security boundary
  // ---------------------------------------------------------------------------

  test('saveWizardProgressForHandler does not write masked field secrets to disk', () => {
    // Build a minimal handler stub that satisfies the properties accessed by
    // saveWizardProgressForHandler without needing the full InputHandler class.
    const SECRET_VALUE = 'sk-super-secret-api-key-12345';
    const MASKED_FIELD_ID = 'providers.openai-api-key';
    const PLAIN_FIELD_ID = 'providers.hostname';
    const PLAIN_VALUE = 'localhost';

    const textState = new Map<string, string>([
      [MASKED_FIELD_ID, SECRET_VALUE],
      [PLAIN_FIELD_ID, PLAIN_VALUE],
    ]);

    const handler = {
      onboardingWizard: {
        active: true,
        mode: 'edit' as const,
        stepIndex: 1,
        toggleState: new Map<string, boolean>(),
        radioState: new Map<string, string>(),
        textState,
        steps: [
          {
            id: 'provider-access',
            fields: [
              { id: MASKED_FIELD_ID, kind: 'masked' as const, label: 'API key', hint: '', defaultValue: '', placeholder: '' },
              { id: PLAIN_FIELD_ID, kind: 'text' as const, label: 'Host', hint: '', defaultValue: '', placeholder: '' },
            ],
          },
        ],
      },
      uiServices: {
        environment: {
          shellPaths,
        },
      },
    } as unknown as InputHandler;

    saveWizardProgressForHandler(handler);

    // Read the raw file bytes and assert the secret does not appear anywhere.
    const progressPath = getWizardProgressPath(shellPaths);
    const rawContents = readFileSync(progressPath, 'utf-8');

    // The secret value must be completely absent from the persisted file.
    expect(rawContents).not.toContain(SECRET_VALUE);
    // The masked field ID itself must also be absent (it was not written).
    expect(rawContents).not.toContain(MASKED_FIELD_ID);
    // The plain (non-masked) field value must be present.
    expect(rawContents).toContain(PLAIN_VALUE);
    expect(rawContents).toContain(PLAIN_FIELD_ID);
  });
});
