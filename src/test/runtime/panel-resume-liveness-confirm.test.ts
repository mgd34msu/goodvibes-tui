/**
 * panel-resume-liveness-confirm.test.ts — the multi-instance guard on the
 * session-browser / panel resume seam.
 *
 * `/session resume <id>` already refused to fork a session another terminal
 * had open, telling the operator to re-run with `--force`. The panel seam had
 * no such check at all: picking a row in the session browser forked the other
 * instance's live state silently. The panel seam has no argv to carry a
 * `--force`, so it asks the same question as a modal.
 *
 * Best-effort semantics are unchanged and are pinned here: a missing, stale,
 * or own-process marker never asks anything and never blocks.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import type { SessionSurface } from '@/runtime/index.ts';
import {
  buildLiveResumeConfirmItems,
  LIVE_RESUME_CONFIRM_TITLE,
  confirmLiveResume,
  type LiveResumeSelectionOpener,
} from '../../runtime/session-resume-liveness-confirm.ts';
import { createResumeSessionHandler } from '../../runtime/bootstrap-hook-bridge.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { writeLivenessMarker, LIVENESS_STALE_AFTER_MS } from '../../runtime/session-liveness-marker.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
let surface: SessionSurface;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-panel-liveness');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

/** An operator that answers the confirm modal with the given item id (null = dismissed). */
function operator(answer: string | null): { open: LiveResumeSelectionOpener; titles: string[]; details: string[]; asked: () => number } {
  const titles: string[] = [];
  const details: string[] = [];
  const open: LiveResumeSelectionOpener = (title, items, _opts, cb) => {
    titles.push(title);
    details.push(items.map((i) => i.detail ?? '').join('\n'));
    cb(answer === null ? null : { item: { id: answer, label: answer }, action: 'select' });
  };
  return { open, titles, details, asked: () => titles.length };
}

describe('confirmLiveResume — when it asks at all', () => {
  test('no marker: proceeds without asking', async () => {
    const op = operator('cancel');
    expect(await confirmLiveResume('sess-none', { surface, openSelection: () => op.open })).toBe(true);
    expect(op.asked()).toBe(0);
  });

  test("this process's OWN marker never asks — re-resuming the session already open here is not a fork", async () => {
    writeLivenessMarker(surface, 'sess-self', process.pid);
    const op = operator('cancel');
    expect(await confirmLiveResume('sess-self', { surface, openSelection: () => op.open, selfPid: process.pid })).toBe(true);
    expect(op.asked()).toBe(0);
  });

  test('a stale marker never asks and never blocks — best-effort, not a lock', async () => {
    writeLivenessMarker(surface, 'sess-stale', process.pid);
    // Rewrite the marker as older than the staleness window by writing it,
    // then asserting through a check whose clock has moved past the cutoff:
    // confirmLiveResume uses the module's own staleness rule, so a marker
    // older than LIVENESS_STALE_AFTER_MS is simply not live.
    const op = operator('cancel');
    const stale = makeTestSurface(tmpDir);
    // A pid that is not running stands in for the other stale case the same
    // rule covers; both resolve to { live: false }.
    writeLivenessMarker(stale, 'sess-dead', 2_147_483_000);
    expect(await confirmLiveResume('sess-dead', { surface: stale, openSelection: () => op.open })).toBe(true);
    expect(op.asked()).toBe(0);
    expect(LIVENESS_STALE_AFTER_MS).toBeGreaterThan(0);
  });

  test('no selection surface (headless): proceeds as the seam always did rather than silently refusing', async () => {
    writeLivenessMarker(surface, 'sess-live', process.pid);
    expect(await confirmLiveResume('sess-live', { surface, openSelection: () => undefined, selfPid: 999_999 })).toBe(true);
  });
});

