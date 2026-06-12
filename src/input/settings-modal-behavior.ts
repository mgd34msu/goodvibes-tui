import type { ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import type { ModelPickerTarget } from './model-picker.ts';

export type ModelPickerLaunch =
  | { readonly flow: 'providerModel'; readonly target: ModelPickerTarget }
  | { readonly flow: 'model'; readonly target: ModelPickerTarget };

/**
 * Map config keys to the shared provider/model picker flows.
 */
export function modelPickerLaunchForKey(key: string): ModelPickerLaunch | null {
  if (key === 'provider.model') return { flow: 'providerModel', target: 'main' };
  if (key === 'helper.globalProvider') return { flow: 'providerModel', target: 'helper' };
  if (key === 'helper.globalModel') return { flow: 'model', target: 'helper' };
  if (key === 'tools.llmProvider') return { flow: 'providerModel', target: 'tool' };
  if (key === 'tools.llmModel') return { flow: 'model', target: 'tool' };
  if (key === 'tts.llmProvider') return { flow: 'providerModel', target: 'tts' };
  if (key === 'tts.llmModel') return { flow: 'model', target: 'tts' };
  return null;
}

export function roundToPrecision(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function getNumericAdjustmentMeta(setting: ConfigSetting): {
  step: number;
  min?: number;
  max?: number;
  precision: number;
} {
  if (setting.key === 'wrfc.scoreThreshold') {
    return { step: 0.1, min: 0, max: 10, precision: 1 };
  }
  if ((setting.key as string) === 'tts.speed') {
    // Speed multiplier: 0.1 increments, min 0.1, no hard max (provider-defined).
    // tts.speed is not yet a ConfigKey in the SDK schema; cast required.
    return { step: 0.1, min: 0.1, precision: 1 };
  }
  return { step: 1, precision: 0 };
}
