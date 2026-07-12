// ---------------------------------------------------------------------------
// fleet-transcript.ts
//
// Renders the content of an attached FleetPanel
// session tab. Three sources, chosen by what the SDK can actually provide
// (see the design brief's "central reality check" — a full-fidelity live
// transcript needs a ConversationMessageSnapshot[] history source, which
// only exists for a RUNNING agent or a just-completed one still inside the
// SDK's bounded retention ring):
//
//   - 'live'/'frozen'  — a non-empty ConversationMessageSnapshot[] from
//     AgentManager.getConversationSnapshot(agentId), rendered through the
//     EXACT SAME conversation-rendering machinery the main session surface
//     uses (MessageLineCache -> conversation-rendering.ts render functions),
//     so a fleet tab's transcript is byte-for-byte the same rendering a
//     user would see in their own session. 'live' while the agent is still
//     running, 'frozen' once it has completed but the snapshot has not yet
//     been evicted from the retention ring.
//   - 'unavailable'    — a terminal agent whose snapshot came back empty
//     (evicted past the retention bound, or an agent kind — e.g. the WRFC
//     owner — that never registered a live conversation source at all).
//     FleetPanel degrades to the on-disk event ledger (renderFleetLedgerFallback)
//     for this case; this module never fabricates transcript content.
//
// A 'wrfc-chain' tab has no single conversation of its own (it coordinates
// member agents, each of which has its own), so it gets a live member
// summary (renderFleetChainSummary) instead of a transcript.
// ---------------------------------------------------------------------------

import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createEmptyLine, type Line } from '../types/grid.ts';
import type { MessageLineCache } from '../core/conversation-line-cache.ts';
import type { ConversationRenderContext } from '../core/conversation-rendering.ts';
import { renderConversationEventLine, renderConversationNotice } from '../renderer/conversation-surface.ts';
import { buildPanelLine, DEFAULT_PANEL_PALETTE, type PanelPalette } from './polish.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  fleetKindTag,
  fleetStateGlyph,
  fleetStateTone,
  type FleetStateTone,
  type FleetTreeRow,
} from './fleet-read-model.ts';

/** Duplicated from fleet-panel.ts's private helper (same tiny mapping) rather than
 *  cross-importing — fleet-panel.ts imports THIS module to render tab content, so
 *  importing back would form a cycle. See fleet-panel.ts's own toneColor for the
 *  canonical copy; keep both in sync if the tone set ever changes. */
function toneColor(tone: FleetStateTone, palette: PanelPalette): string {
  switch (tone) {
    case 'active': return palette.info ?? DEFAULT_PANEL_PALETTE.info;
    case 'success': return palette.good ?? DEFAULT_PANEL_PALETTE.good;
    case 'failure': return palette.bad ?? DEFAULT_PANEL_PALETTE.bad;
    case 'warn': return palette.warn ?? DEFAULT_PANEL_PALETTE.warn;
    case 'muted': return palette.dim;
  }
}

// ---------------------------------------------------------------------------
// Agent transcript (live/frozen split)
// ---------------------------------------------------------------------------

export type FleetTranscriptMode = 'live' | 'frozen' | 'unavailable';

export interface FleetTranscriptRender {
  readonly mode: FleetTranscriptMode;
  readonly lines: Line[];
}

/**
 * (design point 4) — a 'frozen' transcript is a static capture of a
 * completed process, not something that will change on the next render. The
 * distinction matters because this wave also introduced kill/interrupt
 * display bugs (elapsed/usage briefly climbing after a terminal state
 * shows) — a done-section tab that looked indistinguishable from a live one
 * would misleadingly suggest the underlying agent is still doing something.
 * Shown once at the top of a 'frozen' tab's content; 'live' tabs never show
 * it, and 'unavailable' tabs get the ledger fallback's own notice instead
 * (renderFleetLedgerFallback below) rather than this one.
 */
const FROZEN_TRANSCRIPT_NOTICE = 'Read-only — this agent finished; not a live view.';

function renderFrozenTranscriptNotice(width: number): Line[] {
  const palette = DEFAULT_PANEL_PALETTE;
  return renderConversationNotice(FROZEN_TRANSCRIPT_NOTICE, width, {
    accent: palette.warn ?? DEFAULT_PANEL_PALETTE.warn,
    text: palette.dim,
    dim: true,
  });
}

