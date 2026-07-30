// ---------------------------------------------------------------------------
// wake-provision-status.ts — the surface-facing projection of wake-word
// provisioning and of the rows that are or are not in force.
//
// The wake models are checksum-pinned and arrive WITH THE INSTALLATION: the
// installer and the npm postinstall provision them, and a daemon retries at boot
// whatever the install could not fetch. `/voice wake setup` is the recovery act
// for the case where that did not land, not the normal way in — so the lines
// below name it where it helps and do not imply it is a required step.
//
// This module is the read-only projection the /voice wake surfaces render from:
// per-artifact present / verified / corrupt / bytes taken straight from the SDK's
// wakeProvisionStatus, which verifies by CONTENT rather than by existence — a
// truncated or wrong-asset file reports corrupt instead of present, because a
// detector loading it would fail in a way the user could not diagnose.
//
// Pure formatting only (no I/O), mirroring voice-provision-status.ts: the command
// layer fetches the status and hands it here, so these builders are testable
// against fixture shapes.
// ---------------------------------------------------------------------------

import type {
  WakeArtifactStatus,
  WakeProvisionResult,
  WakeProvisionStatus,
  WakeRuntimeSettings,
  WakeSurfaceCapabilities,
} from '@pellux/goodvibes-sdk/platform/voice';
import { noiseSuppressionSupport } from '@pellux/goodvibes-sdk/platform/voice/capture';
import { formatVoiceBytes } from './voice-provision-status.ts';

/**
 * What a terminal can actually do, so a `voice.wake.*` row is refused or reported
 * rather than faked. Lives here — beside the status projection and away from the
 * inference runtime — so the command layer can resolve settings without pulling
 * onnxruntime into a `/voice wake status` call.
 */
export function terminalWakeCapabilities(status?: Pick<WakeProvisionStatus, 'vadReady'>): WakeSurfaceCapabilities {
  return {
    // Asked of the SDK rather than declared here. The filter is a WebAssembly
    // module carried in the package, so the only question is whether this runtime
    // has WebAssembly at all — which the SDK answers, with a reason a settings
    // surface can show. A host constant would go stale the moment the stage
    // shipped, which is exactly what happened to the previous one.
    speexAvailable: noiseSuppressionSupport().supported,
    // The speech gate needs its own provisioned model, so this follows what is
    // VERIFIED ON DISK rather than what the build is capable of: with the artifact
    // missing, `voice.wake.vadThreshold` above 0 still blocks startup and says so.
    vadAvailable: status?.vadReady === true,
    // A terminal has a filesystem (retainAudio) and an audio player (a custom
    // activation sound file).
    canRetainAudio: true,
    canPlayLocalFile: true,
  };
}

/** One artifact's line: what is on disk, verified by content. */
export function wakeArtifactLine(label: string, artifact: WakeArtifactStatus): string {
  if (artifact.verified) return `  ${label}: verified (${formatVoiceBytes(artifact.bytes)})`;
  if (artifact.corrupt) {
    return `  ${label}: PRESENT BUT FAILS VERIFICATION (${formatVoiceBytes(artifact.bytes)}) — torn, truncated, or the wrong asset; /voice wake setup replaces it`;
  }
  return `  ${label}: missing`;
}

/**
 * Blockers, in the SDK's own words. A blocker means the detector must NOT start,
 * so the row's key and the written reason are both shown — a swallowed blocker is
 * a user staring at a feature that is on and doing nothing.
 */
export function describeWakeBlockers(settings: Pick<WakeRuntimeSettings, 'blockers'>): string[] {
  return settings.blockers.map((blocker) => `  ${blocker.key}: ${blocker.detail}`);
}

/** Limitations: the detector runs, with one row not in force, and says which. */
export function describeWakeLimitations(settings: Pick<WakeRuntimeSettings, 'limitations'>): string[] {
  return settings.limitations.map((limitation) => `  ${limitation.key}: ${limitation.detail}`);
}

