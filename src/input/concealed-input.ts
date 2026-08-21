/**
 * Composer concealed-input mode.
 *
 * Generalizes the masking that previously lived only on the two purpose-built
 * auth surfaces (local-auth panel, onboarding wizard) into the MAIN composer,
 * so any password-like prompt can request concealed entry: the typed text is
 * masked in the composer AND never reaches input history or the transcript
 * plaintext. The plaintext is delivered exactly once, to the requester's
 * onSubmit callback.
 *
 * The real value lives in the composer's normal prompt buffer (so all the usual
 * editing works); only the RENDER path is masked (see maskConcealedText) and
 * the SUBMIT path is diverted (see InputHandler.submitConcealedInput).
 */

/** A pending request for one line of concealed input from the composer. */
export interface ConcealedInputRequest {
  /**
   * Short label describing what is being asked for, e.g. 'Password' or
   * 'API key'. Surfaced by the caller (e.g. as a system message), the composer
   * itself only masks; it does not print the label.
   */
  readonly label?: string;
  /** Receives the entered plaintext exactly once, when the user submits. */
  readonly onSubmit: (value: string) => void;
  /** Invoked if the user cancels (Escape) instead of submitting. */
  readonly onCancel?: () => void;
}

/**
 * Mask a composer buffer for display. Every UTF-16 code unit except a newline
 * becomes a bullet, so the masked string has the EXACT same length and line
 * structure as the plaintext, word-wrap and cursor-position math (which index
 * the string by code unit) stay correct while no plaintext character ever
 * reaches the screen buffer.
 */
export function maskConcealedText(text: string): string {
  return text.replace(/[^\n]/g, '•');
}

/**
 * Minimal composer surface the concealed-input helpers mutate. Kept structural
 * so the logic lives here (out of the 800-line handler.ts) while the InputHandler
 * only holds thin delegating methods.
 */
export interface ConcealedInputHost {
  prompt: string;
  cursorPos: number;
  concealedInput: ConcealedInputRequest | null;
  requestRender: () => void;
}

/**
 * Begin one line of concealed input. The composer starts empty and masked; the
 * next submit delivers the plaintext to request.onSubmit and auto-clears
 * concealed mode. A second call replaces any in-flight request (its onCancel
 * fires so no requester is left dangling).
 */
export function beginConcealedInputFor(host: ConcealedInputHost, request: ConcealedInputRequest): void {
  if (host.concealedInput) host.concealedInput.onCancel?.();
  host.concealedInput = request;
  host.prompt = '';
  host.cursorPos = 0;
  host.requestRender();
}

/**
 * Deliver a concealed submission. Returns true when concealed mode was active
 * and consumed the value; false when not concealed (caller uses the normal
 * submit path). The value is passed by the caller (the live feed snapshot),
 * never read back from host.prompt, to avoid mid-feed staleness. Concealed
 * state is cleared BEFORE onSubmit runs so the secret does not linger.
 */
export function submitConcealedInputFor(host: ConcealedInputHost, value: string): boolean {
  const request = host.concealedInput;
  if (!request) return false;
  host.concealedInput = null;
  host.prompt = '';
  host.cursorPos = 0;
  request.onSubmit(value);
  return true;
}

/** Cancel an active concealed-input request without submitting (Escape). */
export function cancelConcealedInputFor(host: ConcealedInputHost): boolean {
  const request = host.concealedInput;
  if (!request) return false;
  host.concealedInput = null;
  host.prompt = '';
  host.cursorPos = 0;
  request.onCancel?.();
  host.requestRender();
  return true;
}
