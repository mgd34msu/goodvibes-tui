/**
 * active-model-agreement.test.ts
 *
 * The header is the one place that answers "which backend is serving this
 * session?". It once shared that job with the composer, which read session
 * runtime state that only bootstrap and explicit user switches wrote, so after
 * an automatic failover the two named different backends indefinitely.
 *
 * These tests drive the surfaces the way main.ts's render frame does: one
 * resolveActiveModelDisplay() call feeds createHeader (model and failover
 * marker) and buildShellFooter (which prices the cost against the model but
 * never draws it). The invariant asserted is that nothing on screen names the
 * configured backend as serving while a different one is.
 */
import { describe, test, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { resolveActiveModelDisplay, createFailoverTurnState } from '../../core/active-model-identity.ts';
import type { ActiveModelInputs } from '../../core/active-model-identity.ts';
import { linesToText } from '../setup.ts';

const W = 140;

function renderFooter(width: number, model: string): string {
  return linesToText(buildShellFooter({
    width, promptText: 'prompt', promptLineCount: 1, usage: { up: 0, down: 0 }, showExitNotice: false, lastCopyTime: 0,
    model, workingDir: '/workspace/proj', contextWindow: 0,
    runningAgentCount: 0, runningProcessCount: 0, indicatorFocused: false,
  }).lines).join('\n');
}

function renderHeader(width: number, model: string, note: string): string {
  return linesToText(UIFactory.createHeader(width, model, undefined, undefined, '9.9.9', note)).join('\n');
}

/** Render the header and footer from a single resolution, as main.ts does. */
function renderBothSurfaces(inputs: ActiveModelInputs): { header: string; footer: string; note: string } {
  const active = resolveActiveModelDisplay(inputs);
  const header = renderHeader(W, active.headerModel, active.divergenceNote);
  const footer = renderFooter(W, active.footerModel);
  return { header, footer, note: active.divergenceNote };
}

/** The owner-reported configuration: a paid API backend the user selected. */
const CONFIGURED = {
  registryKey: 'abacusai:route-llm',
  label: 'abacusai:route-llm',
  provider: 'abacusai',
};

/** The backend failover moved serving to: the owner's own OpenAI subscription. */
const SERVING_FALLBACK = {
  id: 'gpt-5.6-sol',
  provider: 'openai-subscriber',
  registryKey: 'openai-subscriber:gpt-5.6-sol',
};

describe('resolveActiveModelDisplay: no divergence', () => {
  test('serving is the configured selection: both surfaces render as they always have', () => {
    const { header, footer, note } = renderBothSurfaces({
      serving: { id: 'route-llm', provider: 'abacusai', registryKey: CONFIGURED.registryKey },
      configuredRegistryKey: CONFIGURED.registryKey,
      configuredLabel: CONFIGURED.label,
      configuredProvider: CONFIGURED.provider,
      failover: null,
    });

    expect(note).toBe('');
    expect(header).toContain('route-llm');
    expect(footer).not.toContain('route-llm');
    expect(header).not.toContain('failover');
    expect(footer).not.toContain('failover');
  });

  test('a configured value stored as a bare model id is not mistaken for divergence', () => {
    const { note } = renderBothSurfaces({
      serving: { id: 'route-llm', provider: 'abacusai', registryKey: 'abacusai:route-llm' },
      configuredRegistryKey: 'route-llm',
      configuredLabel: 'route-llm',
      configuredProvider: 'abacusai',
      failover: null,
    });

    expect(note).toBe('');
  });

  test('an unknown live registry key reports no divergence rather than guessing', () => {
    const { note } = renderBothSurfaces({
      serving: { id: 'route-llm', provider: 'abacusai', registryKey: undefined },
      configuredRegistryKey: CONFIGURED.registryKey,
      configuredLabel: CONFIGURED.label,
      configuredProvider: CONFIGURED.provider,
      failover: null,
    });

    expect(note).toBe('');
  });
});

describe('header and footer agree during an active failover', () => {
  const failoverState = createFailoverTurnState();
  failoverState.begin({
    configuredRegistryKey: CONFIGURED.registryKey,
    servingRegistryKey: SERVING_FALLBACK.registryKey,
  });
  const inputs: ActiveModelInputs = {
    serving: SERVING_FALLBACK,
    configuredRegistryKey: CONFIGURED.registryKey,
    configuredLabel: CONFIGURED.label,
    configuredProvider: CONFIGURED.provider,
    failover: failoverState.current(),
  };

  test('the header names the SERVING backend; the footer names no model at all', () => {
    const { header, footer } = renderBothSurfaces(inputs);
    expect(header).toContain('gpt-5.6-sol');
    expect(footer).not.toContain('gpt-5.6-sol');
    expect(footer).not.toContain('openai-subscriber');
  });

  test('neither surface claims the configured backend is serving', () => {
    const { header, footer } = renderBothSurfaces(inputs);
    // The configured key may only appear as part of the divergence marker,
    // never as the model/provider pair.
    expect(header.replace('failover from abacusai:route-llm', '')).not.toContain('route-llm');
    expect(footer).not.toContain('abacusai');
  });

  test('the marker names BOTH: the serving backend and the configured selection it left', () => {
    const { header, footer, note } = renderBothSurfaces(inputs);
    expect(note).toBe('failover from abacusai:route-llm');
    // The marker follows the model in the header; the composer holds only input.
    expect(header).toContain('gpt-5.6-sol · failover from abacusai:route-llm');
    expect(footer).not.toContain('failover');
  });

  test('every rendered line still fits the terminal width', () => {
    const { header, footer } = renderBothSurfaces(inputs);
    for (const line of [...header.split('\n'), ...footer.split('\n')]) {
      expect(line.length).toBeLessThanOrEqual(W);
    }
  });

  test('a divergence with no failover record is described without claiming a cause', () => {
    const { note } = renderBothSurfaces({ ...inputs, failover: null });
    expect(note).toBe('not the configured abacusai:route-llm');
    expect(note).not.toContain('failover');
  });
});

describe('the divergence marker degrades without ever lying', () => {
  const active = resolveActiveModelDisplay({
    serving: SERVING_FALLBACK,
    configuredRegistryKey: CONFIGURED.registryKey,
    configuredLabel: CONFIGURED.label,
    configuredProvider: CONFIGURED.provider,
    failover: { configuredRegistryKey: CONFIGURED.registryKey, servingRegistryKey: SERVING_FALLBACK.registryKey },
  });

  test('the header always names the serving backend and never claims the configured one serves', () => {
    for (const width of [40, 58, 70, 140]) {
      const header = renderHeader(width, active.headerModel, active.divergenceNote);
      expect(header).toContain('gpt-5.6-sol');
      expect(header.replace('failover from abacusai:route-llm', '')).not.toContain('abacusai');
    }
  });

  test('a narrow header drops to a short marker rather than a half-truncated one', () => {
    const header = renderHeader(58, active.headerModel, active.divergenceNote);
    expect(header).toContain('gpt-5.6-sol · divergent');
    expect(header).not.toContain('failover from abacus');
  });

  test('a very narrow header keeps the serving backend and drops the marker whole, never half of it', () => {
    const header = renderHeader(36, active.headerModel, active.divergenceNote);
    expect(header).toContain('gpt-5.6-sol');
    expect(header).not.toContain('divergent');
    expect(header).not.toContain('failover');
    expect(header).not.toContain('abacus');
  });

  test('the full marker shows when the header has room', () => {
    expect(renderHeader(140, active.headerModel, active.divergenceNote)).toContain('gpt-5.6-sol · failover from abacusai:route-llm');
  });
});
