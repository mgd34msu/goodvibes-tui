// ---------------------------------------------------------------------------
// reasoning-effort-ratchet.test.ts — the requested level survives a model hop.
//
// The defect these pin: both model-switch paths (`/model <id>` in shell-core.ts
// and the picker's commit path in bootstrap-command-parts.ts) re-resolved the
// reasoning level against the newly selected model, snapping it DOWN to what
// that model offers, and then wrote the snapped value back over config
// `provider.reasoningEffort`. Since the next resolution read that same key as
// its baseline, one hop through a model that caps at 'medium' erased 'xhigh'
// permanently: hopping back to a model that accepts 'xhigh' had nothing left to
// restore, and the only way back was to re-set the level by hand.
//
// The arrangement these tests hold in place:
//   - config `provider.reasoningEffort` is the REQUESTED level, written only
//     when the user explicitly chooses one;
//   - `session.runtime.reasoningEffort` is the EFFECTIVE level for whichever
//     model is serving;
//   - every automatic resolution reads the requested level, never the effective
//     one, so capable -> capped -> capable returns to the requested level on its
//     own;
//   - the honesty the old write-back was defending is kept by DISPLAY: when the
//     effective level is below the requested one, both are shown with the model
//     that caps it named.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ReasoningEffortSpec } from '@pellux/goodvibes-sdk/platform/providers';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerShellCoreCommands } from '../../input/commands/shell-core.ts';
import { createBootstrapCommandActions } from '../../runtime/bootstrap-command-parts.ts';
import {
  describeServingEffort,
  requestedEffortLevel,
  resolveRequestedEffortForServingModel,
  servingEffortForLevel,
  type EffortModelLike,
} from '../../providers/reasoning-effort-surface.ts';

// Ids deliberately outside the SDK's curated family table, so the spec attached
// below is the one under test rather than one the family table supplies.
const CAPABLE_ID = 'test-only-capable-reasoner';
const CAPPED_ID = 'test-only-capped-reasoner';

const CAPABLE_SPEC: ReasoningEffortSpec = {
  kind: 'effort',
  values: ['low', 'medium', 'high', 'xhigh'],
  source: 'catalog',
};
const CAPPED_SPEC: ReasoningEffortSpec = {
  kind: 'effort',
  values: ['low', 'medium'],
  source: 'catalog',
};

interface TestModel extends EffortModelLike {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly registryKey: string;
  readonly reasoningEffort: ReasoningEffortSpec;
}

const CAPABLE: TestModel = {
  id: CAPABLE_ID,
  provider: 'testprov',
  displayName: 'Capable Model',
  registryKey: `testprov:${CAPABLE_ID}`,
  reasoningEffort: CAPABLE_SPEC,
};
const CAPPED: TestModel = {
  id: CAPPED_ID,
  provider: 'testprov',
  displayName: 'Capped Model',
  registryKey: `testprov:${CAPPED_ID}`,
  reasoningEffort: CAPPED_SPEC,
};

/** Minimal config store: records every write so "never written" is assertable. */
function makeConfig(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const writes: Array<{ key: string; value: unknown }> = [];
  return {
    store,
    writes,
    get: (key: string): unknown => store[key],
    set: (key: string, value: unknown): void => {
      store[key] = value;
      writes.push({ key, value });
    },
    setDynamic: (key: string, value: unknown): void => {
      store[key] = value;
      writes.push({ key, value });
    },
    effortWrites: (): unknown[] =>
      writes.filter((w) => w.key === 'provider.reasoningEffort').map((w) => w.value),
  };
}

// ---------------------------------------------------------------------------
// `/model <id>` — the shell-core command path
// ---------------------------------------------------------------------------

