import { describe, expect, test } from 'bun:test';
import { SelectionModal } from '../../input/selection-modal.ts';
import { renderSelectionModalOverlay } from '../../renderer/selection-modal-overlay.ts';
import { OnboardingWizardController } from '../../input/onboarding/onboarding-wizard.ts';
import { renderOnboardingWizard } from '../../renderer/onboarding/onboarding-wizard.ts';
import { makeOnboardingSnapshot } from '../helpers/onboarding-snapshot.ts';
import { linesToText } from '../setup.ts';

function overlayText(modal: SelectionModal, width: number): { lines: string[]; text: string } {
  const cells = renderSelectionModalOverlay(modal, width);
  for (const line of cells) expect(line.length).toBe(width);
  const lines = cells.map((line) => line.map((cell) => cell.char).join(''));
  return { lines, text: lines.join('\n') };
}

describe('provider repair rows render', () => {
  // The executable repair row's full text must be readable at both widths.
  for (const width of [80, 60]) {
    test(`repair rows render intact at width ${width}`, () => {
      const modal = new SelectionModal();
      modal.open('Repair acme', [
        { id: '0', label: 'Store an API key for acme', detail: 'runs /secrets set ACME_API_KEY', primaryAction: 'select' },
        { id: '1', label: 'Rotate the key in the dashboard', detail: 'manual step (nothing to run)', primaryAction: 'select' },
      ], { primaryVerbLabel: 'Run' });
      const { text } = overlayText(modal, width);
      expect(text).toContain('Repair acme');
      expect(text).toContain('Store an API key for acme');
      expect(text).toContain('Rotate the key in the dashboard');
    });
  }
});

describe('onboarding provider step renders provider-agnostic key fields', () => {
  function providerStepController(): OnboardingWizardController {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState(
      {
        snapshot: makeOnboardingSnapshot({
          providerAccounts: {
            capturedAt: 1,
            configuredCount: 0,
            issueCount: 0,
            providers: [
              {
                providerId: 'acme',
                configured: false,
                active: false,
                oauthReady: false,
                pendingLogin: false,
                availableRoutes: ['api-key'],
                activeRoute: 'unconfigured',
                authFreshness: 'unconfigured',
                apiKeyEnvVar: 'ACME_API_KEY',
              },
            ],
          },
        }),
      },
      { resetValues: true },
    );
    const providerIndex = wizard.steps.findIndex((step) => step.id === 'provider-access');
    expect(providerIndex).toBeGreaterThanOrEqual(0);
    wizard.setStep(providerIndex);
    return wizard;
  }

  for (const [width, height] of [[80, 24], [60, 24]] as const) {
    test(`provider-agnostic key field label shows at ${width}x${height}`, () => {
      const wizard = providerStepController();
      const lines = renderOnboardingWizard(wizard, width, height);
      expect(lines).toHaveLength(height);
      for (const line of lines) expect(line.length).toBe(width);
      const text = linesToText(lines).join('\n');
      expect(text).toContain('acme API key');
      // The retired single-vendor phrasing must be gone from the step copy.
      expect(text).not.toContain('add an OpenAI API key');
    });
  }
});
