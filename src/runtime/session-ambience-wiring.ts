/**
 * Turn-boundary ambience: spoken turn output, the user's scriptable status
 * line, session auto-titling, and spoken-turn model routing. Extracted from
 * main() as one seam because the four share the same inputs (turn events,
 * config, a notify line, a repaint) and main() only needs their teardowns and
 * the bounded exit-path audio stop.
 */
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { Orchestrator } from '@pellux/goodvibes-sdk/platform/core';
import { wireSpokenTurnRuntime } from '../audio/spoken-turn-wiring.ts';
import { attachSpokenTurnModelRouting } from '../audio/spoken-turn-model-routing.ts';
import { createScriptableStatusline } from '../core/scriptable-statusline.ts';
import { createSessionAutoTitler } from '../core/session-auto-titler.ts';

export interface SessionAmbienceDeps {
  readonly voiceService: Parameters<typeof wireSpokenTurnRuntime>[0]['voiceService'];
  readonly configManager: ConfigManager;
  readonly events: Parameters<typeof wireSpokenTurnRuntime>[0]['events'];
  readonly conversation: Parameters<typeof createSessionAutoTitler>[0]['conversation'];
  readonly toolLLM: Parameters<typeof createSessionAutoTitler>[0]['model'];
  readonly orchestrator: Orchestrator;
  readonly providerRegistry: Parameters<typeof attachSpokenTurnModelRouting>[0]['providerRegistry'];
  readonly workingDir: string;
  readonly notify: (message: string) => void;
  readonly render: () => void;
}

export interface SessionAmbience {
  /** Bounded drain of audio already playing; the exit path calls this. */
  readonly stopSpokenOutputForExit: () => Promise<void>;
  /** Spoken-turn runtime handle: submit/stop, and the cancel path consumes it whole. */
  readonly spokenTurns: ReturnType<typeof wireSpokenTurnRuntime>;
  /** The footer reads the statusline's current text each frame. */
  readonly scriptableStatusline: ReturnType<typeof createScriptableStatusline>;
  readonly unsubs: ReadonlyArray<() => void>;
}

export function wireSessionAmbience(deps: SessionAmbienceDeps): SessionAmbience {
  const { configManager, notify, render } = deps;
  const notifyAndPaint = (message: string): void => { notify(message); render(); };
  const spokenTurns = wireSpokenTurnRuntime({
    voiceService: deps.voiceService,
    configManager,
    events: deps.events,
    notify: notifyAndPaint,
  });
  const scriptableStatusline = createScriptableStatusline({
    configManager, cwd: deps.workingDir, turns: deps.events.turns, onChange: () => render(),
  });
  const sessionAutoTitler = createSessionAutoTitler({
    conversation: deps.conversation, model: deps.toolLLM, configManager, turns: deps.events.turns,
    onTitled: (title) => notifyAndPaint(`[Session] Auto-titled: "${title}"`),
  });
  const routingUnsub = attachSpokenTurnModelRouting({
    orchestrator: deps.orchestrator,
    providerRegistry: deps.providerRegistry,
    configManager,
    notify: notifyAndPaint,
  });
  return {
    stopSpokenOutputForExit: () => spokenTurns.stopForExit(),
    spokenTurns,
    scriptableStatusline,
    unsubs: [...spokenTurns.unsubs, ...scriptableStatusline.unsubs, ...sessionAutoTitler.unsubs, routingUnsub],
  };
}
