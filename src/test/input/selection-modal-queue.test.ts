/**
 * Regression tests for the openSelection() overlap defect (see
 * src/input/selection-modal-queue.ts for the full write-up).
 *
 * InputHandler.openSelection used to write into a singleton SelectionModal
 * plus a single callback slot: a second call while one modal was already
 * showing silently overwrote both, and the pre-empted caller's callback was
 * never invoked, not even with null, so any caller that awaits it (the
 * `ask()` shape used throughout runtime/recovery-prompt.ts) hung forever.
 *
 * These tests drive the REAL production path, InputHandler.feed() with raw
 * key bytes ('\r' for Enter, '\x1b' for Escape), so the resolution is
 * exercised through the actual dispatchSelectionAction (select path,
 * handler-modal-routes.ts) and handleEscape (Escape path,
 * handler-modal-stack.ts), not a hand-rolled stand-in for either.
 */
import { describe, test, expect } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@pellux/goodvibes-terminal-shell';
import { InfiniteBuffer } from '@pellux/goodvibes-terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import type { SelectionItem, SelectionResult } from '../../input/selection-modal.ts';
import { MAX_QUEUED_SELECTIONS } from '../../input/selection-modal-queue.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

function mkItems(prefix: string, count: number): SelectionItem[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, label: `${prefix} ${i}` }));
}

function makeHandler(): InputHandler {
  const history = new InfiniteBuffer();
  return new InputHandler(
    () => {},
    new SelectionManager(),
    () => 0,
    () => 20,
    () => history,
    () => {},
    () => {},
    createDefaultUiRuntimeServices(),
  );
}

/** The queue's drain runs on a microtask (see selection-modal-queue.ts); let it settle. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('InputHandler.openSelection: queueing overlapping calls', () => {
  test('two overlapping calls: both callbacks resolve, second opens with its own title/items after the first is answered', async () => {
    const input = makeHandler();
    const resultsA: (SelectionResult | null)[] = [];
    const resultsB: (SelectionResult | null)[] = [];

    input.openSelection('Modal A', mkItems('a', 2), undefined, (r) => resultsA.push(r));
    expect(input.selectionModal.active).toBe(true);
    expect(input.selectionModal.title).toBe('Modal A');

    // Second call while A is showing must NOT overwrite it.
    input.openSelection('Modal B', mkItems('b', 2), undefined, (r) => resultsB.push(r));
    expect(input.selectionModal.title).toBe('Modal A');
    expect(resultsB).toHaveLength(0);

    // Answer A through the real select path (Enter on the highlighted item).
    input.feed('\r');
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0]?.item.id).toBe('a-0');
    expect(resultsB).toHaveLength(0); // drain is deferred, B hasn't opened yet

    await flushMicrotasks();

    // B now opens automatically, with its OWN title/items.
    expect(input.selectionModal.active).toBe(true);
    expect(input.selectionModal.title).toBe('Modal B');
    expect(resultsB).toHaveLength(0);

    input.feed('\r');
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0]?.item.id).toBe('b-0');
    expect(input.selectionModal.active).toBe(false);
  });

  test('first modal dismissed via Escape (null): the second still opens and can be answered', async () => {
    const input = makeHandler();
    const resultsA: (SelectionResult | null)[] = [];
    const resultsB: (SelectionResult | null)[] = [];

    input.openSelection('Modal A', mkItems('a', 2), undefined, (r) => resultsA.push(r));
    input.openSelection('Modal B', mkItems('b', 2), undefined, (r) => resultsB.push(r));

    input.feed('\x1b'); // Escape dismisses A
    expect(resultsA).toEqual([null]);
    expect(resultsB).toHaveLength(0);

    await flushMicrotasks();

    expect(input.selectionModal.active).toBe(true);
    expect(input.selectionModal.title).toBe('Modal B');

    input.feed('\r');
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0]?.item.id).toBe('b-0');
  });

  test('queue overflow: the overflowing caller gets null promptly instead of hanging', () => {
    const input = makeHandler();
    const firstResults: (SelectionResult | null)[] = [];
    input.openSelection('Active', mkItems('active', 1), undefined, (r) => firstResults.push(r));
    expect(input.selectionModal.title).toBe('Active');

    const queuedResults: Array<(SelectionResult | null)[]> = [];
    for (let i = 0; i < MAX_QUEUED_SELECTIONS; i++) {
      const bucket: (SelectionResult | null)[] = [];
      queuedResults.push(bucket);
      input.openSelection(`Queued-${i}`, mkItems(`q${i}`, 1), undefined, (r) => bucket.push(r));
    }
    // The queue is now at its cap (MAX_QUEUED_SELECTIONS). One more call overflows.
    const overflowResult: (SelectionResult | null)[] = [];
    input.openSelection('Overflow', mkItems('overflow', 1), undefined, (r) => overflowResult.push(r));

    // The overflowing caller is answered immediately and synchronously, never left pending.
    expect(overflowResult).toEqual([null]);
    // Nothing that was properly queued (or the active modal) has fired.
    expect(firstResults).toHaveLength(0);
    for (const bucket of queuedResults) expect(bucket).toHaveLength(0);
    expect(input.selectionModal.title).toBe('Active');
  });

  test('production race regression: a liveness-confirm modal vs. a 0ms-macrotask recovery offer both settle', async () => {
    const input = makeHandler();

    // Mirrors the `ask()` helper in runtime/recovery-prompt.ts (and the
    // matching Promise shape in session-resume-liveness-confirm.ts's
    // confirmLiveResume): wraps openSelection's callback in a Promise that
    // resolves to the chosen item's id, or null on cancel/escape.
    function ask(title: string, items: SelectionItem[]): Promise<string | null> {
      return new Promise((resolve) => {
        input.openSelection(title, items, { allowSearch: false, primaryVerbLabel: 'Choose' }, (result) => {
          resolve(result?.item.id ?? null);
        });
      });
    }

    // The --continue liveness-confirm modal opens synchronously (this is the
    // shape of confirmLiveResume in session-resume-liveness-confirm.ts).
    const livenessPromise = ask('Session open elsewhere', mkItems('live', 2));

    // ...while the startup recovery offer is scheduled on a 0ms macrotask,
    // the exact mechanism in scheduleRecoveryOffer (runtime/recovery-prompt.ts).
    const recoveryPromise = new Promise<string | null>((resolve) => {
      setTimeout(() => {
        void ask('Recovery point found', mkItems('recover', 2)).then(resolve);
      }, 0);
    });

    // Before the fix, the recovery offer's openSelection call would have
    // silently overwritten the liveness modal's callback the instant its
    // setTimeout(0) fired, and livenessPromise would never settle.
    expect(input.selectionModal.active).toBe(true);
    expect(input.selectionModal.title).toBe('Session open elsewhere');
    input.feed('\r');

    const first = await livenessPromise;
    expect(first).toBe('live-0');

    // Let the recovery offer's setTimeout(0) and the queue's drain microtask run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(input.selectionModal.active).toBe(true);
    expect(input.selectionModal.title).toBe('Recovery point found');
    input.feed('\r');

    // A real await with a bounded test timeout: a regression here fails the
    // test instead of hanging the suite.
    const second = await recoveryPromise;
    expect(second).toBe('recover-0');
  }, 5000);
});
