/**
 * Onboarding feature coverage + cross-surface consistency.
 *
 * Guarantees:
 *  - every SDK capability is REACHABLE in onboarding (as a surface
 *    side-effect, the HITL experience step, or a guided feature unit);
 *  - enabling a guided feature writes its real enablement settings key
 *    together with its config, there is no separate flag namespace;
 *  - a default-on feature turned off persists its domain key at the off
 *    value, and a run that accepts the defaults never moves an enablement
 *    key away from its schema default;
 *  - every onboarding feature id names a real FEATURE_SETTINGS capability.
 */
import { describe, test, expect } from 'bun:test';
import { FEATURE_SETTINGS } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';
import { featureEnablementWrite, getFeatureSetting, isFeatureValueEnabled } from '@pellux/goodvibes-terminal-shell';
import { OnboardingWizardController } from '../../input/onboarding/onboarding-wizard.ts';
import { getServerSurfaceFeatureFlags } from '@pellux/goodvibes-sdk/platform/runtime/operations';
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
    const unreachable = FEATURE_SETTINGS.map((feature) => feature.id).filter((id) => !reachable.has(id));
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

  test('every onboarding feature id names a real FEATURE_SETTINGS capability', () => {
    const featureIds = new Set(FEATURE_SETTINGS.map((feature) => feature.id));
    for (const id of [...getFeatureOnboardingFlagIds(), ...surfaceReachableFlags(), 'hitl-ux-modes']) {
      expect(featureIds.has(id)).toBe(true);
    }
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

    // Enablement is the real domain key, written together with the config.
    expect(config.get('sandbox.enabled')).toBe(true); // enablement + implied config share the key
    expect(config.get('fetch.sanitizeMode')).toBe('strict'); // enum sub-option (always-on capability)
    // Remote export flips telemetry.otelMode; the prerequisite foundation
    // shares the same key and the more specific mode wins the batch.
    expect(config.get('telemetry.otelMode')).toBe('remote-export');
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
        // If the unit contributed any config, the feature must be ON in the
        // same batch: either its enablement key carries the on-value, or the
        // feature ships enabled and needed no write.
        const feature = getFeatureSetting(unit.flagId)!;
        if (config.has(feature.enablement.key)) {
          // Shared enablement keys may carry a sibling's mode (e.g. distiller
          // over structured), what matters is the feature reads as ON.
          expect(isFeatureValueEnabled(feature, config.get(feature.enablement.key))).toBe(true);
        } else {
          expect(isFeatureDefaultOn(unit.flagId)).toBe(true);
        }
        for (const implied of unit.impliedConfig ?? []) {
          expect(config.has(implied.key)).toBe(true);
        }
      }
    }
  });

  test('turning off a default-on feature writes its off value; defaults never move an enablement key', () => {
    // Default run: no toggles touched → no guided enablement key leaves its
    // schema default (writes at the default value are permissible no-ops).
    const schemaByKey = new Map(CONFIG_SCHEMA.map((setting) => [setting.key, setting]));
    const untouched = new OnboardingWizardController();
    untouched.open('new');
    const untouchedConfig = new Map<string, unknown>();
    for (const op of untouched.buildApplyRequest().operations) {
      if (op.kind === 'set-config') untouchedConfig.set(op.key, op.value);
    }
    for (const id of getFeatureOnboardingFlagIds()) {
      const key = getFeatureSetting(id)!.enablement.key;
      if (!untouchedConfig.has(key)) continue;
      expect(untouchedConfig.get(key)).toEqual(schemaByKey.get(key)!.default);
    }

    // Turn OFF a default-on feature → its domain key persists the off value.
    const defaultOnFlag = getFeatureOnboardingFlagIds().find((id) => isFeatureDefaultOn(id) && featureEnablementWrite(id, false) !== null)!;
    expect(defaultOnFlag).toBeDefined();
    const off = new OnboardingWizardController();
    off.open('new');
    off.setFieldValue(featureEnableFieldId(defaultOnFlag), false);
    const offConfig = new Map<string, unknown>();
    for (const op of off.buildApplyRequest().operations) {
      if (op.kind === 'set-config') offConfig.set(op.key, op.value);
    }
    const offWrite = featureEnablementWrite(defaultOnFlag, false)!;
    expect(offConfig.get(offWrite.key)).toEqual(offWrite.value);
  });
});