/**
 * Render an agent tab's transcript from a `ConversationMessageSnapshot[]`
 * already fetched by the caller (this module does no I/O of its own — it is
 * a pure renderer, same convention as fleet-read-model.ts).
 *
 * `isTerminal` distinguishes 'live' (the agent is still running — the
 * snapshot came from the SDK's live source, so it will change on the next
 * render) from 'frozen' (the agent finished — the snapshot is a static final
 * capture; caller is showing a completed conversation, not a live one).
 * An empty snapshot on a terminal agent means the source was never
 * registered or has been evicted — the caller falls back to
 * `renderFleetLedgerFallback`; an empty snapshot on a non-terminal agent
 * (e.g. the SDK hasn't sent a turn yet) legitimately means "no messages yet".
 */
export function renderFleetAgentTranscript(
  snapshot: readonly ConversationMessageSnapshot[],
  isTerminal: boolean,
  lineCache: MessageLineCache,
  width: number,
  height: number,
  configManager: ConfigManager | null,
): FleetTranscriptRender {
  if (snapshot.length === 0) {
    if (isTerminal) return { mode: 'unavailable', lines: [] };
    return { mode: 'live', lines: [buildPanelLine(width, [[' (no messages yet)', DEFAULT_PANEL_PALETTE.dim]])] };
  }

  const historyLines: Line[] = [];
  const history = {
    addLine: (line: Line): void => { historyLines.push(line); },
    addLines: (lines: Line[]): void => { historyLines.push(...lines); },
    getLineCount: (): number => historyLines.length,
  };
  // Scratch block/collapse/error registries — collapse-toggle and block-copy
  // interactions are out of scope for this tab (a later item, per the brief's
  // "transcript browse" follow-on); this render is a read-only tail view.
  const context: ConversationRenderContext = {
    history,
    blockRegistry: [],
    collapseState: new Map(),
    errorLineRegistry: [],
    messageKindRegistry: new Map(),
    configManager,
    splashOptions: {},
  };
  const messageLineRegistry: number[] = [];
  lineCache.renderInto(context, snapshot as ConversationMessageSnapshot[], width, messageLineRegistry, 0, -1);

  // Terminal agents reserve room for the frozen-transcript notice ABOVE the
  // tail window so the "read-only" framing is always visible, never scrolled
  // off by a long conversation's tail-window slice.
  const notice = isTerminal ? renderFrozenTranscriptNotice(width) : [];
  const budgetHeight = Math.max(0, height - notice.length);
  // No `&& budgetHeight > 0` guard: when the notice alone already consumes
  // the whole height budget, `historyLines.slice(historyLines.length - 0)`
  // correctly yields an empty tail (nothing fits), rather than falling
  // through to the full, un-sliced history — which the caller would then
  // head-clip, silently swapping in the OLDEST lines instead of the
  // most-recent tail this view promises.
  const visible = historyLines.length > budgetHeight
    ? historyLines.slice(historyLines.length - budgetHeight)
    : historyLines;
  return { mode: isTerminal ? 'frozen' : 'live', lines: [...notice, ...visible] };
}

// ---------------------------------------------------------------------------
// Chain summary — 'wrfc-chain' tabs have no single conversation
// ---------------------------------------------------------------------------

/**
 * Render a live one-line-per-member summary for an attached wrfc-chain tab.
 *
 * `chainDoneOrAbsent` disambiguates an empty member list: a completed
 * chain prunes its wrapper node (zombie reap), so zero members can mean the
 * chain FINISHED, not that it has not started. When the chain node is absent
 * (pruned) or terminal, say so honestly instead of the "(no member agents yet)"
 * not-started wording.
 */
