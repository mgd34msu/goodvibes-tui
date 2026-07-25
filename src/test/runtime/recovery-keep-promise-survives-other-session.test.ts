/**
 * recovery-keep-promise-survives-other-session.test.ts — pins the SDK's
 * per-session supersession rule from the TUI consumer side.
 *
 * The recovery modal's "Keep" row promises: "Leave the recovery point on
 * disk. It will be offered again the next time this workspace opens."
 * (buildRecoveryRetireItems, runtime/recovery-prompt.ts). That promise used
 * to be false whenever a DIFFERENT session persisted a turn in between: the
 * old rule judged a snapshot against the global last-session pointer, which
 * advances on every turn-completion persist of ANY session — so one message
 * typed in an unrelated session silently buried a kept snapshot with no UI
 * path left to reach it.
 *
 * The SDK's fix (session-recovery.ts) judges a snapshot only against its OWN
 * session's durable store file. This test runs the TUI's real writer paths —
 * writeRecoveryFile / writeLastSessionPointer via @/runtime/index.ts, the
 * same functions runtime/recovery-prompt.ts and turn-event-wiring.ts call —
 * through the full Keep -> unrelated-session-activity -> next-launch
 * sequence, so a future SDK regression back to pointer-based supersession
 * would fail this test even though nothing in the TUI's own code changed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { writeLastSessionPointer, writeRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { offerRecoverySnapshot, type RecoveryPromptDeps, type SelectionOpener,  resetAnsweredRecoveryOffersForTest } from '../../runtime/recovery-prompt.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ageRecoverySnapshot, makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
let surface: SessionSurface;

beforeEach(() => {
  resetAnsweredRecoveryOffersForTest();
  tmpDir = makeProjectTempDir('gv-keep-promise');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

/** Answers each modal in turn with the given item ids (null = dismissed); records what was asked. */
function scriptedOperator(answers: Array<string | null>): { open: SelectionOpener; details: string[]; asked: number } {
  const details: string[] = [];
  const state = { asked: 0 };
  const open: SelectionOpener = (_title, items, _opts, cb) => {
    details.push(items.map((i) => i.detail ?? '').join('\n'));
    const answer = answers[state.asked] ?? null;
    state.asked += 1;
    cb(answer === null ? null : { item: { id: answer, label: answer }, action: 'select' });
  };
  return { open, details, get asked() { return state.asked; } };
}

function makeDeps(open: SelectionOpener, forSurface: SessionSurface): RecoveryPromptDeps {
  return {
    surface: forSurface,
    openSelection: open,
    receipt: () => {},
    render: () => {},
    applySnapshot: () => 0,
  };
}

describe('the Keep promise survives unrelated session activity', () => {
  test('offer -> Keep -> another session persists a turn (last-session pointer advances) -> next-launch check still offers the kept snapshot', async () => {
    writeRecoveryFile(
      { messages: [{ role: 'user', content: 'kept work' }], title: 'Kept crash', timestamp: Date.now() - 60_000 },
      'kept-session',
      'Kept crash',
      { surface },
    );
    ageRecoverySnapshot(surface.recoveryFile('kept-session'));

    // 1. Offer it; the operator chooses Keep.
    const first = scriptedOperator(['not-now', 'keep']);
    const outcome = await offerRecoverySnapshot(makeDeps(first.open, surface));
    expect(outcome).toBe('kept');
    expect(first.details[0]).toContain('kept-session');
    expect(existsSync(surface.recoveryFile('kept-session'))).toBe(true);

    // 2. Simulate ANOTHER session's turn-persist: the global last-session
    // pointer advances to a totally unrelated session id — exactly what
    // turn-event-wiring.ts's per-turn persist does for whichever session
    // just completed a turn, via this same writeLastSessionPointer call.
    // Under the OLD (pointer-based) supersession rule this alone buried the
    // kept snapshot, permanently, with no UI path left to reach it.
    writeLastSessionPointer('unrelated-other-session', { surface });

    // 3. Next-launch check: a FRESHLY BUILT surface over the same
    // directories — what a relaunched process actually does — using the
    // real `checkRecoveryFile` path (no targetSessionId), the same one the
    // general boot offer (scheduleRecoveryOffer) uses. A relaunch is a new
    // process, so the in-process answered-offer memory starts empty.
    resetAnsweredRecoveryOffersForTest();
    const relaunchSurface = makeTestSurface(tmpDir);
    const second = scriptedOperator(['not-now', 'keep']);
    const nextLaunchOutcome = await offerRecoverySnapshot(makeDeps(second.open, relaunchSurface));

    // Still offered — naming the same session — and still on disk.
    expect(nextLaunchOutcome).toBe('kept');
    expect(second.details[0]).toContain('kept-session');
    expect(existsSync(relaunchSurface.recoveryFile('kept-session'))).toBe(true);
    // The unrelated pointer advance from step 2 is real (proves step 2 did
    // something), yet did not touch the kept snapshot.
    expect(existsSync(relaunchSurface.lastSessionPointer)).toBe(true);
  });
});
