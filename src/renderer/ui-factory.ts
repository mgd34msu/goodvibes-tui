import { type Line, type Cell, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { VERSION } from '../version.ts';
import { getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import type { GitHeaderInfo } from './git-status.ts';
import { renderHeaderLine } from './header-line.ts';
import { renderConversationFragment } from './conversation-surface.ts';
import { activeTheme, activeTokens, activeUiTones } from './theme.ts';
import { renderQueuedMessageList, renderMemoryProvenanceChip, type MemoryProvenanceEntry } from './composer-fragments.ts';
import { renderUserMessage } from './user-message.ts';
import type { StreamMetrics } from '../core/stream-event-wiring.ts';
import { waitingPhrase, type WaitingState } from '@pellux/goodvibes-sdk/platform/presentation';

/**
 * Ms since the last STREAM_DELTA before the whimsical phrase rotation freezes
 * and the status line shows an honest "stalled Ns" / "reconnecting"
 * label instead. Deliberately much shorter than the 30s stream-stall-watchdog
 * hint threshold (stream-stall-watchdog.ts), that threshold gates a
 * low-priority system message about a likely-dead connection; this one gates
 * a cosmetic label so the UI stops claiming "Vibing..." within a couple of
 * seconds of real silence, well before the stall is confirmed as a problem.
 */
const THINKING_STALL_FREEZE_MS = 2_500;

/**
 * Stall/reconnect state for the live thinking indicator, computed by the
 * caller every render frame from streamMetrics (see stream-event-wiring.ts).
 * `reconnect` is populated only once the SDK's STREAM_RETRY event fires
 * (structurally consumed, absent from SDK 0.35.0's TurnEvent union today).
 */
export interface ThinkingStallInfo {
  /** Ms since the last STREAM_DELTA (or STREAM_START if none yet this turn). */
  readonly msSinceLastDelta: number;
  readonly reconnect?: { readonly attempt: number; readonly maxAttempts: number };
}

/**
 * UIFactory - Generates standard UI fragments without needing Ink/React overhead.
 */
export class UIFactory {
  /**
   * The header row, see header-line.ts. `model` is the SERVING backend
   * resolved by core/active-model-identity.ts. `version` defaults to the live
   * build VERSION; tests pass a pinned fixture so golden snapshots don't break
   * on every release bump. `modelNote` is the failover marker drawn after the
   * model while serving differs from the configured selection.
   */
  public static createHeader(width: number, model: string, title?: string, gitInfo?: GitHeaderInfo, version: string = VERSION, modelNote?: string): Line[] {
    return renderHeaderLine(width, model, title, gitInfo, version, modelNote);
  }

  /**
   * createMessageBar, a sent user message: a full-width panel fill with the
   * secondary bar (user-message.ts). A cancelled message passes its own fill,
   * error bar and strikethrough.
   */
  public static createMessageBar(
    width: number, text: string,
    bgColor: string = activeTokens().backgroundPanel, textColor: string = activeTokens().text, barColor: string = activeTokens().secondary,
    strikethrough = false,
  ): Line[] {
    return renderUserMessage(text, width, { bar: barColor, bg: bgColor, text: textColor, strikethrough });
  }

  /**
   * createQueuedMessageFragment - Renders a dimmed message bar for queued prompts.
   */
  public static createQueuedMessageFragment(width: number, text: string): Line[] {
    const t = activeUiTones();
    return renderConversationFragment(text, width, {
      prefix: ' (...) ',
      prefixFg: t.state.reasoning,
      text: t.fg.dim,
      bodyBg: activeTheme().collapsedBodyBg,
    });
  }

  /** The mid-turn queue as an editable list, see composer-fragments.ts. */
  public static createQueuedMessageList(width: number, items: readonly { readonly id: string; readonly text: string }[]): Line[] {
    return renderQueuedMessageList(width, items);
  }

  /** The optional "used N memories" provenance chip, see composer-fragments.ts. */
  public static createMemoryProvenanceChip(width: number, count: number, entries: readonly MemoryProvenanceEntry[], expanded: boolean): Line[] {
    return renderMemoryProvenanceChip(width, count, entries, expanded);
  }

  // The waiting-state wording (approval/reconnecting/pre-first-token/stalled/
  // thinking) comes from the SDK presentation contract's waitingPhrase(),
  // shared with the agent. This renderer still decides WHICH state applies
  // from its own stall/reconnect/approval signals (computeStallInfo /
  // computeRenderStallInfo below, see busyPhrase).

  /**
   * Per-frame stall info from stream metrics, computed from lastDeltaAtMs every render (not
   * from any event) so it degrades gracefully with zero new SDK events. Undefined until the
   * first delta clock exists this turn.
   */
  public static computeStallInfo(lastDeltaAtMs: number | undefined, reconnectAttempt: number | undefined, reconnectMaxAttempts: number | undefined, nowMs: number): ThinkingStallInfo | undefined {
    if (lastDeltaAtMs === undefined) return undefined;
    const reconnect = reconnectAttempt !== undefined && reconnectMaxAttempts !== undefined
      ? { attempt: reconnectAttempt, maxAttempts: reconnectMaxAttempts }
      : undefined;
    return { msSinceLastDelta: nowMs - lastDeltaAtMs, reconnect };
  }

  /**
   * Render-frame stall-info decision used at the main render loop's call
   * site: suppress stall detection entirely while a tool is actively
   * executing. lastDeltaAtMs only tracks STREAM_START/STREAM_DELTA and is
   * never advanced during tool execution (the model isn't producing tokens
   * then), so without this gate any tool call longer than
   * THINKING_STALL_FREEZE_MS would make the status line print
   * "Stalled Ns..." directly above the ticking "executing (Ns)" tool row, a
   * false positive during ordinary tool execution (see stream-event-wiring.ts
   * TOOL_EXECUTING/TOOL_SUCCEEDED/TOOL_FAILED/TOOL_CANCELLED handlers).
   * Genuine no-delta silence while waiting on the provider, including the
   * pre-first-token case, where lastDeltaAtMs is seeded at STREAM_START,
   * still stall-detects normally here, since no tool is active then; that is
   * the honest stall case this indicator exists for.
   */
  public static computeRenderStallInfo(
    metrics: Pick<StreamMetrics, 'activeToolName' | 'lastDeltaAtMs' | 'reconnectAttempt' | 'reconnectMaxAttempts'>,
    nowMs: number,
  ): ThinkingStallInfo | undefined {
    return metrics.activeToolName === undefined
      ? this.computeStallInfo(metrics.lastDeltaAtMs, metrics.reconnectAttempt, metrics.reconnectMaxAttempts, nowMs)
      : undefined;
  }

  /**
   * The status line's waiting phrase for a running turn. Decides WHICH honest
   * waiting state applies (renderer-local signals), then takes the exact
   * wording from the SDK presentation contract's waitingPhrase(). Precedence:
   * approval > reconnecting > pre-first-token > stalled > thinking. The
   * whimsical rotation freezes once real silence has lasted long enough to be
   * misleading (THINKING_STALL_FREEZE_MS).
   */
  public static busyPhrase(frame: number, outputTokens?: number, stallInfo?: ThinkingStallInfo, approvalPending?: boolean): string {
    const isStalled = stallInfo !== undefined && stallInfo.msSinceLastDelta >= THINKING_STALL_FREEZE_MS;
    let state: WaitingState;
    if (approvalPending) state = 'approval';
    else if (stallInfo?.reconnect) state = 'reconnecting';
    else if (isStalled && (outputTokens ?? 0) === 0) state = 'pre-first-token';
    else if (isStalled) state = 'stalled';
    else state = 'thinking';
    return waitingPhrase(state, {
      reconnectAttempt: stallInfo?.reconnect?.attempt,
      reconnectMaxAttempts: stallInfo?.reconnect?.maxAttempts,
      msSinceLastDelta: stallInfo?.msSinceLastDelta,
      frame,
    });
  }

  /** The opt-in partial tool preview row shown under the transcript while a turn runs. */
  public static createToolPreviewRow(width: number, preview: string): Line {
    return this.stringToLine(truncateDisplay(`   tool: ${preview}`, width), width, { fg: activeTokens().textFaint });
  }

  public static stringToLine(text: string, width: number, style: Partial<Cell> = {}): Line {
    const line = createEmptyLine(width);
    let currentColumn = 0;
    for (const char of text) {
      if (currentColumn >= width) break;
      const code = char.codePointAt(0) ?? 0;
      if (code < 32 || code === 127) continue;
      const charWidth = getDisplayWidth(char);
      line[currentColumn] = {
        char,
        fg: style.fg || '',
        bg: style.bg || '',
        bold: style.bold || false,
        dim: style.dim || false,
        underline: style.underline || false,
        italic: style.italic || false,
        strikethrough: style.strikethrough || false
      };
      if (charWidth === 2 && currentColumn + 1 < width) {
        line[currentColumn + 1] = { ...line[currentColumn], char: '' };
      }
      currentColumn += charWidth;
    }
    return line;
  }
}