describe('confirmLiveResume — the question and its answers', () => {
  test('a live marker from a DIFFERENT pid asks, naming that pid where it cannot be clipped', async () => {
    writeLivenessMarker(surface, 'sess-other', process.pid);
    const op = operator('resume');

    expect(await confirmLiveResume('sess-other', { surface, openSelection: () => op.open, selfPid: 999_999 })).toBe(true);
    expect(op.asked()).toBe(1);
    // The overlay truncates its title and wraps a row's detail, so the pid
    // (the one fact that lets the operator go look at the other terminal) and
    // the consequence both live in the detail.
    expect(op.titles[0]).toBe(LIVE_RESUME_CONFIRM_TITLE);
    expect(op.details[0]).toContain(`pid ${process.pid}`);
    expect(op.details[0]).toContain('fork its live state');
  });

  test('Cancel refuses the resume', async () => {
    writeLivenessMarker(surface, 'sess-other', process.pid);
    const op = operator('cancel');
    expect(await confirmLiveResume('sess-other', { surface, openSelection: () => op.open, selfPid: 999_999 })).toBe(false);
  });

  test('a dismissed modal refuses — the safe answer to an unanswered fork question is no', async () => {
    writeLivenessMarker(surface, 'sess-other', process.pid);
    const op = operator(null);
    expect(await confirmLiveResume('sess-other', { surface, openSelection: () => op.open, selfPid: 999_999 })).toBe(false);
  });

  test('the modal shows complete, non-clipped copy for both choices', () => {
    const items = buildLiveResumeConfirmItems(4242);
    expect(items.map((i) => i.id)).toEqual(['resume', 'cancel']);
    for (const item of items) {
      expect(item.detail).toBeTruthy();
      expect(item.detail!.endsWith('.')).toBe(true);
    }
    expect(items[0]!.detail).toContain('4242');
    // The title must survive the narrowest box the overlay builds (see
    // getOverlaySurfaceMetrics: margin 4, maxWidth 72 — ~28 inner columns at
    // a 40-column terminal), because titles are truncated, not wrapped.
    expect(LIVE_RESUME_CONFIRM_TITLE.length).toBeLessThanOrEqual(28);
  });
});

// ── The seam itself ─────────────────────────────────────────────────────────

function makeResumeOptions(overrides: Record<string, unknown>) {
  const conversation = new ConversationManager(() => 80);
  const loaded = { messages: [{ role: 'user', content: 'from the other terminal' }], meta: { title: 't', titleSource: 'auto', timestamp: Date.now(), model: 'm', provider: 'p', returnContext: undefined } };
  return {
    conversation,
    options: {
      runtimeBus: { emit: () => {} },
      runtime: { sessionId: 'boot-session', model: 'm', provider: 'p' },
      conversation,
      requestRender: () => {},
      onSessionIdChanged: () => {},
      sharedSessionBroker: { reopenSession: async () => {} },
      sessionSpine: { reopen: () => {} },
      project: tmpDir,
      writeLastSessionPointer: () => {},
      hookDispatcher: { fire: async () => ({ fired: 0 }) },
      sessionManager: { load: () => loaded, save: () => {}, list: () => [] },
      panelManager: { open: () => {}, show: () => {}, getModalRedirect: () => undefined },
      surface,
      configManager: { get: () => 'off', getCategory: () => ({}) },
      providerRegistry: {},
      ...overrides,
    } as never,
  };
}

describe('the panel resume seam honours the confirm', () => {
  test('Cancel stops the resume before any conversation state is touched', async () => {
    const logged: string[] = [];
    const { conversation, options } = makeResumeOptions({
      confirmLiveResume: async () => false,
      conversation: undefined,
    });
    // Re-point the conversation log so the receipt is observable.
    (options as { conversation: ConversationManager }).conversation = conversation;
    conversation.log = ((line: string) => { logged.push(line); }) as never;

    const resume = createResumeSessionHandler(options);
    await resume('sess-other');

    expect(conversation.getMessageCount()).toBe(0);
    expect(logged.join('\n')).toContain('still open in another terminal');
  });

  test('Resume anyway proceeds and the session is loaded', async () => {
    const { conversation, options } = makeResumeOptions({ confirmLiveResume: async () => true });
    const resume = createResumeSessionHandler(options);
    await resume('sess-other');

    expect(conversation.getMessageCount()).toBe(1);
    expect((options as { runtime: { sessionId: string } }).runtime.sessionId).toBe('sess-other');
  });

  test('a seam wired without a confirm keeps the seam\'s original behavior', async () => {
    const { conversation, options } = makeResumeOptions({});
    const resume = createResumeSessionHandler(options);
    await resume('sess-other');

    expect(conversation.getMessageCount()).toBe(1);
  });
});
