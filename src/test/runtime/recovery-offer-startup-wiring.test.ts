/**
 * recovery-offer-startup-wiring.test.ts, proof that the recovery offer is
 * actually reached at startup.
 *
 * The flow (recovery-prompt.ts) and its bindings (recovery-offer-wiring.ts)
 * are covered by their own behavioural tests. What those cannot cover is the
 * one line in main() that invokes them, and a fix that is never invoked is
 * indistinguishable from no fix at all. A sibling repo shipped a pointer
 * arity fix that was inert for exactly this reason: correct code, no caller.
 *
 * main() is the full application composition root (it bootstraps every
 * runtime subsystem, enters raw/alt-screen mode, and only returns when the
 * process exits), so it is not reasonably unit-testable end to end. This pins
 * the source shape instead, the same convention main-boot-line.test.ts uses.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { resetAnsweredRecoveryOffersForTest } from '../../runtime/recovery-prompt.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

beforeEach(() => { resetAnsweredRecoveryOffersForTest(); });

const mainSrc = readFileSync(join(import.meta.dir, '../../main.ts'), 'utf-8');

const OFFER = 'startRecoveryOffer(';
const offerCall = (): string => mainSrc.slice(mainSrc.indexOf(OFFER), mainSrc.indexOf(OFFER) + 400);

describe('the startup recovery offer is wired into main()', () => {
  test('main() calls startRecoveryOffer exactly once', () => {
    expect(mainSrc.match(/startRecoveryOffer\(/g) ?? []).toHaveLength(1);
    expect(mainSrc).toContain("from './runtime/recovery-prompt.ts'");
  });

  test('it is handed the real wiring, not an ad-hoc object assembled at the call site', () => {
    expect(mainSrc).toContain('startRecoveryOffer(buildRecoveryOfferWiring(');
    expect(mainSrc).toContain("from './runtime/recovery-offer-wiring.ts'");
  });

  test('the offer opens BEFORE the first render, so the first frame the user sees already carries it', () => {
    // It used to be scheduled on a macrotask after the first frame, which on a
    // busy boot came seconds after the composer was drawn and took the keys
    // typed into it (live defect: typed text went to the modal, Enter resumed).
    const firstRender = mainSrc.indexOf('conversation.rebuildHistory(); render(); // initial render');
    const offer = mainSrc.indexOf(OFFER);
    expect(offer).toBeGreaterThan(-1);
    expect(firstRender).toBeGreaterThan(offer);
  });

  test('keys typed before the modal was painted are held out of it and replayed afterwards', () => {
    expect(offerCall()).toContain('typeahead: typeaheadHooks');
    expect(mainSrc).toContain('typeahead: typeaheadHooks } });'); // the --continue offer too
    expect(mainSrc).toContain('onModalShown: () => typeahead.arm()');
    expect(mainSrc).toContain('const held = typeahead.release(); if (held.length > 0) routeInput(held);');
    expect(mainSrc).toContain("stdin.on('data', (raw: string) => { const data = typeahead.filter(themeProbe.filterInput(raw));");
    expect(mainSrc).toContain('typeahead.framePainted();');
  });

  test('it is handed the surface-bound pointer writer, so an accepted recovery updates --continue', () => {
    // `writeLastSessionPointer` in main() is the destructured
    // `_writeLastSessionPointer` from the bootstrap context, the closure
    // bindWriteLastSessionPointerToSurface produced. Passing anything else
    // (notably the SDK's raw two-argument export) is the inert-fix shape.
    expect(offerCall()).toContain('writeLastSessionPointer,');
    expect(mainSrc).toContain('_writeLastSessionPointer: writeLastSessionPointer,');
  });

  test('it is handed the one runtime surface, not a locally rebuilt one', () => {
    expect(offerCall()).toContain('surface: ctx.services.surface');
    expect(mainSrc).not.toContain('createSessionSurface(');
  });
});
