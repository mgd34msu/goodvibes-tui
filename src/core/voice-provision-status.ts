// ---------------------------------------------------------------------------
// voice-provision-status.ts — the surface-facing projection of the managed
// local-voice runtime (voice.local.status / voice.local.install).
//
// The SDK owns the provisioning policy: a one-act install that fetches the
// piper TTS engine + a default voice (fully hosted) and, where a pinned bundle
// is hosted for the platform, the whisper STT engine + model — atomic,
// checksum-verified, resumable, and honest about every terminal state. This
// module is the read-only projection the /voice surfaces render from: sizes
// declared up front, a receipt of what was installed / skipped / failed, and
// the honest "not yet published for this platform" line when a whisper bundle
// is pinned but not yet hosted (its manifest url is unstamped).
//
// Pure formatting only (no I/O): the command layer fetches the typed verb
// responses over the operator invoke seam (voice-provision-gateway.ts) and
// hands them here, so these builders are unit-testable against fixture shapes.
// ---------------------------------------------------------------------------

import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';

/** voice.local.status output — the no-network installed/available snapshot. */
export type VoiceRuntimeStatusResult = OperatorMethodOutput<'voice.local.status'>;
/** voice.local.install receipt — the one-act install outcome. */
export type VoiceLocalInstallResult = OperatorMethodOutput<'voice.local.install'>;

/** Human byte size (mirrors the local formatBytes idiom used across the renderer). */
export function formatVoiceBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * True when a whisper STT bundle is PINNED for this platform (bytes + checksum
 * fixed) but not yet hosted/sideloaded — the "supported but not yet published"
 * state. The SDK signals it as supported === true with an unprovisioned state
 * and an honest reason string; contrast an unsupported platform (supported ===
 * false), which has no pin at all.
 */
export function isSttPinnedButUnpublished(status: VoiceRuntimeStatusResult): boolean {
  const stt = status.stt;
  return stt.supported === true && stt.state !== 'provisioned' && !stt.binaryPresent && !stt.modelPresent
    && typeof stt.reason === 'string' && stt.reason.length > 0;
}

/** Whether the managed runtime still has something to offer to provision. */
export function voiceRuntimeNeedsSetup(status: VoiceRuntimeStatusResult): boolean {
  return status.state !== 'provisioned' || status.stt.state === 'not-provisioned' || status.stt.state === 'partial';
}

/**
 * The /voice status lines — an honest, plain-language account of the managed
 * local-voice runtime with sizes declared up front. Order: platform + overall
 * state, then the TTS (piper) engine, then the STT (whisper) engine with its
 * honest unsupported / not-yet-published wording, then the one-act offer size.
 */
export function voiceStatusLines(status: VoiceRuntimeStatusResult): string[] {
  const lines: string[] = [];
  lines.push(`  platform: ${status.platform ?? 'unrecognized (no managed voice build)'}`);
  lines.push(`  runtime: ${status.state}`);

  // TTS — piper, fully hosted where a platform build exists.
  const tts = status.tts;
  if (tts.binaryPresent && tts.voicePresent) {
    lines.push(`  tts (${tts.engine}): installed`);
  } else if (status.state === 'unsupported-platform') {
    lines.push(`  tts (${tts.engine}): unsupported on this platform`);
  } else {
    const have = [tts.binaryPresent ? 'engine' : null, tts.voicePresent ? 'voice' : null].filter(Boolean);
    lines.push(`  tts (${tts.engine}): not installed${have.length ? ` (have ${have.join(' + ')})` : ''}`);
  }

  // STT — whisper, hosted only where a pinned bundle is published. Render the
  // REAL state honestly: a platform with no pinned build (supported === false,
  // or state 'unsupported-platform' — every platform except linux-x64 today)
  // reads "unsupported on this platform"; a platform whose bundle is pinned but
  // not yet hosted (supported === true, unprovisioned, with a reason) reads
  // "not yet published for this platform".
  const stt = status.stt;
  if (stt.binaryPresent && stt.modelPresent) {
    lines.push(`  stt (${stt.engine}): installed`);
  } else if (!stt.supported || stt.state === 'unsupported-platform') {
    lines.push(`  stt (${stt.engine}): unsupported on this platform`);
    if (stt.reason) lines.push(`    ${stt.reason}`);
  } else if (isSttPinnedButUnpublished(status)) {
    lines.push(`  stt (${stt.engine}): not yet published for this platform`);
    if (stt.reason) lines.push(`    ${stt.reason}`);
  } else {
    lines.push(`  stt (${stt.engine}): not installed`);
    if (stt.reason) lines.push(`    ${stt.reason}`);
  }

  if (status.offerBytes !== null && status.offerBytes !== undefined && voiceRuntimeNeedsSetup(status)) {
    lines.push(`  setup download: ${formatVoiceBytes(status.offerBytes)} — run /voice setup to install`);
  }
  return lines;
}