/** The `/voice wake status` block. */
export function wakeStatusLines(
  status: WakeProvisionStatus,
  settings: WakeRuntimeSettings,
): string[] {
  const lines: string[] = [
    `  feature: voice.wake.enabled=${settings.enabled ? 'on' : 'off'}, voice.wake.surfaces.tui=${settings.surfaceEnabled ? 'on' : 'off'}`,
    `  listening on this terminal: ${settings.active ? 'yes, when the models are provisioned' : 'no'}`,
    `  models provisioned: ${status.ready ? 'yes' : `no (${status.reason ?? 'not-provisioned'})`}`,
    `  model version: ${status.modelVersion ?? 'unpinned'}`,
    wakeArtifactLine('classifier', status.classifier),
    wakeArtifactLine('speech-embedding front end', status.embedding),
    // One NOTICE per redistributable artifact, named so it is obvious which is
    // which: both are required, and a reader chasing a missing one needs to know
    // whether it is ours or Google's.
    wakeArtifactLine('attribution NOTICE (classifier)', status.notice),
    wakeArtifactLine('attribution NOTICE (front end)', status.embeddingNotice),
    // Reported but never presented as a problem: nothing on this terminal loads
    // it, and it is here so a surface can see whether the daemon could serve it.
    `${wakeArtifactLine('classifier, tflite form (served to other runtimes; unused here)', status.mobileClassifier)}`,
    // The speech gate reports separately from `models provisioned` for the same
    // reason it is outside the SDK's `ready`: voice.wake.vadThreshold is 0 unless
    // someone turns it on, so a missing gate is not a broken detector. It is
    // printed rather than left out because vadThreshold above 0 refuses to start
    // when the gate is absent, and a reader needs to see why.
    `  speech gate provisioned: ${status.vadReady ? 'yes' : 'no — voice.wake.vadThreshold above 0 will refuse to start'}`,
    wakeArtifactLine('speech gate', status.vad),
    wakeArtifactLine('attribution NOTICE (speech gate)', status.vadNotice),
  ];
  if (!status.ready) {
    lines.push(
      `  a fresh provision would download ${formatVoiceBytes(status.downloadBytes)}. Installing goodvibes normally does this,`,
      '  and a running daemon retries at boot — run /voice wake setup to fetch it now (nothing downloads on its own).',
    );
  }
  lines.push(
    `  wake models configured: ${settings.modelIds.length > 0 ? settings.modelIds.join(', ') : 'none (voice.wake.models is empty, so nothing is scored)'}`,
    `  recorder: voice.wake.captureCommand=${settings.capture.backend}, device=${settings.capture.device.trim().length > 0 ? settings.capture.device : 'system default'}`,
    `  after a wake: ${settings.autoSubmit ? 'the transcript is submitted as a turn' : 'the transcript is placed in the composer'}`,
    `  indicator: voice.wake.indicator=${settings.indicator}, activation sound=${settings.activationSound.kind}`,
    `  retained audio: voice.wake.retainAudio=${settings.retainAudio}`,
  );
  if (status.recallIsSyntheticOnly) {
    lines.push('  the published recall figures for this model are measured on synthesised speech only — no human recording of the phrase exists behind them.');
  }
  const blockers = describeWakeBlockers(settings);
  if (blockers.length > 0) lines.push('  rows blocking startup:', ...blockers);
  const limitations = describeWakeLimitations(settings);
  if (limitations.length > 0) lines.push('  rows not in force:', ...limitations);
  return lines;
}

/** The `/voice wake setup` receipt. */
export function wakeProvisionReceiptLines(result: WakeProvisionResult): string[] {
  const lines = [
    `  ready: ${result.ready ? 'yes' : 'no'}`,
    `  model version: ${result.modelVersion ?? 'unpinned'}`,
    // Separate from `ready` on purpose: this terminal loads the onnx build, so a
    // missing tflite twin is not a detector that cannot run.
    `  tflite form (for runtimes that cannot load onnx): ${result.mobileFormatReady ? 'installed' : 'not installed — nothing on this terminal needs it'}`,
    // Separate from `ready` for its own reason: voice.wake.vadThreshold ships at
    // 0, so the detector runs without the gate — but a value above 0 refuses to
    // start without it, which is what this line lets a reader act on.
    `  speech gate (voice.wake.vadThreshold): ${result.vadReady ? 'installed' : 'not installed — voice.wake.vadThreshold above 0 will refuse to start'}`,
  ];
  for (const outcome of result.outcomes) {
    const detail = outcome.state === 'failed'
      ? ` — ${outcome.error ?? 'no reason reported'}`
      : outcome.bytes !== undefined ? ` (${formatVoiceBytes(outcome.bytes)})` : '';
    lines.push(`  ${outcome.component}: ${outcome.state}${detail}`);
    lines.push(`    ${outcome.path}`);
  }
  if (result.noticePath !== null) {
    lines.push(`  attribution NOTICE (travels with the classifier): ${result.noticePath}`);
  }
  if (result.embeddingNoticePath !== null) {
    lines.push(`  attribution NOTICE (travels with the front end): ${result.embeddingNoticePath}`);
  }
  if (result.recallIsSyntheticOnly) {
    lines.push('  the published recall figures for this model are measured on synthesised speech only — no human recording of the phrase exists behind them.');
  }
  return lines;
}

/** The one-line announcement printed before a (multi-megabyte) provision runs. */
export const WAKE_SETUP_ANNOUNCEMENT = [
  'Wake-Word Setup',
  '  downloading the pinned "hey goodvibes" classifier (both runtime formats), the shared speech-embedding front end, and the speech gate voice.wake.vadThreshold runs…',
  '  every artifact is checksum-verified and the download is resumable — one that already matches is skipped, so re-running this only fetches what is missing.',
  '  installing goodvibes normally does this for you; running it by hand is how you recover an install that could not reach the network.',
].join('\n');
