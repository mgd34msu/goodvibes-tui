/**
 * session-picker-hosted.test.ts — the session picker's third source.
 *
 * A person asking "what sessions are there?" opens this modal, and after Phase
 * B the honest answer includes conversations the daemon is running. Two things
 * are protected: the section is ABSENT when nothing has been read (so every
 * caller that never wired a roster renders exactly what it always did), and
 * when it is present it distinguishes never-read from hosting-nothing rather
 * than collapsing them into one blank list.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, existsSync } from 'node:fs';
import { SessionPickerModal, type SessionPickerHostedRoster } from '../../input/session-picker-modal.ts';
import { renderSessionPickerModal } from '../../renderer/session-picker-modal.ts';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import type { HostedRosterSnapshot } from '../../runtime/client/hosted-roster.ts';
import type { HostedSessionRecord } from '@pellux/goodvibes-sdk/platform/hosted-sessions';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';

function frameText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell?.char ?? ' ').join('')).join('\n');
}

function makeRecord(overrides: Partial<HostedSessionRecord> = {}): HostedSessionRecord {
  return {
    id: 'hosted-abc',
    workspaceRoot: '/tmp/w',
    title: 'a daemon-run conversation',
    status: 'running',
    detachPolicy: null,
    effectiveDetachPolicy: 'survive',
    attachedClients: ['tui-host-1'],
    createdAt: 1,
    updatedAt: 2,
    turnCount: 3,
    messageCount: 6,
    restoredFromDisk: false,
    ...overrides,
  };
}

function fixedRoster(snapshot: HostedRosterSnapshot): SessionPickerHostedRoster {
  return { snapshot: () => snapshot, refresh: async () => {} };
}

describe('session picker — daemon-hosted sessions', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(() => {
    tmpDir = makeProjectTempDir('gv-hosted-picker-test');
    sessionManager = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('with no roster wired, the modal renders exactly as it always did', () => {
    const modal = new SessionPickerModal(sessionManager);
    modal.open();
    const text = frameText(renderSessionPickerModal(modal, 80, 24));
    expect(text).not.toContain('Daemon-hosted sessions');
    expect(modal.hostedRoster).toEqual({ sessions: [], capturedAt: null, note: null });
  });

  test('a read-but-empty roster says the daemon hosts nothing — not that nothing was read', () => {
    const modal = new SessionPickerModal(sessionManager, undefined,
      fixedRoster({ sessions: [], capturedAt: 1_700_000_000_000, note: null }));
    modal.open();
    const text = frameText(renderSessionPickerModal(modal, 80, 24));
    expect(text).toContain('Daemon-hosted sessions');
    expect(text).toContain('The daemon is hosting no sessions.');
    expect(text).not.toContain('Not read yet');
  });

  test('a refusal shows its reason instead of an empty list', () => {
    const modal = new SessionPickerModal(sessionManager, undefined,
      fixedRoster({ sessions: [], capturedAt: null, note: 'the daemon did not answer: connection refused' }));
    modal.open();
    const text = frameText(renderSessionPickerModal(modal, 80, 24));
    expect(text).toContain('connection refused');
  });

  test('a hosted row carries what it is doing, what leaving would do, and the id to attach with', () => {
    const modal = new SessionPickerModal(sessionManager, undefined,
      fixedRoster({ sessions: [makeRecord()], capturedAt: 1, note: null }));
    modal.open();
    const text = frameText(renderSessionPickerModal(modal, 110, 26));

    // The id leads: it is the part the user has to retype, so a narrow terminal
    // must clip the description rather than the actionable field.
    expect(text).toContain('hosted-abc · running · survives detach');
    expect(text).toContain('a daemon-run');
    expect(text).toContain('/hosted attach <id>');
  });

  test('the frame stays exactly the requested height once the hosted section is present', () => {
    const modal = new SessionPickerModal(sessionManager, undefined, fixedRoster({
      sessions: Array.from({ length: 9 }, (_, index) => makeRecord({ id: `hosted-${index}` })),
      capturedAt: 1,
      note: null,
    }));
    modal.open();
    for (const [width, height] of [[80, 24], [120, 40]] as const) {
      const lines = renderSessionPickerModal(modal, width, height);
      expect(lines.length).toBeLessThanOrEqual(height);
      // Every hosted row fits on ONE line, so the section's row accounting is
      // true and the trailing hint is never eaten by the tail clip.
      expect(frameText(lines)).toContain('/hosted attach <id>');
    }
    // Nine rows, five shown: the overflow line is real, not a silently truncated list.
    expect(frameText(renderSessionPickerModal(modal, 110, 40))).toContain('[showing 5 of 9]');
  });

  test('open() asks the roster for a fresh answer and adopts it when it lands', async () => {
    let refreshed = 0;
    let landed = 0;
    let snapshot: HostedRosterSnapshot = { sessions: [], capturedAt: null, note: null };
    const modal = new SessionPickerModal(sessionManager, undefined, {
      snapshot: () => snapshot,
      refresh: async () => {
        refreshed += 1;
        snapshot = { sessions: [makeRecord()], capturedAt: 2, note: null };
      },
    }, () => { landed += 1; });

    modal.open();
    expect(refreshed).toBe(1);
    // The modal opens on the LAST answer; the refresh lands behind it.
    expect(modal.hostedRoster.sessions).toHaveLength(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(modal.hostedRoster.sessions).toHaveLength(1);
    expect(landed).toBe(1);
  });
});
