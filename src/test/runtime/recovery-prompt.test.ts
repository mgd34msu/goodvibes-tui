/**
 * recovery-prompt.test.ts — the ask-then-retire recovery flow.
 *
 * Pins the owner ruling: a crash-recovery snapshot is offered, never applied
 * on its own; declining leads to a second, explicit question about retiring
 * it; and nothing is ever deleted except on an explicit "Remove". Dismissing
 * a modal is not an answer and must leave the snapshot exactly where it is.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import {
  buildRecoveryOfferItems,
  buildRecoveryRetireItems,
  RECOVERY_OFFER_TITLE,
  RECOVERY_RETIRE_TITLE,
  describeRecoverySnapshot,
  formatSnapshotAge,
  formatSnapshotSize,
  offerRecoverySnapshot,
  resetAnsweredRecoveryOffersForTest,
  type RecoveryPromptDeps,
  type SelectionOpener,
} from '../../runtime/recovery-prompt.ts';
import { writeLivenessMarker } from '../../runtime/session-liveness-marker.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ageRecoverySnapshot, makeTestSurface } from '../helpers/session-surface.ts';
import { recoveryDecisionsPathFor } from '../../runtime/recovery-decisions.ts';

let tmpDir: string;
let surface: SessionSurface;

beforeEach(() => {
  resetAnsweredRecoveryOffersForTest();
  tmpDir = makeProjectTempDir('gv-recovery-prompt');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

/**
 * Plant an abandoned crash snapshot. `ageMsBefore` orders two of them against
 * each other; every one is aged out of the live-refresh window, because a
 * snapshot being written right now is not a crash to offer.
 */
function writeCrash(sessionId: string, title = 'Interrupted work', messageCount = 2, ageMsBefore = 0): void {
  const messages = Array.from({ length: messageCount }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }));
  writeRecoveryFile(
    { messages: messages as never, title, titleSource: 'system', timestamp: Date.now() - 120_000 },
    sessionId,
    title,
    { surface },
  );
  ageRecoverySnapshot(surface.recoveryFile(sessionId), ageMsBefore);
}

/** A scripted operator: answers each modal in turn with the given item ids (null = dismissed). */
function scriptedOperator(answers: Array<string | null>): { open: SelectionOpener; titles: string[]; details: string[]; asked: number } {
  const titles: string[] = [];
  const details: string[] = [];
  const state = { asked: 0 };
  const open: SelectionOpener = (title, items, _opts, cb) => {
    titles.push(title);
    details.push(items.map((i) => i.detail ?? '').join('\n'));
    const answer = answers[state.asked] ?? null;
    state.asked += 1;
    cb(answer === null ? null : { item: { id: answer, label: answer }, action: 'select' });
  };
  return { open, titles, details, get asked() { return state.asked; } };
}

function makeDeps(open: SelectionOpener | undefined, sink: { receipts: string[]; applied: Array<{ sessionId: string; messages: number }> }): RecoveryPromptDeps {
  return {
    surface,
    openSelection: open,
    receipt: (line) => sink.receipts.push(line),
    render: () => {},
    now: () => Date.now(),
    applySnapshot: ({ snapshot, sessionId }) => {
      const messages = (snapshot as { messages?: unknown[] }).messages ?? [];
      sink.applied.push({ sessionId, messages: messages.length });
      return messages.length;
    },
  };
}

function makeSink() { return { receipts: [] as string[], applied: [] as Array<{ sessionId: string; messages: number }> }; }

describe('nothing to offer', () => {
  test('no snapshot on disk: no modal is ever opened', async () => {
    const op = scriptedOperator(['resume']);
    const sink = makeSink();
    expect(await offerRecoverySnapshot(makeDeps(op.open, sink))).toBe('none');
    expect(op.asked).toBe(0);
    expect(sink.applied).toHaveLength(0);
  });

  test('a snapshot whose session has a live pid marker is not offered — another terminal owns it', async () => {
    writeCrash('sess-live');
    writeLivenessMarker(surface, 'sess-live', process.pid); // this process's pid always resolves alive
    const op = scriptedOperator(['resume']);
    const sink = makeSink();

    expect(await offerRecoverySnapshot(makeDeps(op.open, sink))).toBe('none');
    expect(op.asked).toBe(0);
    // And the other instance's snapshot is untouched.
    expect(existsSync(surface.recoveryFile('sess-live'))).toBe(true);
  });

  test('a headless host with no selection surface never applies or deletes anything', async () => {
    writeCrash('sess-headless');
    const sink = makeSink();
    expect(await offerRecoverySnapshot(makeDeps(undefined, sink))).toBe('none');
    expect(sink.applied).toHaveLength(0);
    expect(existsSync(surface.recoveryFile('sess-headless'))).toBe(true);
  });
});

