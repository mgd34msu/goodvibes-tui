import { describe, expect, test } from 'bun:test';
import { LID_SWITCH_HONEST_SPLIT } from '@pellux/goodvibes-sdk/platform/power';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerPowerRuntimeCommands } from '../../input/commands/power-runtime.ts';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import type { PowerSurfaceState } from '../../core/power-status.ts';

// ---------------------------------------------------------------------------
// STEP 3, the /power command (ops/status idiom + toggle) and the power
// settings domain.
// ---------------------------------------------------------------------------

function makeCtx(initial: PowerSurfaceState): { ctx: CommandContext; printed: string[]; state: { value: PowerSurfaceState } } {
  const printed: string[] = [];
  const state = { value: initial };
  const ctx = {
    print: (t: string) => { printed.push(t); },
    getPowerState: () => state.value,
    setKeepAwake: async (enabled: boolean) => {
      state.value = { ...state.value, keepAwake: enabled, inhibited: enabled || state.value.workReasons.length > 0 };
      return state.value;
    },
  } as unknown as CommandContext;
  return { ctx, printed, state };
}

async function run(sub: string[], ctx: CommandContext): Promise<string> {
  const registry = new CommandRegistry();
  registerPowerRuntimeCommands(registry);
  const printed: string[] = [];
  const orig = ctx.print;
  (ctx as { print: (t: string) => void }).print = (t: string) => { printed.push(t); (orig as (t: string) => void)(t); };
  await registry.execute('power', sub, ctx);
  return printed.join('\n');
}

describe('/power command (STEP 3)', () => {
  test('status shows the held-because reasons and the lid-split note verbatim', async () => {
    const { ctx } = makeCtx({ keepAwake: true, inhibited: true, workReasons: ['a turn is streaming'], note: LID_SWITCH_HONEST_SPLIT });
    const out = await run(['status'], ctx);
    expect(out).toContain('held because a turn is streaming');
    expect(out).toContain('idle sleep blocked; lid-close suspend is controlled by your OS here');
    expect(out).toContain('sleep disabled');
  });

  test('on / off / toggle drive the keep-awake toggle through the seam', async () => {
    const { ctx, state } = makeCtx({ keepAwake: false, inhibited: false, workReasons: [], note: null });
    expect(await run(['on'], ctx)).toContain('Keep-awake ON');
    expect(state.value.keepAwake).toBe(true);
    expect(await run(['toggle'], ctx)).toContain('Keep-awake OFF');
    expect(state.value.keepAwake).toBe(false);
    expect(await run(['on'], ctx)).toContain('Keep-awake ON');
    expect(await run(['off'], ctx)).toContain('Keep-awake OFF');
    expect(state.value.keepAwake).toBe(false);
  });

  test('an off host reports it sleeps on its own schedule', async () => {
    const { ctx } = makeCtx({ keepAwake: false, inhibited: false, workReasons: [], note: null });
    const out = await run(['status'], ctx);
    expect(out).toContain('sleeps on its own schedule');
    expect(out).toContain('Keep-awake is OFF');
  });
});

describe('power settings domain (STEP 3)', () => {
  test('the SDK power.* schema settings surface under the power category', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const power = groups.get('power') ?? [];
    const keys = power.map((e) => e.setting.key);
    // The keep-awake toggle is exactly one boolean, no timer, no AC-only option.
    expect(keys).toContain('power.keepAwake');
    const toggle = power.find((e) => e.setting.key === 'power.keepAwake')!;
    expect(toggle.setting.type).toBe('boolean');
    // The automatic work-inhibition and its honest hard cap also surface.
    expect(keys).toContain('power.inhibitWhileWorking');
    expect(keys).toContain('power.workInhibitMaxMinutes');
  });
});
