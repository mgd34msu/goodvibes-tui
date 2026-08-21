import { describe, expect, test } from 'bun:test';
import { LID_SWITCH_HONEST_SPLIT } from '@pellux/goodvibes-sdk/platform/power';
import {
  IDLE_POWER_STATE,
  SLEEP_DISABLED_CHIP,
  powerStatusLines,
  powerSurfaceFromEvent,
  hasLidSplitNote,
  type PowerSurfaceState,
} from '../../core/power-status.ts';

// ---------------------------------------------------------------------------
// STEP 3, power surfaces. The ops/status projection: the "sleep disabled"
// chip meaning, "held because X" work-inhibition reasons, and the honest
// lid-split note rendered VERBATIM when the SDK serves it.
// ---------------------------------------------------------------------------

describe('powerStatusLines (STEP 3)', () => {
  test('keep-awake on: the sleep-disabled meaning leads the status', () => {
    const state: PowerSurfaceState = { keepAwake: true, inhibited: true, workReasons: [], note: null };
    const lines = powerStatusLines(state);
    expect(lines[0]).toContain(SLEEP_DISABLED_CHIP);
    expect(lines[0]).toContain('will not idle-sleep');
  });

  test('"held because X" renders one honest line per work-inhibition reason', () => {
    const state: PowerSurfaceState = {
      keepAwake: false,
      inhibited: true,
      workReasons: ['a turn is streaming', 'an agent is active'],
      note: null,
    };
    const lines = powerStatusLines(state);
    expect(lines).toContain('held because a turn is streaming');
    expect(lines).toContain('held because an agent is active');
  });

  test('the honest lid-split note renders verbatim when served', () => {
    const state: PowerSurfaceState = { keepAwake: true, inhibited: true, workReasons: [], note: LID_SWITCH_HONEST_SPLIT };
    const lines = powerStatusLines(state);
    expect(lines).toContain('idle sleep blocked; lid-close suspend is controlled by your OS here');
    expect(lines).toContain(LID_SWITCH_HONEST_SPLIT); // byte-for-byte
    expect(hasLidSplitNote(state)).toBe(true);
  });

  test('nothing held: an honest "sleeps on its own schedule" line, not silence', () => {
    const lines = powerStatusLines(IDLE_POWER_STATE);
    expect(lines).toEqual(['sleep is not being held; the host sleeps on its own schedule']);
    expect(hasLidSplitNote(IDLE_POWER_STATE)).toBe(false);
  });
});

describe('powerSurfaceFromEvent (STEP 3)', () => {
  test('flattens an OPS_POWER_STATE_CHANGED payload, defaulting an absent note to null', () => {
    const s = powerSurfaceFromEvent({ inhibited: true, keepAwake: true, workReasons: ['x'] });
    expect(s).toEqual({ keepAwake: true, inhibited: true, workReasons: ['x'], note: null });
  });
});
