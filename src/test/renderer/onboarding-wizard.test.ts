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
    expect(text).toContain('Next section');
  });

  test('separates the apply-and-continue action from normal fields', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');

    const textLines = linesToText(renderOnboardingWizard(wizard, 188, 42));
    const applyLine = textLines.findIndex((line) => line.includes('Next section'));
    let previousActionLine = -1;
    for (let index = 0; index < applyLine; index += 1) {
      if (textLines[index]?.includes('Use Local TUI Only (No Servers)')) previousActionLine = index;
    }

    expect(applyLine).toBeGreaterThan(0);
    expect(previousActionLine).toBeGreaterThan(0);
    expect(applyLine - previousActionLine).toBe(3);
  });

  test('a selected field hint far longer than one line renders in full, not clipped to one row', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.component.zeroTrustTunnel', true);

    const cloudflareStepIndex = wizard.steps.findIndex((step) => step.id === 'cloudflare');
    expect(cloudflareStepIndex).toBeGreaterThanOrEqual(0);
    wizard.setStep(cloudflareStepIndex);
    const noticeIndex = wizard.currentStep.fields.findIndex((field) => field.id === 'cloudflare.trust-proxy-notice');
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    wizard.moveSelection(noticeIndex, getOnboardingWizardVisibleFieldCount(40));
    expect(wizard.getSelectedFieldIndex()).toBe(noticeIndex);

    const fullHint =
      'Selecting Zero Trust Tunnel auto-writes controlPlane.trustProxy=true and httpListener.trustProxy=true, ' +
      'so the login rate-limiter keys on the client address the tunnel forwards rather than the tunnel egress ' +
      'address. On their own those two read that address from X-Forwarded-For, which a client reaching the port ' +
      'directly can set for itself. It also writes httpListener.trustCloudflare=true, which is ON for this ' +
      'route: the HTTP listener instead reads CF-Connecting-IP and only accepts it from a peer inside a ' +
      'published Cloudflare range, so a direct client cannot name its own address to pick which rate-limit ' +
      'bucket and audit-log entry it lands in. The control plane has no equivalent setting, so keep it ' +
      'reachable only through the tunnel. See docs/deployment-and-services.md for the full posture.';

    // Narrow (collapsed, single-column) layout: hint rows are the full row
    // width with no side panels, so consecutive wrapped lines can be
    // rejoined and whitespace-normalized back to the source sentence.
    const collapsedText = linesToText(renderOnboardingWizard(wizard, 80, 40))
      .join(' ')
      .replace(/[│┌┐└┘├┤┬┴┼─]/g, ' ')
      .replace(/\s+/g, ' ');
    expect(collapsedText).toContain(fullHint);

    // Wide layout renders the same hint in its center column, alongside an
    // independent left-hand step rail and right-hand summary panel on the
    // same terminal rows, so a plain full-row join interleaves rail/summary
    // text between wrapped hint lines. Checking the sentence's opening and
    // closing fragments both survive is enough to prove neither end was
    // clipped (the collapsed-layout assertion above already proves the
    // wrapping is complete and in order for the shared hintLines logic).
    const wideText = linesToText(renderOnboardingWizard(wizard, 188, 40)).join(' ');
    expect(wideText).toContain('Selecting Zero Trust Tunnel auto-writes controlPlane.trustProxy=true');
    expect(wideText).toContain('for the full posture.');
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