export function renderFleetChainSummary(
  memberRows: readonly FleetTreeRow[],
  width: number,
  chainDoneOrAbsent: boolean,
): Line[] {
  const C = DEFAULT_PANEL_PALETTE;
  if (memberRows.length === 0) {
    const message = chainDoneOrAbsent
      ? ' chain completed — members no longer tracked'
      : ' (no member agents yet)';
    return [buildPanelLine(width, [[message, C.dim]])];
  }
  return memberRows.map((row) => {
    const node = row.node;
    const color = toneColor(fleetStateTone(node.state), C);
    return buildPanelLine(width, [
      [' ', C.dim],
      [fleetStateGlyph(node.state), color],
      [` ${fleetKindTag(node.kind)} `, C.dim],
      [node.label, C.value],
      [`  ${node.state}`, color],
      [`  ${formatElapsed(node.elapsedMs)}`, C.dim],
    ]);
  });
}

// ---------------------------------------------------------------------------
// Ledger fallback — degraded activity view for a terminal agent whose
// full-fidelity snapshot is unavailable (an honest fallback)
// ---------------------------------------------------------------------------

/**
 * Parse an agent's `<agentId>.jsonl` event ledger. Tolerant of malformed
 * lines (skipped, not thrown) — matches agent-detail-modal.ts's existing
 * JSONL-reading convention for the same file shape.
 */
export function parseAgentLedger(raw: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value !== null && typeof value === 'object') entries.push(value as Record<string, unknown>);
    } catch {
      // Skip malformed lines rather than failing the whole fallback view.
    }
  }
  return entries;
}

function formatLedgerDuration(ms: unknown): string {
  return typeof ms === 'number' ? ` (${formatElapsed(ms)})` : '';
}

function renderLedgerEntry(width: number, entry: Record<string, unknown>, palette: PanelPalette): Line {
  const type = typeof entry['type'] === 'string' ? entry['type'] : 'unknown';
  switch (type) {
    case 'meta': {
      const model = typeof entry['model'] === 'string' ? entry['model'] : 'unknown model';
      const provider = typeof entry['provider'] === 'string' ? entry['provider'] : 'unknown';
      return renderConversationEventLine(width, { marker: '●', markerFg: palette.dim, label: 'session', labelFg: palette.dim }, [
        { text: `started — ${model} (${provider})`, fg: palette.value },
      ]);
    }
    case 'session_config': {
      const task = typeof entry['task'] === 'string' ? entry['task'] : '';
      return renderConversationEventLine(width, { marker: '●', markerFg: palette.dim, label: 'task', labelFg: palette.dim }, [
        { text: truncateDisplay(task, Math.max(0, width - 20)), fg: palette.value },
      ]);
    }
    case 'llm_request': {
      const turn = typeof entry['turn'] === 'number' ? entry['turn'] : '?';
      return renderConversationEventLine(width, { marker: '◔', markerFg: palette.info, label: 'request', labelFg: palette.info }, [
        { text: `turn ${turn}`, fg: palette.dim },
      ]);
    }
    case 'llm_response': {
      const turn = typeof entry['turn'] === 'number' ? entry['turn'] : '?';
      const toolCallCount = typeof entry['toolCallCount'] === 'number' ? entry['toolCallCount'] : 0;
      return renderConversationEventLine(width, { marker: '◕', markerFg: palette.info, label: 'response', labelFg: palette.info }, [
        { text: `turn ${turn} · ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}`, fg: palette.dim },
      ]);
    }
    case 'tool_execution': {
      const toolName = typeof entry['toolName'] === 'string' ? entry['toolName'] : 'tool';
      const success = entry['success'] !== false;
      const bad = palette.bad ?? DEFAULT_PANEL_PALETTE.bad;
      // the writer already truncates this to 500 chars (session.ts's
      // resultPreview field) — passed through verbatim (collapsed to one
      // line), never re-summarized or fabricated, then tail-truncated again
      // to fit the row.
      const rawPreview = typeof entry['resultPreview'] === 'string' ? entry['resultPreview'] : '';
      const preview = rawPreview.replace(/\s+/g, ' ').trim();
      const label = `${toolName}${success ? '' : ' (failed)'}`;
      const text = preview ? `${label} — ${preview}` : label;
      return renderConversationEventLine(width, {
        marker: success ? '●' : '✗',
        markerFg: success ? palette.info : bad,
        label: 'tool',
        labelFg: success ? palette.info : bad,
      }, [
        { text: truncateDisplay(text, Math.max(0, width - 12)), fg: success ? palette.value : bad },
      ]);
    }
    case 'session_end': {
      const status = typeof entry['status'] === 'string' ? entry['status'] : 'ended';
      const good = palette.good ?? DEFAULT_PANEL_PALETTE.good;
      const bad = palette.bad ?? DEFAULT_PANEL_PALETTE.bad;
      const warn = palette.warn ?? DEFAULT_PANEL_PALETTE.warn;
      const tone = status === 'completed' ? good : status === 'failed' ? bad : warn;
      return renderConversationEventLine(width, { marker: '■', markerFg: tone, label: 'session', labelFg: tone }, [
        { text: `${status}${formatLedgerDuration(entry['durationMs'])}`, fg: tone },
      ]);
    }
    // Per-turn passive knowledge injection
    // records, appended to this same JSONL ledger as
    // `{type:'knowledge_injection', turn, ...record}` (orchestrator-runner.ts).
    // Without this case these fell through to the generic 'event' default
    // below (just the bare type name) — this renders the honest outcome
    // (what was injected, or why nothing was) instead.
    case 'knowledge_injection': {
      const turn = typeof entry['turn'] === 'number' ? entry['turn'] : '?';
      const injectedIds = Array.isArray(entry['injectedIds']) ? entry['injectedIds'] : [];
      const tokenCost = typeof entry['tokenCost'] === 'number' ? entry['tokenCost'] : 0;
      const backendTag = entry['embeddingBackend'] === 'fallback-lexical' ? ' [lexical fallback]' : '';
      if (injectedIds.length === 0) {
        const reason = typeof entry['reason'] === 'string'
          ? entry['reason']
          : 'nothing cleared the relevance floor';
        return renderConversationEventLine(width, { marker: '◇', markerFg: palette.dim, label: 'knowledge', labelFg: palette.dim }, [
          { text: `turn ${turn} · nothing injected — ${reason}${backendTag}`, fg: palette.dim },
        ]);
      }
      return renderConversationEventLine(width, { marker: '◇', markerFg: palette.info, label: 'knowledge', labelFg: palette.info }, [
        { text: `turn ${turn} · injected ${injectedIds.length} (~${tokenCost} tok)${backendTag}`, fg: palette.value },
      ]);
    }
    default:
      return renderConversationEventLine(width, { marker: '·', markerFg: palette.dim, label: 'event', labelFg: palette.dim }, [
        { text: type, fg: palette.dim },
      ]);
  }
}

