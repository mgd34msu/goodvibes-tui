/**
 * active-model-agreement.test.ts
 *
 * The header (top-right) and the composer's inner row both answer "which
 * backend is serving this session?". They used to answer it from different
 * sources, the header read the provider registry live, the footer read
 * session runtime state that only bootstrap and explicit user switches wrote,
 * so after an automatic failover the header named the fallback backend while
 * the footer went on naming the configured one, indefinitely.
 *
 * These tests drive BOTH surfaces exactly the way main.ts's render frame does:
 * one resolveActiveModelDisplay() call feeds createHeader and buildShellFooter.
 * The failover marker lives on the composer's inner row, next to the provider.
 * The invariant asserted is that neither surface ever names the configured
 * backend while a different one is serving.
 */
import { describe, test, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { resolveActiveModelDisplay, createFailoverTurnState } from '../../core/active-model-identity.ts';
import type { ActiveModelInputs } from '../../core/active-model-identity.ts';
import { linesToText } from '../setup.ts';

const W = 140;

function renderFooter(width: number, model: string, provider: string, note: string): string {
  return linesToText(buildShellFooter({
    width, promptText: 'prompt', promptLineCount: 1, usage: { up: 0, down: 0 }, showExitNotice: false, lastCopyTime: 0,
    model, provider, modelNote: note, workingDir: '/workspace/proj', contextWindow: 0,
    runningAgentCount: 0, runningProcessCount: 0, indicatorFocused: false,
  }).lines).join('\n');
}

/** Render the header and footer from a single resolution, as main.ts does. */
function renderBothSurfaces(inputs: ActiveModelInputs): { header: string; footer: string; note: string } {
  const active = resolveActiveModelDisplay(inputs);
  const header = linesToText(UIFactory.createHeader(W, active.headerModel, undefined, undefined, '9.9.9')).join('\n');
  const footer = renderFooter(W, active.footerModel, active.footerProvider, active.divergenceNote);
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
    expect(footer).toContain('abacusai:route-llm abacusai');
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

  test('both surfaces name the SERVING backend', () => {
    const { header, footer } = renderBothSurfaces(inputs);
    expect(header).toContain('gpt-5.6-sol');
    expect(footer).toMatch(/gpt-5\.6-sol openai-subscriber/);
  });

  test('neither surface claims the configured backend is serving', () => {
    const { header, footer } = renderBothSurfaces(inputs);
    // The configured key may only appear as part of the divergence marker,
    // never as the model/provider pair.
    expect(header).not.toContain('route-llm');
    expect(footer).not.toContain('abacusai:route-llm abacusai');
  });

  test('the marker names BOTH: the serving backend and the configured selection it left', () => {
    const { header, footer, note } = renderBothSurfaces(inputs);
    expect(note).toBe('failover from abacusai:route-llm');
    // The marker sits beside the provider on the composer, not in the header.
    expect(header).not.toContain('failover');
    expect(footer).toContain('failover from abacusai:route-llm');
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

  test('the header always names the serving backend and never the configured one', () => {
    for (const width of [58, 70, 140]) {
      const header = linesToText(UIFactory.createHeader(width, active.headerModel, undefined, undefined, '9.9.9')).join('\n');
      expect(header).toContain('gpt-5.6-sol');
      expect(header).not.toContain('abacusai');
    }
  });

  test('a narrow composer drops to a short marker rather than a half-truncated one', () => {
    const footer = renderFooter(62, active.footerModel, active.footerProvider, active.divergenceNote);
    expect(footer).toContain('divergent');
    expect(footer).not.toContain('failover from abacus');
  });

  test('a very narrow composer keeps the serving backend and drops the marker whole, never half of it', () => {
    const footer = renderFooter(48, active.footerModel, active.footerProvider, active.divergenceNote);
    expect(footer).toContain('gpt-5.6-sol');
    expect(footer).not.toContain('failover');
    expect(footer).not.toContain('abacus');
  });
});
