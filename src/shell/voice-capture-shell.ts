/**
 * voice-capture-shell.ts — the shell's side of microphone capture.
 *
 * Extracted from main() for the same reason the process-lifecycle wiring was:
 * the entrypoint is a wiring file held under a source-line gate, and new shell
 * composition gets its own module and a single call there.
 *
 * What this owns is only the shell-facing half — where a transcript lands (the
 * composer draft, through the same public `prompt`/`cursorPos` fields the
 * external-editor path writes), how a turn is submitted, which keybinding seam
 * the Alt+V action hangs off, and the teardown registration that guarantees a
 * live recorder subprocess dies with the process. Everything about audio itself
 * lives in src/audio/voice-capture-wiring.ts, which must not (and does not)
 * import shell-UI.
 */

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { CommandContext } from '../input/command-registry.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import type { VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { wireVoiceCapture } from '../audio/voice-capture-wiring.ts';

export interface VoiceCaptureShellDeps {
  readonly configManager: ConfigManager;
  readonly shellPaths: Pick<ShellPathService, 'resolveUserPath'>;
  readonly homeDirectory: string | (() => string);
  /** Names retained wake clips so the SDK's sweeper reaps them when this session ends. */
  readonly sessionId: string;
  /** The Alt+V seam is hung here (commandContext.toggleVoiceInput). */
  readonly commandContext: CommandContext;
  /** The shell's teardown registry; the device release is appended to it. */
  readonly unsubs: Array<() => void>;
  /** The live composer buffer — InputHandler exposes public `prompt`/`cursorPos`. */
  readonly buffer: { prompt: string; cursorPos: number };
  readonly submitInput: (text: string) => void;
  readonly notify: (message: string) => void;
  readonly render: () => void;
}

/**
 * Compose voice capture and hand back the footer-row reader.
 *
 * Opens no device: wake detection consults `voice.wake.*` and refuses without
 * touching the capture opener when it is off, and push-to-talk opens one only on
 * a keypress.
 */
export function installVoiceCapture(deps: VoiceCaptureShellDeps): () => VoiceCaptureIndicatorState | null {
  const capture = wireVoiceCapture({
    configManager: deps.configManager,
    // The same managed root `/voice setup` uses; the wake tree is `<root>/wake`.
    managedVoiceRoot: deps.shellPaths.resolveUserPath('voice'),
    // Surface-scoped: the extracted onnxruntime assets belong to this surface's
    // own directory, beside its other managed state.
    assetDirectory: deps.shellPaths.resolveUserPath('tui', 'onnxruntime'),
    homeDirectory: deps.homeDirectory,
    sessionId: deps.sessionId,
    writeDraft: (text) => {
      deps.buffer.prompt = text;
      deps.buffer.cursorPos = text.length;
      deps.render();
    },
    submitTurn: (text) => deps.submitInput(text),
    notify: deps.notify,
    render: deps.render,
  });
  deps.commandContext.toggleVoiceInput = capture.toggleVoiceInput;
  deps.unsubs.push(...capture.unsubs);
  return capture.status;
}
