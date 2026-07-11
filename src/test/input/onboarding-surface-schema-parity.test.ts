// Proves the onboarding channel field set is sourced from the SDK setup schema
// (getBuiltinSetupSchema), not a hand-authored duplicate. For every generated
// surface: each non-extra field maps to a real SDK field of the matching kind,
// and every SDK field (bar the enabled toggle) is present. Two documented
// TUI-only extras the SDK schema omits are allowed.
import { describe, expect, test } from 'bun:test';
import { getBuiltinSetupSchema } from '@pellux/goodvibes-sdk/platform/channels';
import type { ChannelSetupFieldKind, ChannelSurface } from '@pellux/goodvibes-sdk/platform/channels';
import { EXTERNAL_SURFACE_SPECS } from '../../input/onboarding/onboarding-wizard-external-surfaces.ts';

/** configKeys the onboarding exposes that the SDK setup schema intentionally omits. */
const TUI_ONLY_EXTRA_CONFIG_KEYS = new Set(['surfaces.ntfy.defaultPriority', 'surfaces.webhook.timeoutMs']);

function sdkSurfaceOf(enabledFieldId: string): ChannelSurface {
  return enabledFieldId.replace(/^external-services\./, '') as ChannelSurface;
}

function expectedOnboardingKind(sdkKind: ChannelSetupFieldKind): 'text' | 'masked' | 'radio' {
  if (sdkKind === 'secret') return 'masked';
  if (sdkKind === 'select') return 'radio';
  return 'text';
}

describe('onboarding surface specs are derived from the SDK setup schema', () => {
  for (const surface of EXTERNAL_SURFACE_SPECS) {
    const sdkSurface = sdkSurfaceOf(surface.enabledFieldId);
    const schema = getBuiltinSetupSchema(sdkSurface);
    const sdkByKey = new Map(schema.fields.filter((f) => f.configKey).map((f) => [f.configKey!, f]));

    test(`${surface.id}: every non-extra field maps to a real SDK field of the matching kind`, () => {
      for (const field of surface.fields) {
        if (TUI_ONLY_EXTRA_CONFIG_KEYS.has(field.configKey)) continue;
        const sdkField = sdkByKey.get(field.configKey);
        expect(sdkField, `${field.configKey} must exist in the SDK schema`).toBeDefined();
        expect(field.kind).toBe(expectedOnboardingKind(sdkField!.kind));
      }
    });

    test(`${surface.id}: every SDK setup field (bar the enabled toggle) is present in onboarding`, () => {
      const onboardingKeys = new Set(surface.fields.map((f) => f.configKey));
      for (const sdkField of schema.fields) {
        if (!sdkField.configKey) continue;
        if (sdkField.kind === 'boolean' || sdkField.configKey.endsWith('.enabled')) continue;
        expect(onboardingKeys.has(sdkField.configKey), `${sdkField.configKey} missing from onboarding`).toBe(true);
      }
    });
  }

  test('the only TUI-only extras are the two documented numeric fields', () => {
    const extras = EXTERNAL_SURFACE_SPECS.flatMap((s) => {
      const sdkKeys = new Set(getBuiltinSetupSchema(sdkSurfaceOf(s.enabledFieldId)).fields.map((f) => f.configKey));
      return s.fields.filter((f) => !sdkKeys.has(f.configKey)).map((f) => f.configKey);
    });
    expect(new Set(extras)).toEqual(TUI_ONLY_EXTRA_CONFIG_KEYS);
  });
});
