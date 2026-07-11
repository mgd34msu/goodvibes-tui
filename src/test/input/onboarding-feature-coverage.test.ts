/**
 * Onboarding feature coverage + cross-surface consistency (brief items 3 & 5).
 *
 * Guarantees:
 *  - every SDK feature flag is REACHABLE in onboarding (as a surface side-effect,
 *    the HITL experience step, or a guided feature unit);
 *  - enabling a guided feature writes BOTH its gating flag and its config — no
 *    onboarding-writable gated config key is emitted without its flag (the class
 *    of bug the inert-hitlMode fix closed);
 *  - a default-on feature turned off persists a disabled override, and a run that
 *    accepts the defaults writes no feature-flag override;
 *  - the settings-modal structure and the onboarding feature table agree on the
 *    flag id set (FEATURE_FLAG_CONFIG is the single source).
 */
import { describe, test, expect } from 'bun:test';
import { FEATURE_FLAGS, FEATURE_FLAG_CONFIG } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { OnboardingWizardController } from '../../input/onboarding/onboarding-wizard.ts';
import { getServerSurfaceFeatureFlags } from '../../runtime/surface-feature-flags.ts';
import { EXTERNAL_SURFACE_SPECS } from '../../input/onboarding/onboarding-wizard-external-surfaces.ts';
import {
  FEATURE_ONBOARDING_SECTIONS,
  getFeatureOnboardingFlagIds,
  featureEnableFieldId,
  featureSubOptionFieldId,
  isFeatureDefaultOn,
} from '../../input/onboarding/onboarding-feature-units.ts';

/** The flags onboarding reaches as surface/server side-effects (via capability + external-surface selection). */
function surfaceReachableFlags(): Set<string> {
  return new Set(getServerSurfaceFeatureFlags({
    serverBacked: true,
    web: true,
    externalSurfaces: EXTERNAL_SURFACE_SPECS.map((surface) => surface.id),
  }));
}

describe('onboarding feature coverage', () => {
  test('every feature flag is reachable in onboarding', () => {
    const reachable = new Set<string>([
      ...getFeatureOnboardingFlagIds(),
      'hitl-ux-modes', // reached via the Experience step (behavior.hitlMode + gating flag)
      ...surfaceReachableFlags(),
    ]);
    const unreachable = FEATURE_FLAGS.map((flag) => flag.id).filter((id) => !reachable.has(id));
    expect(unreachable).toEqual([]);
  });

  test('the guided feature units and the surface/hitl set partition the flags with no overlap', () => {
    const guided = getFeatureOnboardingFlagIds();
    // No flag appears twice across the guided sections.
    expect(new Set(guided).size).toBe(guided.length);
    // Guided units never re-cover a surface/server flag or the hitl flag (those
    // are owned by the surface selection and Experience step respectively), so a
    // feature is managed by exactly one onboarding flow.
    const surfaceAndHitl = new Set<string>([...surfaceReachableFlags(), 'hitl-ux-modes']);
    for (const id of guided) expect(surfaceAndHitl.has(id)).toBe(false);
  });

  test('every settings-modal feature (FEATURE_FLAG_CONFIG) is a real flag and vice versa — one source', () => {
    const configIds = new Set(Object.keys(FEATURE_FLAG_CONFIG));
    const flagIds = new Set(FEATURE_FLAGS.map((f) => f.id));
    expect(configIds).toEqual(flagIds);
  });

  test('enabling a guided feature writes its gating flag AND its config together', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    // Turn on a representative unit with implied config + an enum sub-option.
    wizard.setFieldValue(featureEnableFieldId('exec-sandbox'), true);
    wizard.setFieldValue(featureEnableFieldId('fetch-sanitization'), true);
    wizard.setFieldValue(featureSubOptionFieldId('fetch-sanitization', 'mode'), 'strict');
    // A prerequisite chain: remote export pulls in the otel foundation flag.
    wizard.setFieldValue(featureEnableFieldId('otel-remote-export'), true);
    wizard.setFieldValue(featureSubOptionFieldId('otel-remote-export', 'endpoint'), 'http://localhost:4317');

    const config = new Map<string, unknown>();
    for (const op of wizard.buildApplyRequest().operations) {
      if (op.kind === 'set-config') config.set(op.key, op.value);
    }

    expect(config.get('featureFlags.exec-sandbox')).toBe('enabled');
    expect(config.get('sandbox.enabled')).toBe(true); // implied config
    expect(config.get('featureFlags.fetch-sanitization')).toBe('enabled');
    expect(config.get('fetch.sanitizeMode')).toBe('strict'); // enum sub-option
    expect(config.get('featureFlags.otel-remote-export')).toBe('enabled');
    expect(config.get('featureFlags.otel-foundation')).toBe('enabled'); // prerequisite flag
    expect(config.get('telemetry.decisionOtlpEnabled')).toBe(true); // implied config
    expect(config.get('telemetry.decisionOtlpEndpoint')).toBe('http://localhost:4317'); // text sub-option
  });

  test('no gated config key is ever written without its gating flag enabled', () => {
    // Enable every guided feature and pick a non-default sub-option where present.
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    for (const section of FEATURE_ONBOARDING_SECTIONS) {
      for (const unit of section.units) {
        wizard.setFieldValue(featureEnableFieldId(unit.flagId), true);
      }
    }

    const config = new Map<string, unknown>();
    for (const op of wizard.buildApplyRequest().operations) {
      if (op.kind === 'set-config') config.set(op.key, op.value);
    }

    for (const section of FEATURE_ONBOARDING_SECTIONS) {
      for (const unit of section.units) {
        const writesConfig = (unit.impliedConfig?.length ?? 0) > 0 || (unit.subOptions?.length ?? 0) > 0;
        if (!writesConfig) continue;
        // If the unit contributed any config, its flag must be enabled in the same batch.
        expect(config.get(`featureFlags.${unit.flagId}`)).toBe('enabled');
        for (const implied of unit.impliedConfig ?? []) {
          expect(config.has(implied.key)).toBe(true);
        }
      }
    }
  });

  test('turning off a default-on feature persists a disabled override; defaults write nothing', () => {
    // Default run: no feature toggles touched → no feature-flag override at all.
    const untouched = new OnboardingWizardController();
    untouched.open('new');
    const untouchedFlags = new Set<string>();
    for (const op of untouched.buildApplyRequest().operations) {
      if (op.kind === 'set-config' && op.key.startsWith('featureFlags.')) untouchedFlags.add(op.key);
    }
    for (const id of getFeatureOnboardingFlagIds()) {
      expect(untouchedFlags.has(`featureFlags.${id}`)).toBe(false);
    }

    // Turn OFF a default-on feature → a disabled override is persisted.
    const defaultOnFlag = getFeatureOnboardingFlagIds().find((id) => isFeatureDefaultOn(id))!;
    expect(defaultOnFlag).toBeDefined();
    const off = new OnboardingWizardController();
    off.open('new');
    off.setFieldValue(featureEnableFieldId(defaultOnFlag), false);
    const offConfig = new Map<string, unknown>();
    for (const op of off.buildApplyRequest().operations) {
      if (op.kind === 'set-config') offConfig.set(op.key, op.value);
    }
    expect(offConfig.get(`featureFlags.${defaultOnFlag}`)).toBe('disabled');
  });
});
