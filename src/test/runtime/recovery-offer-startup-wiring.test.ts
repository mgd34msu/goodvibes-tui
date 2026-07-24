/**
 * recovery-offer-startup-wiring.test.ts — proof that the recovery offer is
 * actually reached at startup.
 *
 * The flow (recovery-prompt.ts) and its bindings (recovery-offer-wiring.ts)
 * are covered by their own behavioural tests. What those cannot cover is the
 * one line in main() that invokes them — and a fix that is never invoked is
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

describe('the startup recovery offer is wired into main()', () => {
  test('main() calls scheduleRecoveryOffer exactly once', () => {
    expect(mainSrc.match(/scheduleRecoveryOffer\(/g) ?? []).toHaveLength(1);
    expect(mainSrc).toContain("from './runtime/recovery-prompt.ts'");
  });

  test('it is handed the real wiring, not an ad-hoc object assembled at the call site', () => {
    expect(mainSrc).toContain('scheduleRecoveryOffer(buildRecoveryOfferWiring(');
    expect(mainSrc).toContain("from './runtime/recovery-offer-wiring.ts'");
  });

  test('the offer is scheduled AFTER the first render, so the question is drawn rather than posed at a blank terminal', () => {
    const firstRender = mainSrc.indexOf('\n  render();');
    const offer = mainSrc.indexOf('scheduleRecoveryOffer(');
    expect(firstRender).toBeGreaterThan(-1);
    expect(offer).toBeGreaterThan(firstRender);
  });

  test('it is handed the surface-bound pointer writer, so an accepted recovery updates --continue', () => {
    // `writeLastSessionPointer` in main() is the destructured
    // `_writeLastSessionPointer` from the bootstrap context — the closure
    // bindWriteLastSessionPointerToSurface produced. Passing anything else
    // (notably the SDK's raw two-argument export) is the inert-fix shape.
    const call = mainSrc.slice(mainSrc.indexOf('scheduleRecoveryOffer('), mainSrc.indexOf('scheduleRecoveryOffer(') + 400);
    expect(call).toContain('writeLastSessionPointer,');
    expect(mainSrc).toContain('_writeLastSessionPointer: writeLastSessionPointer,');
  });

  test('it is handed the one runtime surface, not a locally rebuilt one', () => {
    const call = mainSrc.slice(mainSrc.indexOf('scheduleRecoveryOffer('), mainSrc.indexOf('scheduleRecoveryOffer(') + 400);
    expect(call).toContain('surface: ctx.services.surface');
    expect(mainSrc).not.toContain('createSessionSurface(');
  });
});