/** The honest per-terminal-state one-liner for a TTS/STT engine outcome. */
export function voiceEngineOutcomeLine(engine: string, state: string, reason: string | undefined): string {
  switch (state) {
    case 'provisioned':
      return `  ${engine}: installed`;
    case 'download-failed':
      return `  ${engine}: download failed${reason ? ` — ${reason}` : ''} (re-run /voice setup to retry; completed parts are kept)`;
    case 'checksum-mismatch':
      return `  ${engine}: checksum mismatch — the downloaded file did not match its pinned checksum and was discarded${reason ? ` (${reason})` : ''}`;
    case 'bundle-unavailable':
      return `  ${engine}: not yet published for this platform${reason ? ` — ${reason}` : ''}`;
    case 'sideload-mismatch':
      return `  ${engine}: a sideloaded bundle was present but did not match the pinned checksum${reason ? ` — ${reason}` : ''}`;
    case 'unsupported-platform':
      return `  ${engine}: unsupported on this platform${reason ? ` — ${reason}` : ''}`;
    default:
      return `  ${engine}: ${state}${reason ? ` — ${reason}` : ''}`;
  }
}

/**
 * The /voice setup receipt lines — the final one-act outcome. Renders the
 * per-component breakdown (installed / skipped-as-present / failed with size),
 * the TTS and STT terminal states with honest wording, and the config write
 * receipt (which voice.local.* keys were configured vs skipped as user-set).
 */
export function voiceInstallReceiptLines(result: VoiceLocalInstallResult): string[] {
  const lines: string[] = [];
  lines.push(`  result: ${result.provisioned ? 'local voice provisioned' : 'not provisioned'}`);
  lines.push(`  platform: ${result.platform ?? 'unrecognized (no managed voice build)'}`);

  lines.push(voiceEngineOutcomeLine(`tts (${result.tts.engine})`, result.tts.state, result.tts.reason));
  lines.push(voiceEngineOutcomeLine(`stt (${result.stt.engine})`, result.stt.state, result.stt.reason));

  if (result.components.length > 0) {
    lines.push('  components:');
    for (const component of result.components) {
      const size = component.bytes !== undefined ? ` (${formatVoiceBytes(component.bytes)})` : '';
      const err = component.error ? ` — ${component.error}` : '';
      const state = component.state === 'skipped' ? 'already present' : component.state;
      lines.push(`    ${component.id}: ${state}${size}${err}`);
    }
  }

  const set = result.configured.set;
  const skipped = result.configured.skipped;
  if (set.length > 0) {
    lines.push(`  configured ${set.length} key${set.length === 1 ? '' : 's'}:`);
    for (const entry of set) lines.push(`    ${entry.key} = ${entry.value}`);
  }
  if (skipped.length > 0) {
    lines.push(`  left ${skipped.length} key${skipped.length === 1 ? '' : 's'} untouched:`);
    for (const entry of skipped) lines.push(`    ${entry.key}: ${entry.reason}`);
  }
  if (set.length === 0 && skipped.length === 0) {
    lines.push('  no config keys were written');
  }
  return lines;
}