describe('Resume', () => {
  test('applies the snapshot through the caller, retires the file, and prints one honest receipt', async () => {
    writeCrash('sess-resume', 'Half-written migration', 4);
    const op = scriptedOperator(['resume']);
    const sink = makeSink();

    expect(await offerRecoverySnapshot(makeDeps(op.open, sink))).toBe('resumed');

    expect(sink.applied).toEqual([{ sessionId: 'sess-resume', messages: 4 }]);
    expect(existsSync(surface.recoveryFile('sess-resume'))).toBe(false); // load-then-delete
    expect(sink.receipts).toHaveLength(1);
    expect(sink.receipts[0]).toContain('4 message(s)');
    expect(sink.receipts[0]).toContain('sess-resume');
    // Only one question asked — Resume never leads to the retire modal.
    expect(op.asked).toBe(1);
  });

  test('the offer modal states the snapshot facts where they cannot be clipped', async () => {
    writeCrash('sess-facts', 'Half-written migration');
    const op = scriptedOperator(['resume']);
    await offerRecoverySnapshot(makeDeps(op.open, makeSink()));

    // The selection overlay TRUNCATES its title to the box width but WRAPS a
    // row's detail with no line cap. Facts therefore live in the detail; the
    // title is a short fixed string that survives a narrow terminal intact.
    expect(op.titles[0]).toBe(RECOVERY_OFFER_TITLE);
    expect(op.details[0]).toContain('sess-facts');
    expect(op.details[0]).toContain('Half-written migration');
    expect(op.details[0]).toMatch(/\d+m ago|just now/);
  });
});

describe('decline → retire question', () => {
  test('Not now then Remove deletes the snapshot and says so', async () => {
    writeCrash('sess-remove');
    const op = scriptedOperator(['not-now', 'remove']);
    const sink = makeSink();

    expect(await offerRecoverySnapshot(makeDeps(op.open, sink))).toBe('removed');
    expect(op.asked).toBe(2);
    expect(op.titles[1]).toBe(RECOVERY_RETIRE_TITLE);
    // The follow-up restates WHICH snapshot is about to be deleted.
    expect(op.details[1]).toContain('sess-remove');
    expect(existsSync(surface.recoveryFile('sess-remove'))).toBe(false);
    expect(sink.receipts[0]).toContain('Recovery point removed');
    // Nothing was loaded into a conversation on the way to deleting it.
    expect(sink.applied).toHaveLength(0);
  });

  test('Not now then Keep leaves the file alone and promises the next launch, not this one', async () => {
    writeCrash('sess-keep');
    const op = scriptedOperator(['not-now', 'keep']);
    const sink = makeSink();

    expect(await offerRecoverySnapshot(makeDeps(op.open, sink))).toBe('kept');
    expect(existsSync(surface.recoveryFile('sess-keep'))).toBe(true);
    expect(sink.receipts[0]).toContain('next launch');
    // Two questions total: it does not come back a third time in this run.
    expect(op.asked).toBe(2);
  });
});

describe('dismissal is not an answer', () => {
  test('dismissing the offer never opens the retire question and never deletes', async () => {
    writeCrash('sess-esc');
    const op = scriptedOperator([null]);
    const sink = makeSink();

    expect(await offerRecoverySnapshot(makeDeps(op.open, sink))).toBe('kept');
    expect(op.asked).toBe(1);
    expect(existsSync(surface.recoveryFile('sess-esc'))).toBe(true);
    expect(sink.applied).toHaveLength(0);
  });

  test('dismissing the retire question keeps the snapshot', async () => {
    writeCrash('sess-esc2');
    const op = scriptedOperator(['not-now', null]);
    const sink = makeSink();

    expect(await offerRecoverySnapshot(makeDeps(op.open, sink))).toBe('kept');
    expect(existsSync(surface.recoveryFile('sess-esc2'))).toBe(true);
  });
});

