/**
 * voice-capture-status.ts, what the shell shows while a microphone is open.
 *
 * A capture indicator is not decoration. Two of the three states here exist
 * because the alternative is a user who cannot tell whether their microphone is
 * live: wake detection holds a device open for as long as the feature is on, and
 * push-to-talk holds one open between two keypresses. `voice.wake.indicator`
 * governs how prominent the detector's row is; a push-to-talk recording is
 * always shown, because the user is mid-act and waiting for it.
 *
 * The shape lives here rather than in the renderer or in src/audio so both can
 * use it: the audio layer must not import shell-UI (the architecture check
 * enforces that), and the renderer must not own capture state.
 */

/** What a voice-capture row is reporting. */
export type VoiceCaptureIndicatorKind =
  /** Push-to-talk: the user pressed the key and is speaking now. */
  'recording'
  /** Push-to-talk: the device is being opened (a permission prompt takes real time). */
  | 'requesting'
  /** Push-to-talk: capture ended and the audio is being transcribed. */
  | 'transcribing'
  /** Wake detection is listening and scoring frames. */
  | 'wake-listening'
  /** A wake confirmed; the utterance that followed it is being captured. */
  | 'wake-capturing'
  /** The detector's stream died and a restart is scheduled. */
  | 'wake-restarting'
  /** The supervisor gave up; the detector is off until the feature is toggled. */
  | 'wake-latched';

/** One live capture row. Absent (null) means no microphone is open and no row renders. */
export interface VoiceCaptureIndicatorState {
  readonly kind: VoiceCaptureIndicatorKind;
  /** What opened the device, e.g. `parecord`; null before anything is open. */
  readonly deviceLabel: string | null;
  /**
   * Prominence for the wake rows, from `voice.wake.indicator`. `off` suppresses
   * them entirely. Push-to-talk rows ignore it: the user asked for that capture
   * one keypress ago and is owed the confirmation.
   */
  readonly indicator: 'off' | 'statusline' | 'banner';
  /** Extra words for the row, a restart delay, a latch reason, an elapsed time. */
  readonly detail?: string | undefined;
}

/** True when this state should produce a footer row at all. */
export function voiceCaptureRowVisible(state: VoiceCaptureIndicatorState | null): boolean {
  if (state === null) return false;
  const isWakeRow = state.kind.startsWith('wake-');
  return !isWakeRow || state.indicator !== 'off';
}
