/**
 * active-model-agreement.test.ts
 *
 * The header (top-right) and the footer (context-info line) both answer "which
 * backend is serving this session?". They used to answer it from different
 * sources, the header read the provider registry live, the footer read
 * session runtime state that only bootstrap and explicit user switches wrote,
 * so after an automatic failover the header named the fallback backend while
 * the footer went on naming the configured one, indefinitely.
 *
 * These tests drive BOTH surfaces exactly the way main.ts's render frame does:
 * one resolveActiveModelDisplay() call feeds createHeader and createFooter.
 * The invariant asserted is that neither surface ever names the configured
 * backend while a different one is serving.
 */
import { describe, test, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { resolveActiveModelDisplay, createFailoverTurnState } from '../../core/active-model-identity.ts';
import type { ActiveModelInputs } from '../../core/active-model-identity.ts';
import { linesToText } from '../setup.ts';

const W = 140;

/** Render the header and footer from a single resolution, as main.ts does. */
function renderBothSurfaces(inputs: ActiveModelInputs): { header: string; footer: string; note: string } {
  const active = resolveActiveModelDisplay(inputs);
  const header = linesToText(
    UIFactory.createHeader(W, active.headerModel, active.headerProvider, undefined, undefined, '9.9.9', active.divergenceNote),
  ).join('\n');
  const footer = linesToText(UIFactory.createFooter(
    W, '> prompt', { up: 0, down: 0 }, false, 0,
    active.footerModel, 5, undefined, '/workspace/proj', active.footerProvider,
    0, undefined, false, undefined, undefined, 'balanced', true,
    undefined, undefined, undefined, undefined, false, undefined, undefined, undefined, undefined,
    active.divergenceNote,
  )).join('\n');
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
    expect(header).toContain('route-llm (abacusai)');
    expect(footer).toContain('abacusai:route-llm (abacusai)');
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
    expect(header).toContain('gpt-5.6-sol (openai-subscriber)');
    expect(footer).toContain('gpt-5.6-sol (openai-subscriber)');
  });

  test('neither surface claims the configured backend is serving', () => {
    const { header, footer } = renderBothSurfaces(inputs);
    // The configured key may only appear as part of the divergence marker,
    // never as the model/provider pair.
    expect(header).not.toContain('route-llm (abacusai)');
    expect(footer).not.toContain('abacusai:route-llm (abacusai)');
  });

  test('the marker names BOTH: the serving backend and the configured selection it left', () => {
    const { header, footer, note } = renderBothSurfaces(inputs);
    expect(note).toBe('failover from abacusai:route-llm');
    expect(header).toContain('failover from abacusai:route-llm');
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

  test('a narrow header drops to a short marker rather than a half-truncated one', () => {
    // 70 columns: the brand + serving pair + short marker fit; the full
    // marker (which names the configured key) does not.
    const header = linesToText(
      UIFactory.createHeader(70, active.headerModel, active.headerProvider, undefined, undefined, '9.9.9', active.divergenceNote),
    ).join('\n');
    expect(header).toContain('gpt-5.6-sol (openai-subscriber)');
    expect(header).toContain('divergent');
    expect(header).not.toContain('failover from abacus');
  });

  test('a very narrow header keeps the serving backend and drops the marker entirely', () => {
    const header = linesToText(
      UIFactory.createHeader(58, active.headerModel, active.headerProvider, undefined, undefined, '9.9.9', active.divergenceNote),
    ).join('\n');
    expect(header).toContain('gpt-5.6-sol (openai-subscriber)');
    expect(header).not.toContain('divergent');
    expect(header).not.toContain('abacusai');
  });

  test('a narrow footer drops the whole marker segment, never half of it', () => {
    // 78 columns: wide enough for cwd + the serving pair, too narrow to also
    // carry the marker, so joinPrioritizedSegments drops that segment whole.
    const footer = linesToText(UIFactory.createFooter(
      78, '> p', { up: 0, down: 0 }, false, 0,
      active.footerModel, 5, undefined, '/proj', active.footerProvider,
      0, undefined, false, undefined, undefined, 'balanced', true,
      undefined, undefined, undefined, undefined, false, undefined, undefined, undefined, undefined,
      active.divergenceNote,
    )).join('\n');
    // Whatever survives, the model segment is the SERVING backend and no
    // partial word of the marker is left behind.
    expect(footer).toContain('gpt-5.6-sol (openai-subscriber)');
    expect(footer).not.toContain('failover');
    expect(footer).not.toContain('abacus');
  });
});
