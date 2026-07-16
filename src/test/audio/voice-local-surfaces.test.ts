import { describe, expect, test } from 'bun:test';
import { VoiceProviderRegistry, ensureBuiltinVoiceProviders } from '@pellux/goodvibes-sdk/platform/voice';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { formatCostAttributionSection, type CostAttributionResult } from '../../input/commands/cost-attribution-format.ts';
import { localVoiceSetupOffer } from '../../input/voice-local-settings.ts';

// ---------------------------------------------------------------------------
// STEP 5 — voice settings: the voice.local.* keys surface in their domain with
// real option shapes; the provider selection shows "local" beside elevenlabs;
// the not-configured state is honest (never an error); voice spend rides the
// existing cost surfaces (metered renders unpriced with its source; local shows
// no billing dimension).
// ---------------------------------------------------------------------------

describe('voice.local.* settings domain (STEP 5)', () => {
  test('the local-engine keys surface under the voice category with real option shapes', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const voice = groups.get('voice') ?? [];
    const keys = voice.map((e) => e.setting.key);
    expect(keys).toContain('voice.local.sttEngine');
    expect(keys).toContain('voice.local.ttsEngine');
    expect(keys).toContain('voice.local.sttBinary');
    expect(keys).toContain('voice.local.ttsModelPath');
    // The engine keys carry real enum option shapes, empty = honest unconfigured.
    const stt = voice.find((e) => e.setting.key === 'voice.local.sttEngine')!;
    expect(stt.setting.type).toBe('enum');
    expect(stt.setting.enumValues).toEqual(['', 'whisper-cpp', 'faster-whisper']);
    expect(stt.setting.default).toBe('');
    const tts = voice.find((e) => e.setting.key === 'voice.local.ttsEngine')!;
    expect(tts.setting.enumValues).toEqual(['', 'piper', 'kokoro']);
  });
});

describe('voice provider selection — local beside elevenlabs (STEP 5)', () => {
  function registryWithLocal(): VoiceProviderRegistry {
    const reg = new VoiceProviderRegistry();
    // The TUI passes a voice.local.* reader so the local provider registers;
    // here it reads empty (unconfigured), the honest default.
    ensureBuiltinVoiceProviders(reg, { readConfig: () => '' });
    return reg;
  }

  test('the streaming-TTS providers include both "local" and "elevenlabs"', () => {
    const providers = registryWithLocal().list().filter((p) => p.capabilities.includes('tts-stream'));
    const ids = providers.map((p) => p.id);
    expect(ids).toContain('local');
    expect(ids).toContain('elevenlabs');
  });

  test('the local provider has no billing dimension and reports an honest unconfigured status (never an error)', async () => {
    const local = registryWithLocal().get('local');
    expect(local).not.toBeNull();
    expect(local!.billing).toBe('none');
    const status = await local!.status?.();
    expect(status).toBeDefined();
    // Empty config → configurable-not-configured, never a thrown error.
    expect(status!.state).toBe('unconfigured');
    expect(status!.configured).toBe(false);
  });
});

describe('local-voice setup offer — size-labeled one-act beside ElevenLabs (STEP 5)', () => {
  test('unprovisioned local voice offers the size-labeled /voice setup one-act', () => {
    const offer = localVoiceSetupOffer(() => ''); // empty config = unconfigured
    expect(offer.provisioned).toBe(false);
    if (offer.supported) {
      // A managed piper build exists for this platform: the offer declares the
      // download size up front and points at the one-act install.
      expect(offer.detail).toContain('run /voice setup');
      expect(offer.detail).toMatch(/~[\d.]+ [KMG]B/);
      expect(offer.sizeLabel).toMatch(/~[\d.]+ [KMG]B/);
      expect(offer.actions).toContain('/voice setup');
    } else {
      // No managed build for this platform: honest, never a fabricated offer.
      expect(offer.detail).toContain('no managed build for this platform');
      expect(offer.sizeLabel).toBe('unavailable on this platform');
    }
  });

  test('a provisioned local engine (tts binary + model set) reads configured, no setup offer', () => {
    const config: Record<string, string> = {
      'voice.local.ttsBinary': '/managed/voice/tts/piper',
      'voice.local.ttsModelPath': '/managed/voice/tts/en_US-amy-medium.onnx',
    };
    const offer = localVoiceSetupOffer((key) => config[key] ?? '');
    expect(offer.provisioned).toBe(true);
    expect(offer.detail).toContain('configured');
    expect(offer.detail).not.toContain('run /voice setup');
    expect(offer.actions).toBe('[Enter] set provider');
  });
});

describe('voice cost honesty (STEP 5)', () => {
  function voiceResult(): CostAttributionResult {
    // A metered voice-usage record rides the cost ledger under the model
    // dimension, keyed by its voice source, honestly UNPRICED until a manual
    // price names USD/1M units.
    return {
      dimension: 'model',
      window: 'session',
      windowStartMs: 0,
      rows: [
        { key: 'elevenlabs:voice-tts:characters', costUsd: null, costState: 'unpriced', tokens: { inputTokens: 1234, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      ],
      totalCostUsd: null,
      costState: 'unpriced',
      pricedRecordCount: 0,
      unpricedRecordCount: 1,
    } as unknown as CostAttributionResult;
  }

  test('a metered voice-usage record renders under its source key, honestly unpriced (never $0.00)', () => {
    const lines = formatCostAttributionSection(voiceResult(), false)!.join('\n');
    expect(lines).toContain('elevenlabs:voice-tts:characters'); // the source is visible
    expect(lines).toContain('unpriced');
    expect(lines).toContain('in=1234'); // the billable character count rides inputTokens
    expect(lines).not.toContain('$0.0000'); // no fabricated zero
  });

  test('a local (billing none) session emits no voice record — the honest empty cost state, not a fake $0', () => {
    const empty = { ...voiceResult(), rows: [], unpricedRecordCount: 0 } as unknown as CostAttributionResult;
    const lines = formatCostAttributionSection(empty, false)!.join('\n');
    expect(lines).toContain('no attributed records');
    expect(lines).not.toContain('$0.0000');
  });
});