function makeCommandContext(config: ReturnType<typeof makeConfig>, printed: string[]) {
  let current: TestModel = CAPABLE;
  const runtime = {
    model: CAPABLE.registryKey,
    provider: CAPABLE.provider,
    debugMode: false,
    systemPrompt: '',
    reasoningEffort: '',
    sessionId: 'session-1',
  };
  const context = {
    session: { runtime },
    provider: {
      providerRegistry: {
        getCurrentModel: () => current,
        tryGet: () => undefined,
      },
    },
    platform: { configManager: config },
    clients: {
      providerApi: {
        selectModel: async (id: string) => {
          current = id === CAPPED.id || id === CAPPED.registryKey ? CAPPED : CAPABLE;
          return {
            providerId: current.provider,
            registryKey: current.registryKey,
            displayName: current.displayName,
          };
        },
        recordModelUsage: async () => {},
      },
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  } as unknown as CommandContext;
  return { context, runtime };
}

describe('/model — the requested level is never overwritten by the snapped one', () => {
  test('capable -> capped -> capable returns to the requested level on its own', async () => {
    const registry = new CommandRegistry();
    registerShellCoreCommands(registry);
    const config = makeConfig({ 'provider.reasoningEffort': 'xhigh', 'provider.model': CAPABLE.registryKey });
    const printed: string[] = [];
    const { context, runtime } = makeCommandContext(config, printed);

    // Hop onto a model that caps at 'medium'.
    await registry.execute('model', [CAPPED.id], context);
    expect(runtime.reasoningEffort).toBe('medium');       // effective level snapped down
    expect(config.store['provider.reasoningEffort']).toBe('xhigh'); // preference intact

    // Hop back. Nothing re-set the level by hand.
    await registry.execute('model', [CAPABLE.id], context);
    expect(runtime.reasoningEffort).toBe('xhigh');
    expect(config.store['provider.reasoningEffort']).toBe('xhigh');

    // The whole round trip wrote the preference key zero times.
    expect(config.effortWrites()).toEqual([]);
  });

  test('the switch line shows both levels and names the model that caps it', async () => {
    const registry = new CommandRegistry();
    registerShellCoreCommands(registry);
    const config = makeConfig({ 'provider.reasoningEffort': 'xhigh' });
    const printed: string[] = [];
    const { context } = makeCommandContext(config, printed);

    await registry.execute('model', [CAPPED.id], context);

    const text = printed.join('\n');
    expect(text).toContain('medium');
    expect(text).toContain('requested xhigh');
    expect(text).toContain('Capped Model caps at medium');
  });

  test('a level the new model does offer is shown as one value, exactly as before', async () => {
    const registry = new CommandRegistry();
    registerShellCoreCommands(registry);
    const config = makeConfig({ 'provider.reasoningEffort': 'medium' });
    const printed: string[] = [];
    const { context, runtime } = makeCommandContext(config, printed);

    await registry.execute('model', [CAPPED.id], context);

    expect(runtime.reasoningEffort).toBe('medium');
    const text = printed.join('\n');
    expect(text).toContain('Reasoning effort: medium');
    expect(text).not.toContain('requested');
  });
});

describe('/effort — an explicit user choice still persists', () => {
  test('setting a level writes the preference and the effective level together', async () => {
    const registry = new CommandRegistry();
    registerShellCoreCommands(registry);
    const config = makeConfig({ 'provider.reasoningEffort': 'medium' });
    const printed: string[] = [];
    const { context, runtime } = makeCommandContext(config, printed);

    await registry.execute('effort', ['xhigh'], context);

    expect(config.store['provider.reasoningEffort']).toBe('xhigh');
    expect(config.effortWrites()).toEqual(['xhigh']);
    expect(runtime.reasoningEffort).toBe('xhigh');
  });

  test('an explicit choice survives a hop through a model that caps lower', async () => {
    const registry = new CommandRegistry();
    registerShellCoreCommands(registry);
    const config = makeConfig({ 'provider.reasoningEffort': 'medium' });
    const printed: string[] = [];
    const { context, runtime } = makeCommandContext(config, printed);

    await registry.execute('effort', ['xhigh'], context);
    await registry.execute('model', [CAPPED.id], context);
    expect(runtime.reasoningEffort).toBe('medium');
    expect(config.store['provider.reasoningEffort']).toBe('xhigh');

    await registry.execute('model', [CAPABLE.id], context);
    expect(runtime.reasoningEffort).toBe('xhigh');
  });
});

describe('/effort — the list opens on the level in effect, not a level the model lacks', () => {
  test('a capped model preselects its own top level, not the lowest one', async () => {
    const registry = new CommandRegistry();
    registerShellCoreCommands(registry);
    const config = makeConfig({ 'provider.reasoningEffort': 'xhigh' });
    const printed: string[] = [];
    const { context } = makeCommandContext(config, printed);
    await registry.execute('model', [CAPPED.id], context);

    let preSelectId: string | undefined;
    (context as unknown as { openSelection: unknown }).openSelection = (
      _title: string,
      _items: unknown,
      options: { preSelectId?: string },
    ): void => { preSelectId = options.preSelectId; };

    await registry.execute('effort', [], context);

    // 'xhigh' is not among the capped model's levels; opening on it would land
    // the cursor on 'low' (index 0) instead of on what is actually running.
    expect(preSelectId).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// The model picker's commit path
// ---------------------------------------------------------------------------

function makePickerActions(config: ReturnType<typeof makeConfig>, logged: string[]) {
  const runtime = {
    model: CAPABLE.registryKey,
    provider: CAPABLE.provider,
    reasoningEffort: '',
    sessionId: 'session-1',
  };
  let current: TestModel = CAPABLE;
  const actions = createBootstrapCommandActions({
    providerRegistry: {
      setCurrentModel: (key: string) => { current = key === CAPPED.registryKey ? CAPPED : CAPABLE; },
      getCurrentModel: () => current,
      setModelContextCap: () => {},
    },
    configManager: config,
    conversation: { log: (text: string) => { logged.push(text); } },
    runtime,
    requestRender: () => {},
  } as never);
  return { actions, runtime };
}

describe('model picker commit — same rules as /model', () => {
  test('capable -> capped -> capable returns to the requested level, preference untouched', () => {
    const config = makeConfig({ 'provider.reasoningEffort': 'xhigh' });
    const logged: string[] = [];
    const { actions, runtime } = makePickerActions(config, logged);

    // No effort STEP ran, so `effort` here is the level carried over from the
    // previously selected model — not a choice.
    actions.completeModelSelection?.({ model: CAPPED, effort: 'xhigh' });
    expect(runtime.reasoningEffort).toBe('medium');
    expect(config.store['provider.reasoningEffort']).toBe('xhigh');

    actions.completeModelSelection?.({ model: CAPABLE, effort: 'medium' });
    expect(runtime.reasoningEffort).toBe('xhigh');
    expect(config.effortWrites()).toEqual([]);
  });

  test('the switch line shows both levels when the model caps the requested one', () => {
    const config = makeConfig({ 'provider.reasoningEffort': 'xhigh' });
    const logged: string[] = [];
    const { actions } = makePickerActions(config, logged);

    actions.completeModelSelection?.({ model: CAPPED, effort: 'xhigh' });

    const text = logged.join('\n');
    expect(text).toContain('effort: medium (requested xhigh; Capped Model caps at medium)');
  });

  test("the picker's effort STEP is a user choice, so it does write the preference", () => {
    const config = makeConfig({ 'provider.reasoningEffort': 'medium' });
    const logged: string[] = [];
    const { actions, runtime } = makePickerActions(config, logged);

    actions.completeModelSelection?.({ model: CAPABLE, effort: 'xhigh', effortChosenByUser: true });

    expect(config.store['provider.reasoningEffort']).toBe('xhigh');
    expect(config.effortWrites()).toEqual(['xhigh']);
    expect(runtime.reasoningEffort).toBe('xhigh');
  });
});

// ---------------------------------------------------------------------------
// The helpers themselves
// ---------------------------------------------------------------------------

describe('requested-level helper', () => {
  test('reads config only — a snapped effective value cannot become the baseline', () => {
    const config = makeConfig({ 'provider.reasoningEffort': 'xhigh' });
    expect(requestedEffortLevel(config as never)).toBe('xhigh');
    const serving = resolveRequestedEffortForServingModel(config as never, CAPPED);
    expect(serving.requested).toBe('xhigh');
    expect(serving.effective).toBe('medium');
    expect(serving.capped).toBe(true);
    expect(serving.note).toContain("isn't available on Capped Model");
  });

  test('an unset preference resolves to nothing rather than a guess', () => {
    const config = makeConfig({});
    const serving = resolveRequestedEffortForServingModel(config as never, CAPPED);
    expect(serving.requested).toBe('');
    expect(serving.effective).toBeUndefined();
    expect(serving.capped).toBe(false);
    expect(describeServingEffort(serving, CAPPED)).toBe('(not set)');
  });

  test('display collapses to a single value when nothing was capped', () => {
    expect(describeServingEffort(servingEffortForLevel('medium', CAPPED), CAPPED)).toBe('medium');
    expect(describeServingEffort(servingEffortForLevel('xhigh', CAPABLE), CAPABLE)).toBe('xhigh');
  });

  test('a model that offers nothing low enough says THAT, not "no configurable level"', () => {
    // Resolution snaps DOWN only, so a request for 'low' against a model whose
    // lowest level is 'high' drops the field. Saying the model has no
    // configurable reasoning would be false — it has levels, just none this low.
    const highOnly: EffortModelLike = {
      id: 'test-only-high-floor-model',
      provider: 'testprov',
      displayName: 'High Floor Model',
      reasoningEffort: { kind: 'effort', values: ['high', 'max'], source: 'catalog' },
    };
    const serving = servingEffortForLevel('low', highOnly);
    expect(serving.effective).toBeUndefined();
    expect(serving.capped).toBe(true);
    expect(describeServingEffort(serving, highOnly))
      .toBe('(not sent) (requested low; High Floor Model offers nothing at or below low)');
  });

  test('a model with no configurable reasoning says so instead of naming a level', () => {
    const inert: EffortModelLike = {
      id: 'test-only-inert-model',
      provider: 'testprov',
      displayName: 'Inert Model',
      reasoningEffort: { kind: 'unavailable', values: [], source: 'catalog' },
    };
    const serving = servingEffortForLevel('high', inert);
    expect(serving.effective).toBeUndefined();
    expect(describeServingEffort(serving, inert))
      .toBe('(not sent) (requested high; Inert Model has no configurable reasoning level)');
  });
});