describe('modal copy is complete, not clipped', () => {
  test('every row carries a full-sentence detail the selection modal wraps rather than truncates', () => {
    for (const item of [...buildRecoveryOfferItems('session x · 1m ago'), ...buildRecoveryRetireItems('session x · 1m ago')]) {
      expect(item.detail).toBeTruthy();
      expect(item.detail!.endsWith('.')).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.primaryAction).toBe('select');
    }
  });

  test('the two questions offer exactly the two documented choices each', () => {
    expect(buildRecoveryOfferItems('f').map((i) => i.id)).toEqual(['resume', 'not-now']);
    expect(buildRecoveryRetireItems('f').map((i) => i.id)).toEqual(['keep', 'remove']);
  });

  test('the row a modal opens on is never the destructive one', () => {
    // A selection modal starts on index 0, so row order decides what an
    // unread Enter does. On the retire question that has to be Keep: the
    // question arrives unrequested at boot and Remove destroys a
    // conversation. On the offer, index 0 is Resume — the affirmative answer
    // the user is there for, and it deletes nothing they wanted kept.
    expect(buildRecoveryRetireItems('f')[0]?.id).toBe('keep');
    expect(buildRecoveryOfferItems('f')[0]?.id).toBe('resume');
  });

  test('both titles stay short enough to survive the narrowest box the overlay builds', () => {
    // getOverlaySurfaceMetrics uses margin 4 / maxWidth 72; on a 40-column
    // terminal the inner text width lands around 28. Anything longer than the
    // title budget gets truncated, so long copy must never live there.
    const NARROW_TITLE_BUDGET = 28;
    expect(RECOVERY_OFFER_TITLE.length).toBeLessThanOrEqual(NARROW_TITLE_BUDGET);
    expect(RECOVERY_RETIRE_TITLE.length).toBeLessThanOrEqual(NARROW_TITLE_BUDGET);
  });
});