/**
 * Degraded activity view for a terminal agent whose full-fidelity
 * conversation snapshot is unavailable (evicted, or never registered).
 * Explicitly framed as an activity log, never presented as a transcript
 * replay (the ledger is a truncated event record — see session.ts /
 * orchestrator-runner.ts: tool args/results are sliced to 500 chars and
 * assistant response TEXT is never written at all, only its length).
 *
 * Mirrors renderFleetAgentTranscript's notice-reservation above: the notice
 * rows are reserved ABOVE the tail window and only the body is tail-sliced,
 * so a long ledger's degraded-view cue is never the thing that scrolls off
 * (previously this tail-sliced `[...notice, ...body]` as one array, which
 * for any ledger longer than the tab height silently dropped the notice
 * itself, leaving what looked like a raw, unexplained activity feed).
 */
export function renderFleetLedgerFallback(
  entries: readonly Record<string, unknown>[],
  width: number,
  height: number,
): Line[] {
  const palette = DEFAULT_PANEL_PALETTE;
  const notice = renderConversationNotice(
    'Read-only. Full transcript unavailable for this agent — showing its activity log instead.',
    width,
    { accent: palette.warn, text: palette.dim, dim: true },
  );
  const body = entries.length === 0
    ? [buildPanelLine(width, [[' (no activity recorded)', palette.dim]])]
    : entries.map((entry) => renderLedgerEntry(width, entry, palette));
  const budgetHeight = Math.max(0, height - notice.length);
  const visible = body.length > budgetHeight
    ? body.slice(body.length - budgetHeight)
    : body;
  return [...notice, ...visible];
}

/** A blank tab-content placeholder (e.g. while a ledger load is in flight). */
export function renderFleetTranscriptLoading(width: number): Line[] {
  return [buildPanelLine(width, [[' Loading…', DEFAULT_PANEL_PALETTE.dim]]), createEmptyLine(width)];
}
