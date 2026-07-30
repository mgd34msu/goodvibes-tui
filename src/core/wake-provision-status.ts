// ---------------------------------------------------------------------------
// wake-provision-status.ts — the surface-facing projection of wake-word
// provisioning and of the rows that are or are not in force.
//
// The wake models are checksum-pinned and provisioned ONLY by an explicit act
// (/voice wake setup). This module is the read-only projection the /voice wake
// surfaces render from: per-artifact present / verified / corrupt / bytes taken
// straight from the SDK's wakeProvisionStatus, which verifies by CONTENT rather
// than by existence — a truncated or wrong-asset file reports corrupt instead of
// present, because a detector loading it would fail in a way the user could not
// diagnose.
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
import { formatVoiceBytes } from './voice-provision-status.ts';

/**
 * What a terminal can actually do, so a `voice.wake.*` row is refused or reported
 * rather than faked. Lives here — beside the status projection and away from the
 * inference runtime — so the command layer can resolve settings without pulling
 * onnxruntime into a `/voice wake status` call.
 */
export function terminalWakeCapabilities(speexAvailable: boolean): WakeSurfaceCapabilities {
  return {
    speexAvailable,
    // No VAD model is pinned by the platform manifest, on ANY surface. A
    // `voice.wake.vadThreshold` above 0 therefore BLOCKS startup rather than being
    // silently skipped, and the reason is shown wherever status is shown.
    vadAvailable: false,
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
    wakeArtifactLine('attribution NOTICE', status.notice),
  ];
  if (!status.ready) {
    lines.push(`  a fresh provision would download ${formatVoiceBytes(status.downloadBytes)} — run /voice wake setup (nothing downloads on its own)`);
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
  if (result.recallIsSyntheticOnly) {
    lines.push('  the published recall figures for this model are measured on synthesised speech only — no human recording of the phrase exists behind them.');
  }
  return lines;
}

/** The one-line announcement printed before a (multi-megabyte) provision runs. */
export const WAKE_SETUP_ANNOUNCEMENT = [
  'Wake-Word Setup',
  '  downloading the pinned "hey goodvibes" classifier and the shared speech-embedding front end…',
  '  both are checksum-verified and the download is resumable — re-run /voice wake setup to retry any failed component.',
].join('\n');
