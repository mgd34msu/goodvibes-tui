import { describe, expect, test } from 'bun:test';
import {
  formatVoiceBytes,
  isSttPinnedButUnpublished,
  voiceRuntimeNeedsSetup,
  voiceStatusLines,
  voiceEngineOutcomeLine,
  voiceInstallReceiptLines,
  voiceProgressPhaseLabel,
  voiceInstallComponentLine,
  voiceInstallProgressLines,
  type VoiceRuntimeStatusResult,
  type VoiceLocalInstallResult,
  type VoiceInstallProgress,
} from '../../core/voice-provision-status.ts';

// Fixture builders that mirror the exact typed verb output shapes
// (OperatorMethodOutput<'voice.local.status'|'voice.local.install'>).
function statusFixture(overrides: Partial<VoiceRuntimeStatusResult> = {}): VoiceRuntimeStatusResult {
  return {
    platform: 'linux-x64',
    state: 'not-provisioned',
    tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '/managed/tts/piper', modelPath: '/managed/tts/voice.onnx' },
    stt: { engine: 'whisper-cpp', supported: true, state: 'not-provisioned', binaryPresent: false, modelPresent: false, binaryPath: '/managed/stt/whisper', modelPath: '/managed/stt/model.bin' },
    offerBytes: 89_666_641,
    ...overrides,
  } as VoiceRuntimeStatusResult;
}

function installFixture(overrides: Partial<VoiceLocalInstallResult> = {}): VoiceLocalInstallResult {
  return {
    provisioned: true,
    platform: 'linux-x64',
    tts: { engine: 'piper', state: 'provisioned', binaryPath: '/managed/tts/piper', modelPath: '/managed/tts/voice.onnx' },
    stt: { engine: 'whisper-cpp', state: 'provisioned', binaryPath: '/managed/stt/whisper', modelPath: '/managed/stt/model.bin' },
    components: [
      { id: 'piper-engine', state: 'installed', bytes: 26_460_462 },
      { id: 'piper-voice-onnx', state: 'installed', bytes: 63_201_294 },
    ],
    configured: {
      set: [{ key: 'voice.local.ttsEngine', value: 'piper' }],
      skipped: [],
    },
    ...overrides,
  } as VoiceLocalInstallResult;
}

describe('formatVoiceBytes', () => {
  test('humanizes bytes across units', () => {
    expect(formatVoiceBytes(512)).toBe('512 B');
    expect(formatVoiceBytes(1536)).toBe('1.5 KB');
    expect(formatVoiceBytes(89_666_641)).toBe('86 MB');
    expect(formatVoiceBytes(2 * 1024 ** 3)).toBe('2.0 GB');
  });
  test('honest on missing/invalid size', () => {
    expect(formatVoiceBytes(null)).toBe('unknown size');
    expect(formatVoiceBytes(undefined)).toBe('unknown size');
    expect(formatVoiceBytes(-1)).toBe('unknown size');
  });
});

describe('voiceStatusLines: populated / provisioned', () => {
  test('renders installed TTS + STT with no setup offer', () => {
    const status = statusFixture({
      state: 'provisioned',
      tts: { engine: 'piper', binaryPresent: true, voicePresent: true, binaryPath: '/p', modelPath: '/v' },
      stt: { engine: 'whisper-cpp', supported: true, state: 'provisioned', binaryPresent: true, modelPresent: true, binaryPath: '/w', modelPath: '/m' },
      offerBytes: 0,
    });
    const text = voiceStatusLines(status).join('\n');
    expect(text).toContain('runtime: provisioned');
    expect(text).toContain('tts (piper): installed');
    expect(text).toContain('stt (whisper-cpp): installed');
    expect(text).not.toContain('run /voice setup');
    expect(voiceRuntimeNeedsSetup(status)).toBe(false);
  });
});

describe('voiceStatusLines: empty / unprovisioned with sizes up front', () => {
  test('declares the download size and offers setup', () => {
    const status = statusFixture();
    const text = voiceStatusLines(status).join('\n');
    expect(text).toContain('runtime: not-provisioned');
    expect(text).toContain('tts (piper): not installed');
    expect(text).toContain('setup download: 86 MB; run /voice setup to install');
    expect(voiceRuntimeNeedsSetup(status)).toBe(true);
  });
});

describe('voiceStatusLines: STT pinned but not yet published for this platform', () => {
  test('supported+unprovisioned+reason renders the honest not-yet-published line verbatim', () => {
    const reason = 'A pinned whisper bundle exists for linux-arm64 but is not yet hosted. Build it byte-for-byte with scripts/build-whisper-bundle.ts and drop the archive, or wait for a hosting release.';
    const status = statusFixture({
      platform: 'linux-arm64',
      stt: { engine: 'whisper-cpp', supported: true, state: 'not-provisioned', binaryPresent: false, modelPresent: false, binaryPath: '/w', modelPath: '/m', reason },
    });
    expect(isSttPinnedButUnpublished(status)).toBe(true);
    const text = voiceStatusLines(status).join('\n');
    expect(text).toContain('stt (whisper-cpp): not yet published for this platform');
    expect(text).toContain(reason);
  });
});

