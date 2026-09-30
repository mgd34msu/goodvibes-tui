/**
 * recovery-offer-typeahead.test.ts, keys typed before the recovery offer
 * appeared never answer it.
 *
 * Live defect: the "Resume it" modal opened a few seconds after the composer
 * was drawn, so text typed into the composer went into the modal and the
 * Enter that ended it resumed the snapshot. The fix opens the offer before the
 * first frame (startRecoveryOffer, synchronous) and holds typeahead out of the
 * modal (startup-typeahead-gate.ts), replaying it into the composer once the
 * offer is answered. These tests drive the real InputHandler and the real
 * recovery flow against a snapshot on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { writeRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { SelectionManager, InfiniteBuffer } from '@pellux/goodvibes-terminal-shell';
import { InputHandler } from '../../input/handler.ts';
import {
  offerRecoverySnapshot,
  RECOVERY_OFFER_TITLE,
  resetAnsweredRecoveryOffersForTest,
  startRecoveryOffer,
  type RecoveryPromptDeps,
} from '../../runtime/recovery-prompt.ts';
import { createStartupTypeaheadGate } from '../../runtime/startup-typeahead-gate.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ageRecoverySnapshot, makeTestSurface } from '../helpers/session-surface.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

let tmpDir: string;
let surface: SessionSurface;

beforeEach(() => {
  resetAnsweredRecoveryOffersForTest();
  tmpDir = makeProjectTempDir('gv-recovery-typeahead');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

function writeCrash(sessionId: string): void {
  writeRecoveryFile(
    { messages: [{ role: 'user', content: 'm0' }, { role: 'assistant', content: 'm1' }] as never, title: 'Interrupted', titleSource: 'system', timestamp: Date.now() - 120_000 },
    sessionId,
    'Interrupted',
    { surface },
  );
  ageRecoverySnapshot(surface.recoveryFile(sessionId), 0);
}

function makeHandler(submitted: string[]): InputHandler {
  const history = new InfiniteBuffer();
  const input = new InputHandler(() => {}, new SelectionManager(), () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());
  input.commandContext = { submitInput: (text: string) => { submitted.push(text); } } as never;
  return input;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('startup typeahead gate', () => {
  function clock(): { now: () => number; advance: (ms: number) => void } {
    let t = 0;
    return { now: () => t, advance: (ms) => { t += ms; } };
  }

  test('passes everything through while no startup modal is armed', () => {
    const gate = createStartupTypeaheadGate();
    expect(gate.filter('abc')).toBe('abc');
    expect(gate.release()).toBe('');
  });

  test('holds input that arrives before the modal was painted, and a burst that continues after it', () => {
    const c = clock();
    const gate = createStartupTypeaheadGate({ now: c.now });
    gate.arm();
    expect(gate.filter('hel')).toBe(''); // typed during boot, before any frame
    c.advance(2000);
    gate.framePainted();
    c.advance(5);
    expect(gate.filter('lo')).toBe(''); // queued keys delivered right after the paint
    c.advance(400);
    expect(gate.filter('\r')).toBe(''); // same burst: 400 ms after the last key
    c.advance(900);
    expect(gate.filter('\x1b[B')).toBe('\x1b[B'); // after a pause: an answer
    c.advance(10);
    expect(gate.filter('\r')).toBe('\r'); // and from then on the modal gets everything
    expect(gate.release()).toBe('hello\r');
    expect(gate.filter('x')).toBe('x');
  });

  test('a key after the settle window with nothing held is an answer', () => {
    const c = clock();
    const gate = createStartupTypeaheadGate({ now: c.now });
    gate.arm();
    gate.framePainted();
    c.advance(600);
    expect(gate.filter('\x1b[B')).toBe('\x1b[B');
  });

  test('mouse reports and focus events are never held', () => {
    const gate = createStartupTypeaheadGate();
    gate.arm();
    expect(gate.filter('\x1b[<0;10;5M')).toBe('\x1b[<0;10;5M');
    expect(gate.filter('\x1b[I')).toBe('\x1b[I');
    expect(gate.release()).toBe('');
  });
});

describe('the offer hooks', () => {
  test('startRecoveryOffer has the modal open before it returns (it can be drawn in the first frame)', () => {
    writeCrash('sess-sync');
    const opened: string[] = [];
    const events: string[] = [];
    const deps: RecoveryPromptDeps = {
      surface,
      openSelection: (title) => { opened.push(title); events.push('open'); },
      applySnapshot: () => { throw new Error('never applied here'); },
      receipt: () => {},
      render: () => {},
      typeahead: { onModalShown: () => events.push('armed'), onFlowSettled: () => events.push('settled') },
    };
    void startRecoveryOffer(deps);
    expect(opened).toEqual([RECOVERY_OFFER_TITLE]);
    expect(events).toEqual(['armed', 'open']); // armed before the modal can take a key
  });

  test('no snapshot: nothing is armed and nothing is held', async () => {
    const events: string[] = [];
    const outcome = await offerRecoverySnapshot({
      surface,
      openSelection: () => { events.push('open'); },
      applySnapshot: () => { throw new Error('unreachable'); },
      receipt: () => {},
      render: () => {},
      typeahead: { onModalShown: () => events.push('armed'), onFlowSettled: () => events.push('settled') },
    });
    expect(outcome).toBe('none');
    expect(events).toEqual([]);
  });
});

describe('typing before the offer appeared, through the real input handler', () => {
  test('typed text and its Enter never answer the modal; they land in the composer after the offer is declined', async () => {
    writeCrash('sess-typed');
    const submitted: string[] = [];
    const input = makeHandler(submitted);
    let t = 0;
    const gate = createStartupTypeaheadGate({ now: () => t });
    const applied: string[] = [];
    const stdin = (bytes: string): void => { const pass = gate.filter(bytes); if (pass.length > 0) input.feed(pass); };

    const outcome = startRecoveryOffer({
      surface,
      openSelection: input.openSelection.bind(input),
      applySnapshot: ({ sessionId }) => { applied.push(sessionId); return { applied: false, refusal: 'no-snapshot' } as never; },
      receipt: () => {},
      render: () => {},
      typeahead: { onModalShown: () => gate.arm(), onFlowSettled: () => { const held = gate.release(); if (held) input.feed(held); } },
    });
    expect(input.selectionModal.active).toBe(true); // open before the first frame

    // Typed during boot; the terminal hands the bytes over after the first paint.
    stdin('hello');
    t = 1_000;
    gate.framePainted();
    t = 1_003;
    stdin('\r');
    expect(input.selectionModal.active).toBe(true);
    expect(applied).toEqual([]); // the Enter did not resume

    // The user sees the question and declines it: Down, Enter, then Enter on Keep.
    t = 3_000;
    stdin('\x1b[B');
    stdin('\r');
    await settle();
    stdin('\r');
    expect(await outcome).toBe('kept');
    await settle();

    expect(applied).toEqual([]);
    expect(existsSync(surface.recoveryFile('sess-typed'))).toBe(true);
    expect(submitted).toEqual(['hello']); // nothing lost, nothing misrouted
  });
});
