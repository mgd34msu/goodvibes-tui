import { describe, expect, test } from 'bun:test';
import {
  OnboardingWizardController,
  getOnboardingWizardVisibleFieldCount,
} from '../../input/onboarding/onboarding-wizard.ts';
import { renderOnboardingWizard } from '../../renderer/onboarding/onboarding-wizard.ts';
import { linesToText } from '../setup.ts';

describe('renderOnboardingWizard', () => {
  test('renders a viewport-sized onboarding shell with stable chrome', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('edit');

    const width = 100;
    const height = 20;
    const lines = renderOnboardingWizard(wizard, width, height);

    expect(lines).toHaveLength(height);
    for (const line of lines) {
      expect(line.length).toBe(width);
    }

    const text = linesToText(lines).join('\n');
    expect(text).toContain('Onboarding Wizard');
    expect(text).toContain('Summary');
    expect(text).toContain('Steps');
    expect(text).toContain('Controls:');
    expect(text).toContain('Esc');
  });

  test('uses visible frame chrome and readable rail labels on wide terminals', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');

    const text = linesToText(renderOnboardingWizard(wizard, 188, 42)).join('\n');

    expect(text).toContain('┌─Onboarding Wizard');
    expect(text).toContain('1. Capabilities');
    expect(text).not.toContain('Capabilit…');
    expect(text).toContain('Choose what GoodVibes should be able to do.');
  });

  test('shows scroll affordances for the field body when the current step exceeds the visible window', () => {
    const wizard = new OnboardingWizardController();
    wizard.open();
    wizard.selectLast(getOnboardingWizardVisibleFieldCount(14));

    const text = linesToText(renderOnboardingWizard(wizard, 100, 14)).join('\n');

    expect(text).toContain('more above');
    expect(text).toContain('Use Local TUI Only');
  });

  test('does not render raw masked edit buffers', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('edit');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.slack', true);
    wizard.setStep(wizard.steps.findIndex((step) => step.id === 'external-surface:slack'));
    wizard.moveSelection(1, getOnboardingWizardVisibleFieldCount(18));
    wizard.beginEdit('external-services.slack.bot-token');
    wizard.editBuffer = 'sk-secret-value';

    const text = linesToText(renderOnboardingWizard(wizard, 100, 18)).join('\n');

    expect(text).not.toContain('sk-secret-value');
    expect(text).toContain('Editing:');
  });
});