describe('fact formatting states only what is known', () => {
  test('age buckets', () => {
    expect(formatSnapshotAge(-5)).toBe('just now');
    expect(formatSnapshotAge(30_000)).toBe('just now');
    expect(formatSnapshotAge(5 * 60_000)).toBe('5m ago');
    expect(formatSnapshotAge(3 * 3_600_000)).toBe('3h ago');
    expect(formatSnapshotAge(2 * 86_400_000)).toBe('2d ago');
  });

  test('size formatting', () => {
    expect(formatSnapshotSize(512)).toBe('512 B');
    expect(formatSnapshotSize(2048)).toBe('2.0 KB');
    expect(formatSnapshotSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  test('an unreadable size is omitted rather than guessed, and an empty title is not shown', () => {
    const nowMs = 1_000_000;
    const described = describeRecoverySnapshot(
      { sessionId: 'sess-x', title: '   ', timestamp: nowMs - 60_000 },
      { nowMs, bytes: null },
    );
    expect(described).toBe('session sess-x · 1m ago');
    expect(described).not.toContain('B');
  });

  test('a known size and title are both reported', () => {
    const nowMs = 1_000_000;
    expect(describeRecoverySnapshot(
      { sessionId: 'sess-y', title: 'Refactor', timestamp: nowMs - 3_600_000 },
      { nowMs, bytes: 4096 },
    )).toBe('session sess-y · 1h ago · "Refactor" · 4.0 KB');
  });
});

describe('every recovery call is keyed to the snapshot session, never a bulk form', () => {
  // Why this matters beyond tidiness: the SDK's no-sessionId forms
  // deliberately do NOT reach the legacy shared recovery directory (a bulk
  // clear there could delete an unrelated project's snapshot). Only a
  // session-id-keyed call does. A modal that answered "removed" while calling
  // the bulk form would leave a pre-upgrade snapshot on disk to be re-offered
  // on every launch, forever — a receipt that lies.
  //
  // Two concurrent snapshots make the distinction observable: the keyed call
  // touches exactly one, the bulk form would clear both.

  test('Remove deletes only the offered session, leaving a concurrent snapshot alone', async () => {
    writeCrash('sess-older', 'Interrupted work', 2, 60_000);
    writeCrash('sess-newer'); // the newest is the one checkRecoveryFile offers
    const op = scriptedOperator(['not-now', 'remove']);
    const sink = makeSink();

    expect(await offerRecoverySnapshot(makeDeps(op.open, sink))).toBe('removed');
    expect(op.details[0]).toContain('sess-newer');
    expect(sink.receipts[0]).toContain('sess-newer');

    expect(existsSync(surface.recoveryFile('sess-newer'))).toBe(false);
    // A bulk removeRecoveryPoint(surface) would have taken this one too.
    expect(existsSync(surface.recoveryFile('sess-older'))).toBe(true);
  });

  test('Resume consumes only the offered session, leaving a concurrent snapshot alone', async () => {
    writeCrash('sess-older2', 'Interrupted work', 2, 60_000);
    writeCrash('sess-newer2');
    const op = scriptedOperator(['resume']);
    const sink = makeSink();

    expect(await offerRecoverySnapshot(makeDeps(op.open, sink))).toBe('resumed');
    expect(sink.applied[0]?.sessionId).toBe('sess-newer2');

    expect(existsSync(surface.recoveryFile('sess-newer2'))).toBe(false);
    expect(existsSync(surface.recoveryFile('sess-older2'))).toBe(true);
  });

  test('the receipt names the same session the modal offered — no drift between question and outcome', async () => {
    writeCrash('sess-named', 'A named crash');
    const op = scriptedOperator(['resume']);
    const sink = makeSink();
    await offerRecoverySnapshot(makeDeps(op.open, sink));

    expect(op.details[0]).toContain('sess-named');
    expect(sink.receipts[0]).toContain('sess-named');
    expect(sink.applied[0]?.sessionId).toBe('sess-named');
  });
});

describe('one answer per run', () => {
  test('a snapshot answered Keep is not offered again by a second offer pass in the same run', async () => {
    // The targeted --continue pre-resume check and the general startup offer
    // can both find the same snapshot in one boot. The first Keep binds both.
    writeCrash('sess-asked-once');
    const first = scriptedOperator(['not-now', 'keep']);
    const sink = makeSink();
    expect(await offerRecoverySnapshot(makeDeps(first.open, sink))).toBe('kept');
    expect(first.asked).toBe(2);

    const second = scriptedOperator(['resume']);
    expect(await offerRecoverySnapshot(makeDeps(second.open, sink))).toBe('kept');
    expect(second.asked).toBe(0); // no modal reopened
    // The snapshot survives untouched for next launch.
    expect(existsSync(surface.recoveryFile('sess-asked-once'))).toBe(true);
  });

  test('a dismissed offer also stays quiet for the rest of the run', async () => {
    writeCrash('sess-dismissed');
    const first = scriptedOperator([null]);
    const sink = makeSink();
    expect(await offerRecoverySnapshot(makeDeps(first.open, sink))).toBe('kept');

    const second = scriptedOperator(['resume']);
    expect(await offerRecoverySnapshot(makeDeps(second.open, sink))).toBe('kept');
    expect(second.asked).toBe(0);
    expect(existsSync(surface.recoveryFile('sess-dismissed'))).toBe(true);
  });

  test('a different session\'s snapshot is still offered after another was kept', async () => {
    writeCrash('sess-kept-a');
    const sink = makeSink();
    expect(await offerRecoverySnapshot(makeDeps(scriptedOperator(['not-now', 'keep']).open, sink))).toBe('kept');

    rmSync(surface.recoveryFile('sess-kept-a'));
    writeCrash('sess-fresh-b');
    const second = scriptedOperator(['not-now', 'keep']);
    expect(await offerRecoverySnapshot(makeDeps(second.open, sink))).toBe('kept');
    expect(second.asked).toBe(2); // genuinely asked about the new session
  });
});


describe('a removal decision outlives the process', () => {
  // The shipped defect: "Remove" deleted the file, and the deletion WAS the
  // memory of the answer. A session still running on an older build rewrites
  // its snapshot every 60s into the directory this build reads, so the file
  // came back and the same question came back with it — three times, each
  // time answered "remove". The decision now lives in a ledger under the
  // surface, and a recorded snapshot found again is discarded, not re-asked.

  /** What a relaunch actually is: fresh in-process memory, a surface rebuilt over the same directories. */
  function relaunch(): SessionSurface {
    resetAnsweredRecoveryOffersForTest();
    surface = makeTestSurface(tmpDir);
    return surface;
  }

  test('Remove records the decision on disk, naming the session and the workspace', async () => {
    writeCrash('sess-durable');
    await offerRecoverySnapshot(makeDeps(scriptedOperator(['not-now', 'remove']).open, makeSink()));

    const ledger = recoveryDecisionsPathFor(surface);
    expect(existsSync(ledger)).toBe(true);
    const records = JSON.parse(readFileSync(ledger, 'utf-8')) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]?.sessionId).toBe('sess-durable');
    expect(records[0]?.workspace).toBe(surface.workingDirectory);
    expect(typeof records[0]?.removedAt).toBe('number');
  });

  test('the same snapshot rewritten byte-for-byte after a relaunch is deleted, not re-offered', async () => {
    writeCrash('sess-comes-back', 'Interrupted work');
    const removedBytes = readFileSync(surface.recoveryFile('sess-comes-back'));
    expect(await offerRecoverySnapshot(makeDeps(scriptedOperator(['not-now', 'remove']).open, makeSink()))).toBe('removed');
    expect(existsSync(surface.recoveryFile('sess-comes-back'))).toBe(false);

    // Exactly what the still-running older build does a minute later.
    relaunch();
    writeFileSync(surface.recoveryFile('sess-comes-back'), removedBytes);
    ageRecoverySnapshot(surface.recoveryFile('sess-comes-back'));

    const second = scriptedOperator(['not-now', 'remove']);
    const sink = makeSink();
    expect(await offerRecoverySnapshot(makeDeps(second.open, sink))).toBe('none');
    expect(second.asked).toBe(0); // not one modal, not one keystroke asked of the user
    expect(sink.receipts).toHaveLength(0); // and no chatter about a decision already made
    // Discarded on sight, because the user already said remove.
    expect(existsSync(surface.recoveryFile('sess-comes-back'))).toBe(false);
  });

  test('Keep is NOT recorded — it means "ask me next launch", and next launch still asks', async () => {
    writeCrash('sess-kept-durable');
    expect(await offerRecoverySnapshot(makeDeps(scriptedOperator(['not-now', 'keep']).open, makeSink()))).toBe('kept');
    expect(existsSync(recoveryDecisionsPathFor(surface))).toBe(false);

    relaunch();
    const second = scriptedOperator(['not-now', 'keep']);
    expect(await offerRecoverySnapshot(makeDeps(second.open, makeSink()))).toBe('kept');
    expect(second.asked).toBe(2);
    expect(existsSync(surface.recoveryFile('sess-kept-durable'))).toBe(true);
  });

  test('a recorded-removed snapshot that reappears does not mask an older genuinely-orphaned one', async () => {
    // Discarding rather than merely skipping is what makes this work: a
    // skipped newer file would sit on top of a real crash snapshot forever.
    writeCrash('sess-reappearing');
    expect(await offerRecoverySnapshot(makeDeps(scriptedOperator(['not-now', 'remove']).open, makeSink()))).toBe('removed');

    relaunch();
    writeCrash('sess-real-crash', 'Real crash', 2, 60_000); // older
    writeCrash('sess-reappearing'); // newer, and already answered

    const second = scriptedOperator(['not-now', 'keep']);
    expect(await offerRecoverySnapshot(makeDeps(second.open, makeSink()))).toBe('kept');
    expect(second.details[0]).toContain('sess-real-crash');
    expect(existsSync(surface.recoveryFile('sess-reappearing'))).toBe(false);
    expect(existsSync(surface.recoveryFile('sess-real-crash'))).toBe(true);
  });

  test('the targeted --continue offer honours a recorded removal too', async () => {
    writeCrash('sess-targeted');
    const deps = { ...makeDeps(scriptedOperator(['not-now', 'remove']).open, makeSink()), targetSessionId: 'sess-targeted' };
    expect(await offerRecoverySnapshot(deps)).toBe('removed');

    relaunch();
    writeCrash('sess-targeted');
    const second = scriptedOperator(['resume']);
    const outcome = await offerRecoverySnapshot({ ...makeDeps(second.open, makeSink()), targetSessionId: 'sess-targeted' });
    expect(outcome).toBe('none');
    expect(second.asked).toBe(0);
    expect(existsSync(surface.recoveryFile('sess-targeted'))).toBe(false);
  });

  test('Remove is recorded even when the file already vanished before the answer landed', async () => {
    writeCrash('sess-raced');
    const op: SelectionOpener = (title, items, opts, cb) => {
      // The offer is up; whatever wrote the snapshot retires it underneath us.
      if (title === RECOVERY_RETIRE_TITLE) rmSync(surface.recoveryFile('sess-raced'), { force: true });
      cb({ item: { id: title === RECOVERY_RETIRE_TITLE ? 'remove' : 'not-now', label: 'x' }, action: 'select' });
    };
    const sink = makeSink();
    expect(await offerRecoverySnapshot(makeDeps(op, sink))).toBe('removed');
    // The receipt says plainly that nothing was there, and does not claim a deletion.
    expect(sink.receipts[0]).toContain('No recovery point was found to remove');

    // The answer still binds: the same snapshot written again is discarded.
    relaunch();
    writeCrash('sess-raced');
    const second = scriptedOperator(['resume']);
    expect(await offerRecoverySnapshot(makeDeps(second.open, makeSink()))).toBe('none');
    expect(second.asked).toBe(0);
    expect(existsSync(surface.recoveryFile('sess-raced'))).toBe(false);
  });
});