describe('voiceStatusLines: unsupported platform (no pin at all)', () => {
  test('renders unsupported STT and is not counted as pinned-unpublished', () => {
    const status = statusFixture({
      platform: 'darwin-arm64',
      state: 'unsupported-platform',
      tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '/p', modelPath: '/v' },
      stt: { engine: 'whisper-cpp', supported: false, state: 'unsupported-platform', binaryPresent: false, modelPresent: false, binaryPath: '/w', modelPath: '/m', reason: 'no pinned whisper build for darwin-arm64' },
      offerBytes: null,
    });
    expect(isSttPinnedButUnpublished(status)).toBe(false);
    const text = voiceStatusLines(status).join('\n');
    expect(text).toContain('tts (piper): unsupported on this platform');
    expect(text).toContain('stt (whisper-cpp): unsupported on this platform');
    expect(text).not.toContain('run /voice setup'); // offerBytes null → no offer
  });
});

describe('voiceEngineOutcomeLine: honest terminal states', () => {
  test('download-failed points at the resumable retry act', () => {
    expect(voiceEngineOutcomeLine('tts (piper)', 'download-failed', 'network error')).toContain('re-run /voice setup to retry');
    expect(voiceEngineOutcomeLine('tts (piper)', 'download-failed', 'network error')).toContain('network error');
  });
  test('checksum-mismatch, bundle-unavailable, sideload-mismatch, unsupported each render distinctly', () => {
    expect(voiceEngineOutcomeLine('tts (piper)', 'checksum-mismatch', undefined)).toContain('checksum mismatch');
    expect(voiceEngineOutcomeLine('stt (whisper-cpp)', 'bundle-unavailable', undefined)).toContain('not yet published for this platform');
    expect(voiceEngineOutcomeLine('stt (whisper-cpp)', 'sideload-mismatch', undefined)).toContain('sideloaded bundle');
    expect(voiceEngineOutcomeLine('stt (whisper-cpp)', 'unsupported-platform', undefined)).toContain('unsupported on this platform');
  });
});

describe('live install progress (installInProgress)', () => {
  const progress: VoiceInstallProgress = {
    startedAt: 1_000,
    components: [
      { component: 'piper-engine', phase: 'download', bytesTotal: 26_460_462, bytesDone: 26_460_462 },
      { component: 'piper-voice-onnx', phase: 'verify', bytesTotal: 63_201_294 },
      { component: 'whisper-engine', phase: 'extract' },
      { component: 'piper-engine', phase: 'error', message: 'HTTP 503' },
    ],
  } as VoiceInstallProgress;

  test('phase labels are human', () => {
    expect(voiceProgressPhaseLabel('download')).toBe('downloading');
    expect(voiceProgressPhaseLabel('verify')).toBe('verifying');
    expect(voiceProgressPhaseLabel('extract')).toBe('extracting');
    expect(voiceProgressPhaseLabel('error')).toBe('failed');
  });

  test('a component line shows phase, done/total size, and a message', () => {
    expect(voiceInstallComponentLine(progress.components[0]!)).toBe('    piper-engine: downloading (25 MB/25 MB)');
    expect(voiceInstallComponentLine(progress.components[1]!)).toBe('    piper-voice-onnx: verifying (60 MB)');
    expect(voiceInstallComponentLine(progress.components[2]!)).toBe('    whisper-engine: extracting');
    expect(voiceInstallComponentLine(progress.components[3]!)).toContain('failed');
    expect(voiceInstallComponentLine(progress.components[3]!)).toContain('HTTP 503');
  });

  test('voiceInstallProgressLines renders one line per component', () => {
    expect(voiceInstallProgressLines(progress)).toHaveLength(4);
  });
});

describe('voiceInstallReceiptLines: final receipt', () => {
  test('provisioned receipt shows components, engine states, and configured keys', () => {
    const text = voiceInstallReceiptLines(installFixture()).join('\n');
    expect(text).toContain('result: local voice provisioned');
    expect(text).toContain('piper-engine: installed (25 MB)');
    expect(text).toContain('configured 1 key:');
    expect(text).toContain('voice.local.ttsEngine = piper');
  });

  test('a failed TTS download renders honestly and STT bundle-unavailable is distinct', () => {
    const receipt = installFixture({
      provisioned: false,
      tts: { engine: 'piper', state: 'download-failed', reason: 'HTTP 503' },
      stt: { engine: 'whisper-cpp', state: 'bundle-unavailable', reason: 'not yet hosted for linux-arm64' },
      components: [{ id: 'piper-engine', state: 'failed', error: 'HTTP 503' }],
      configured: { set: [], skipped: [] },
    });
    const text = voiceInstallReceiptLines(receipt).join('\n');
    expect(text).toContain('result: not provisioned');
    expect(text).toContain('re-run /voice setup to retry');
    expect(text).toContain('not yet published for this platform');
    expect(text).toContain('piper-engine: failed');
    expect(text).toContain('no config keys were written');
  });

  test('skipped-as-user-set keys are reported with their reason', () => {
    const receipt = installFixture({
      configured: {
        set: [{ key: 'voice.local.ttsBinary', value: '/managed/piper' }],
        skipped: [{ key: 'voice.local.ttsEngine', reason: 'already set to a user value (kokoro)' }],
      },
    });
    const text = voiceInstallReceiptLines(receipt).join('\n');
    expect(text).toContain('left 1 key untouched:');
    expect(text).toContain('voice.local.ttsEngine: already set to a user value (kokoro)');
  });
});
