/**
 * usage-modal.ts, the Usage modal (/usage, /cost, ctrl+p "usage").
 *
 * Reads the session's UsageTracker (runtime/usage-tracker.ts), which has been
 * collecting since startup, so opening this late loses nothing.
 *
 * Keys: tab / shift+tab (or ← →) switch Overview, Turns and Agents; ↑↓ scroll
 * the turns or pick an agent; c compacts the context now (the modal closes
 * first so the compaction's own output is visible); b edits the budget alert;
 * p sets your own price for the current model; r refreshes. Esc closes an open
 * entry first, then the modal.
 */

import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { SurfaceModal, SurfaceModalHost } from './surface-modal-host.ts';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';
import { renderUsageModal, USAGE_TABS, type UsageModalView, type UsageTab } from '../renderer/usage-modal.ts';
import type { UsageTracker } from '../runtime/usage-tracker.ts';
import { isTextBackspace } from './delete-key-policy.ts';

export interface UsageModalOptions {
  readonly tracker: UsageTracker;
  /** Run the context compaction (the /compact command). */
  readonly compact: () => void;
  /** Which tab to open on. */
  readonly tab?: UsageTab;
  /** Repaint (the tracker changed, a poll landed). */
  readonly requestRender?: () => void;
  /** How often running agents' usage is re-read while the modal is open. */
  readonly pollMs?: number;
}

export class UsageModal implements SurfaceModal, UsageModalView {
  readonly name = 'usage';
  tab: UsageTab;
  turnOffset = 0;
  agentIndex = 0;
  entry: { kind: 'budget' | 'price'; draft: string } | null = null;
  status: string | null = null;
  private readonly unsubscribe: () => void;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: UsageModalOptions) {
    this.tab = options.tab ?? 'overview';
    this.unsubscribe = options.tracker.subscribe(() => {
      this.turnOffset = Math.min(this.turnOffset, Math.max(0, this.tracker.turns().length - 1));
    });
    const pollMs = options.pollMs ?? 3_000;
    if (pollMs > 0) {
      this.pollTimer = setInterval(() => {
        if (this.tracker.pollRunningAgents()) options.requestRender?.();
      }, pollMs);
    }
  }

  get tracker(): UsageTracker {
    return this.options.tracker;
  }

  onClose(): void {
    this.unsubscribe();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  escape(): boolean {
    if (this.entry) {
      this.entry = null;
      return true;
    }
    return false;
  }

  private stepTab(direction: 1 | -1): void {
    const index = USAGE_TABS.indexOf(this.tab);
    this.tab = USAGE_TABS[(index + direction + USAGE_TABS.length) % USAGE_TABS.length]!;
    this.status = null;
  }

  private scroll(delta: number): void {
    if (this.tab === 'agents') {
      const count = this.tracker.agents().length;
      if (count === 0) return;
      this.agentIndex = Math.max(0, Math.min(count - 1, this.agentIndex + delta));
      return;
    }
    const count = this.tracker.turns().length;
    if (count === 0) return;
    // Up goes back in time (a larger offset from the newest turn).
    this.turnOffset = Math.max(0, Math.min(count - 1, this.turnOffset - delta));
  }

  private openEntry(kind: 'budget' | 'price'): void {
    if (kind === 'budget') {
      const current = this.tracker.budget();
      this.entry = { kind, draft: current > 0 ? String(current) : '' };
    } else {
      this.entry = { kind, draft: '' };
    }
    this.status = null;
  }

  private commitEntry(): void {
    const entry = this.entry;
    if (!entry) return;
    if (entry.kind === 'budget') {
      const raw = entry.draft.trim();
      const usd = Number(raw);
      if (raw.length === 0 || !this.tracker.setBudget(usd)) {
        this.status = 'Budget not changed: type an amount in USD, 0 turns the alert off.';
      } else {
        this.status = usd > 0 ? `Budget alert set to $${usd.toFixed(2)}.` : 'Budget alert turned off.';
      }
      this.entry = null;
      return;
    }
    if (!this.tracker.canSetModelPrice()) {
      this.entry = null;
      return;
    }
    const parts = entry.draft.trim().split(/[\s,]+/).filter(Boolean);
    const input = Number(parts[0]);
    const output = Number(parts[1]);
    if (parts.length === 2 && this.tracker.setModelPrice(input, output)) {
      this.status = `Price saved for ${this.tracker.modelId()}.`;
      this.entry = null;
    } else {
      // A malformed price keeps the entry open so it can be corrected.
      this.status = 'Type two amounts: input,output in USD per 1M tokens.';
    }
  }

  private handleEntryToken(token: InputToken): void {
    const entry = this.entry!;
    if (token.type === 'text') {
      const allowed = entry.kind === 'budget' ? /[0-9.]/ : /[0-9., ]/;
      for (const ch of token.value) {
        if (!allowed.test(ch)) continue;
        if (entry.kind === 'budget' && ch === '.' && entry.draft.includes('.')) continue;
        entry.draft += ch;
      }
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (key === 'enter') this.commitEntry();
    else if (isTextBackspace(key)) entry.draft = entry.draft.slice(0, -1);
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    if (this.entry) {
      this.handleEntryToken(token);
      return;
    }
    if (token.type === 'text') {
      const ch = token.value;
      if (ch === 'c') {
        host.close(this, 'done');
        this.options.compact();
      } else if (ch === 'b') this.openEntry('budget');
      else if (ch === 'p') this.openEntry('price');
      else if (ch === 'r') {
        this.tracker.pollRunningAgents();
        this.status = 'Refreshed.';
      } else if (ch === 'j') this.scroll(1);
      else if (ch === 'k') this.scroll(-1);
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (key === 'tab' && token.shift) this.stepTab(-1);
    else if (key === 'tab' || key === 'right') this.stepTab(1);
    else if (key === 'left' || key === '\x1b[Z') this.stepTab(-1);
    else if (key === 'up') this.scroll(-1);
    else if (key === 'down') this.scroll(1);
    else if (key === 'pageup') this.scroll(-5);
    else if (key === 'pagedown') this.scroll(5);
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderUsageModal(this, screenWidth, screenHeight);
  }
}
