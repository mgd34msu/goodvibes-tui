import { type Line } from '../types/grid.ts';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import type { ModelPickerModal } from '../input/model-picker.ts';
import { EFFORT_DESCRIPTIONS } from '../providers/effort-levels.ts';
import { getBenchmarks, getQualityTier, getQualityTierFromScore } from '../providers/model-benchmarks.ts';
import { getSyntheticModelInfoFromCatalog } from '../providers/model-catalog.ts';
import {
  createOverlayBorderLine,
  createOverlayBoxLayout,
  createOverlayContentLine,
  DEFAULT_OVERLAY_PALETTE,
  putOverlayText,
} from './overlay-box.ts';
import { getOverlaySurfaceMetrics } from './overlay-viewport.ts';

/** Format a context window number into a short human-readable string. */
function fmtContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Title text per picker mode. */
const MODE_TITLES: Record<string, string> = {
  model: 'Select Model',
  provider: 'Select Provider',
  effort: 'Select Effort Level',
  contextCap: 'Set Context Window',
};

/**
 * Number of fixed chrome lines in the model-picker overlay (title + search + divider + detail×2 + footer).
 * Used by callers to compute maxVisible item rows.
 */
export const MODEL_PICKER_CHROME_LINES = 7;

function putRowText(line: Line, startX: number, maxWidth: number, text: string, fg: string, bg = '', bold = false, dim = false): void {
  putOverlayText(line, startX, maxWidth, text, { fg, bg, bold, dim });
}

/**
 * Render the model picker modal as Line[] for overlay in the viewport.
 * Handles model, provider, and effort modes.
 *
 * @param maxVisible - Maximum number of item rows to show (controls the scroll window).
 *   Derived from viewport height minus chrome lines. Defaults to 20.
 */
export function renderModelPickerOverlay(
  picker: ModelPickerModal,
  width: number,
  maxVisible = 20,
  viewportHeight?: number,
): Line[] {
  const lines: Line[] = [];
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight ?? 24, {
    chromeRows: MODEL_PICKER_CHROME_LINES,
    maxWidth: 72,
    minContentRows: 6,
    maxContentRows: Math.max(10, maxVisible),
  });
  const layout = createOverlayBoxLayout(width, metrics.margin, metrics.boxWidth);
  const contentW = layout.innerWidth;
  const borderFg = DEFAULT_OVERLAY_PALETTE.borderFg;
  const titleFg = DEFAULT_OVERLAY_PALETTE.titleFg;
  const bodyFg = DEFAULT_OVERLAY_PALETTE.bodyFg;
  const mutedFg = DEFAULT_OVERLAY_PALETTE.mutedFg;
  const selectedBg = DEFAULT_OVERLAY_PALETTE.selectedBg;

  // ── Title bar ───────────────────────────────────────────────────────────────────────
  const titleLine = createOverlayBorderLine(width, layout, '┌', '─', '┐', borderFg);
  putRowText(
    titleLine,
    layout.margin + 2,
    layout.width - 4,
    truncateDisplay((MODE_TITLES[picker.mode] ?? MODE_TITLES.model).replace(/^─\s*/, '').trim(), layout.width - 4),
    titleFg,
    '',
    true,
  );
  lines.push(titleLine);

  // ── Search bar (model and provider modes) ────────────────────────────────────
  if (picker.mode === 'model' || picker.mode === 'provider') {
    const searchLine = createOverlayContentLine(width, layout, borderFg);
    const searchPrefix = '/ ';
    const queryDisplay = picker.query + (picker.searchFocused ? '█' : '');
    let filterTag = '';
    let filterTagW = 0;
    if (picker.mode === 'model') {
      // Category filter indicator — model mode only
      const filterLabels: Record<string, string> = { all: 'All', free: 'Free', paid: 'Paid', subscription: 'Sub' };
      const filterLabel = filterLabels[picker.categoryFilter] ?? 'All';
      filterTag = `[${filterLabel}]`;
      filterTagW = getDisplayWidth(filterTag);
    }
    const maxQueryW = contentW - getDisplayWidth(searchPrefix) - filterTagW - (filterTagW > 0 ? 2 : 0);
    const queryTrunc = getDisplayWidth(queryDisplay) > maxQueryW
      ? truncateDisplay(queryDisplay, maxQueryW)
      : queryDisplay;
    let rowX = layout.margin + 2;
    putRowText(searchLine, rowX, getDisplayWidth(searchPrefix), searchPrefix, picker.searchFocused ? bodyFg : mutedFg);
    rowX += getDisplayWidth(searchPrefix);
    const queryAreaWidth = filterTag
      ? Math.max(0, contentW - getDisplayWidth(searchPrefix) - filterTagW - 1)
      : Math.max(0, contentW - getDisplayWidth(searchPrefix));
    putRowText(searchLine, rowX, queryAreaWidth, fitDisplay(queryTrunc, queryAreaWidth), picker.query.length > 0 || picker.searchFocused ? '#ffffff' : mutedFg);
    if (filterTag) {
      putRowText(
        searchLine,
        layout.margin + 2 + contentW - filterTagW,
        filterTagW,
        filterTag,
        mutedFg,
      );
    }
    lines.push(searchLine);

    // Thin divider under search bar
    lines.push(createOverlayBorderLine(width, layout, '├', '─', '┤', borderFg));
  } else {
    lines.push(createOverlayContentLine(width, layout, borderFg));
  }

  if (picker.mode === 'model') {
    // ── Model list (grouped, with scroll window) ────────────────────────────────────
    const filtered = picker.getFilteredModels();
    if (filtered.length === 0) {
      const msg = picker.query.length > 0
        ? `No models match "${picker.query.length > 20 ? picker.query.slice(0, 20) + '...' : picker.query}"`
        : 'No models available';
      const noModels = createOverlayContentLine(width, layout, borderFg);
      putRowText(noModels, layout.margin + 2, contentW, fitDisplay(truncateDisplay(msg, contentW), contentW), '244', '', false, true);
      lines.push(noModels);
    } else {
      // Determine the visible slice [scrollOffset, scrollOffset + maxVisible)
      const scrollOffset = Math.max(0, Math.min(picker.scrollOffset, Math.max(0, filtered.length - maxVisible)));
      const visibleEnd = Math.min(filtered.length, scrollOffset + maxVisible);
      const visibleModels = filtered.slice(scrollOffset, visibleEnd);

      // Scroll indicators
      if (scrollOffset > 0) {
        const upHint = createOverlayContentLine(width, layout, borderFg);
        putRowText(upHint, layout.margin + 2, contentW, fitDisplay(`↑ ${scrollOffset} more above`, contentW), mutedFg, '', false, true);
        lines.push(upHint);
      }

      let lastGroupKey = '';
      // Track the absolute index for group header display
      // Use getModelGroupKey for synthetic sub-group support (Top Models / All Synthetic)
      for (let i = 0; i < visibleModels.length; i++) {
        const model = visibleModels[i];
        const absIdx = scrollOffset + i; // index into filtered[] for selectedIndex comparison

        // Group header — show when group key changes within the visible window
        // For the first visible item, always check if header is needed
        const groupKey = picker.getModelGroupKey(model);
        if (groupKey !== lastGroupKey) {
          const headerRow = createOverlayContentLine(width, layout, borderFg);
          putRowText(headerRow, layout.margin + 2, contentW, fitDisplay(`[${groupKey}]`, contentW), '#4488cc');
          lines.push(headerRow);
          lastGroupKey = groupKey;
        }

        const isSelected = absIdx === picker.selectedIndex;
        const indicator = isSelected ? '▸ ' : '  ';

        // Pre-compute synthetic info once per model (avoid 3 separate lookups per frame)
        const synthInfo = model.provider === 'synthetic' ? getSyntheticModelInfoFromCatalog(model.id) : null;

        // Quality tier badge: [S] / [A] / [B] / [C]
        let tier: string | null = null;
        if (model.provider === 'synthetic') {
          if (synthInfo?.bestCompositeScore != null) {
            tier = getQualityTierFromScore(synthInfo.bestCompositeScore);
          }
        } else {
          const bData = getBenchmarks(model.id) ?? getBenchmarks(model.displayName);
          tier = bData ? getQualityTier(bData.benchmarks) : null;
        }
        const tierBadge = tier ? `[${tier}]` : '   ';
        // Pin marker: keep the Unicode star instead of ASCII fallback
        const pinStar = picker.pinnedIds.has(model.id) ? '★ ' : '  ';
        // Free badge: dot marker, not an asterisk
        const freeBadge = model.tier === 'free' ? '•' : ' ';
        // Provider count for synthetic models
        let providerCountStr = '     '; // 5 chars wide (fixed)
        if (synthInfo) {
          const countLabel = `(${synthInfo.keyedBackendCount}p)`;
          providerCountStr = countLabel.padEnd(5);
        }

        // Layout: indicator(2) + pin(2) + id(maxIdLen) + gap(2) + name(remaining) + provCount(5) + free(1) + tier(3)
        const maxIdLen = 20;
        const provCountW = 5;
        const badgesW = 3 + 1 + 2; // tierBadge(3) + freeBadge(1) + gap(2)
        const idStr = model.id.length > maxIdLen
          ? model.id.slice(0, maxIdLen - 3) + '...'
          : model.id.padEnd(maxIdLen);
        const remaining = contentW - maxIdLen - 4 - badgesW - 2 - provCountW; // 4 = indicator+pin, 2 = gap before name
        const nameStr = model.displayName.length > Math.max(0, remaining)
          ? model.displayName.slice(0, Math.max(0, remaining) - 3) + '...'
          : model.displayName.padEnd(Math.max(0, remaining));

        const row = createOverlayContentLine(width, layout, borderFg, isSelected ? selectedBg : '');
        let x = layout.margin + 2;
        const rowText = indicator + pinStar + idStr + '  ' + nameStr + providerCountStr + ' ' + freeBadge + tierBadge;
        putRowText(row, x, contentW, fitDisplay(truncateDisplay(rowText, contentW), contentW), isSelected ? titleFg : bodyFg, isSelected ? selectedBg : '', isSelected);
        lines.push(row);
      }

      if (visibleEnd < filtered.length) {
        const remaining2 = filtered.length - visibleEnd;
        const downHint = createOverlayContentLine(width, layout, borderFg);
        putRowText(downHint, layout.margin + 2, contentW, fitDisplay(`↓ ${remaining2} more below`, contentW), mutedFg, '', false, true);
        lines.push(downHint);
      }
    }

    // ── Divider ────────────────────────────────────────────────────────────────────
    lines.push(createOverlayBorderLine(width, layout, '├', '─', '┤', borderFg));

    // ── Capability detail for selected model ────────────────────────────────────────────
    const selected = picker.getSelected();
    if (selected) {
      const providerLine = createOverlayContentLine(width, layout, borderFg);
      putRowText(providerLine, layout.margin + 2, contentW, fitDisplay(`Provider: ${selected.provider}`, contentW), '244');
      lines.push(providerLine);

      const caps = selected.capabilities ?? { reasoning: false, multimodal: false, toolCalling: false, codeEditing: false };
      const ctxStr = `Context: ${fmtContext(selected.contextWindow)}`;
      const capParts: string[] = [ctxStr];
      if (caps.reasoning)  capParts.push('Reasoning: \u2713');
      if (caps.multimodal) capParts.push('Vision: \u2713');
      if (caps.toolCalling) capParts.push('Tools: \u2713');
      if (caps.codeEditing) capParts.push('Code: \u2713');
      const capText = capParts.join('  ');
      const capLine = createOverlayContentLine(width, layout, borderFg);
      putRowText(capLine, layout.margin + 2, contentW, fitDisplay(truncateDisplay(capText, contentW), contentW), '244');
      lines.push(capLine);
    } else {
      lines.push(createOverlayContentLine(width, layout, borderFg));
      lines.push(createOverlayContentLine(width, layout, borderFg));
    }
  } else if (picker.mode === 'provider') {
    // ── Provider list (grouped: Popular / All Providers) ───────────────────────────────────
    const allProviderItems = picker.getItems(); // includes group headers
    const selectableCount = picker.getFilteredProviders().length;
    if (selectableCount === 0) {
      const msg = picker.query.length > 0
        ? `No providers match "${picker.query.length > 20 ? picker.query.slice(0, 20) + '...' : picker.query}"`
        : 'No providers available';
      const noProviders = createOverlayContentLine(width, layout, borderFg);
      putRowText(noProviders, layout.margin + 2, contentW, fitDisplay(truncateDisplay(msg, contentW), contentW), '244', '', false, true);
      lines.push(noProviders);
    } else {
      // Build the flat selectable index → item-list-index mapping for scroll tracking
      // scrollOffset / selectedIndex track selectable items only
      const providerScrollOffset = Math.max(0, Math.min(picker.scrollOffset, Math.max(0, selectableCount - maxVisible)));
      const providerVisibleEnd = Math.min(selectableCount, providerScrollOffset + maxVisible);

      // Scroll indicator — items above
      if (providerScrollOffset > 0) {
        const upHint = createOverlayContentLine(width, layout, borderFg);
        putRowText(upHint, layout.margin + 2, contentW, fitDisplay(`↑ ${providerScrollOffset} more above`, contentW), mutedFg, '', false, true);
        lines.push(upHint);
      }

      // Walk all provider items (headers + selectables), rendering only selectables
      // in [providerScrollOffset, providerVisibleEnd). Headers are shown when the
      // first selectable item in their group is visible.
      let selectableIdx = -1;
      let pendingHeader: string | null = null;

      for (const item of allProviderItems) {
        if (item.isGroupHeader) {
          pendingHeader = item.label;
          continue;
        }
        selectableIdx++;
        if (selectableIdx < providerScrollOffset) {
          pendingHeader = null; // group header passed, no longer pending
          continue;
        }
        if (selectableIdx >= providerVisibleEnd) break;

        // Emit pending group header before first visible item in the group
        if (pendingHeader !== null) {
          const headerRow = createOverlayContentLine(width, layout, borderFg);
          putRowText(headerRow, layout.margin + 2, contentW, fitDisplay(`[${pendingHeader}]`, contentW), '#4488cc');
          lines.push(headerRow);
          pendingHeader = null;
        }

        const isSelected = selectableIdx === picker.selectedIndex;
        const indicator = isSelected ? '▸ ' : '  ';
        const checkmark = item.isConfigured ? '✓ ' : '  ';
        const labelW = contentW - 2 - 2; // indicator(2) + checkmark(2)
        const labelStr = item.label.length > labelW
          ? item.label.slice(0, labelW - 3) + '...'
          : item.label.padEnd(labelW);
        const row = createOverlayContentLine(width, layout, borderFg, isSelected ? selectedBg : '');
        const rowText = indicator + checkmark + labelStr;
        putRowText(row, layout.margin + 2, contentW, fitDisplay(truncateDisplay(rowText, contentW), contentW), isSelected ? titleFg : bodyFg, isSelected ? selectedBg : '', isSelected);
        lines.push(row);
      }

      // Scroll indicator — items below
      if (providerVisibleEnd < selectableCount) {
        const remaining2 = selectableCount - providerVisibleEnd;
        const downHint = createOverlayContentLine(width, layout, borderFg);
        putRowText(downHint, layout.margin + 2, contentW, fitDisplay(`↓ ${remaining2} more below`, contentW), mutedFg, '', false, true);
        lines.push(downHint);
      }
    }

    // ── Divider + hint ──────────────────────────────────────────────────────────────────
    lines.push(createOverlayBorderLine(width, layout, '├', '─', '┤', borderFg));
    const hintLine = createOverlayContentLine(width, layout, borderFg);
    putRowText(hintLine, layout.margin + 2, contentW, fitDisplay('Select a provider to browse its models', contentW), '244');
    lines.push(hintLine);
    lines.push(createOverlayContentLine(width, layout, borderFg));
  } else if (picker.mode === 'contextCap') {
    // ── Context cap input ──────────────────────────────────────────────────────────────
    const capModel = picker.contextCapPendingModel;
    const modelName = capModel ? capModel.displayName : 'unknown';
    const currentCtx = capModel ? fmtContext(capModel.contextWindow) : '?';
    const provenance = capModel?.contextWindowProvenance ?? 'configured_cap';

    const promptLabel = 'Context window (tokens):';
    const cursorChar = '█';
    const inputDisplay = picker.contextCapQuery + cursorChar;
    const promptRow = createOverlayContentLine(width, layout, borderFg);
    putRowText(promptRow, layout.margin + 2, contentW, fitDisplay(`${promptLabel} ${inputDisplay}`, contentW), '#ffffff');
    lines.push(promptRow);

    lines.push(createOverlayContentLine(width, layout, borderFg));

    const hintText = `Leave blank to use default (current: ${currentCtx}, source: ${provenance})`;
    const hintTrunc = getDisplayWidth(hintText) > contentW
      ? hintText.slice(0, contentW - 3) + '...'
      : hintText;
    const hintRow = createOverlayContentLine(width, layout, borderFg);
    putRowText(hintRow, layout.margin + 2, contentW, fitDisplay(hintTrunc, contentW), '244', '', false, true);
    lines.push(hintRow);

    // Divider + model info
    lines.push(createOverlayBorderLine(width, layout, '├', '─', '┤', borderFg));
    const modelInfoLine = createOverlayContentLine(width, layout, borderFg);
    putRowText(modelInfoLine, layout.margin + 2, contentW, fitDisplay(`Model: ${modelName}`, contentW), '244');
    lines.push(modelInfoLine);
    lines.push(createOverlayContentLine(width, layout, borderFg));
  } else {
    // ── Effort list ────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < picker.effortLevels.length; i++) {
      const level = picker.effortLevels[i];
      const isSelected = i === picker.selectedIndex;
      const indicator = isSelected ? '▸ ' : '  ';
      const desc = EFFORT_DESCRIPTIONS[level] ?? '';
      const labelW = 10;
      const labelStr = level.padEnd(labelW);
      const remaining = contentW - labelW - 4;
      const descStr = desc.length > remaining ? desc.slice(0, remaining - 3) + '...' : desc.padEnd(remaining);
      const row = createOverlayContentLine(width, layout, borderFg, isSelected ? selectedBg : '');
      const rowText = indicator + labelStr + '  ' + descStr;
      putRowText(row, layout.margin + 2, contentW, fitDisplay(truncateDisplay(rowText, contentW), contentW), isSelected ? titleFg : bodyFg, isSelected ? selectedBg : '', isSelected);
      lines.push(row);
    }

    // ── Divider + model context ──────────────────────────────────────────────────────
    lines.push(createOverlayBorderLine(width, layout, '├', '─', '┤', borderFg));
    const modelName = picker.pendingModel ? picker.pendingModel.displayName : 'unknown';
    const modelLine = createOverlayContentLine(width, layout, borderFg);
    putRowText(modelLine, layout.margin + 2, contentW, fitDisplay(`Model: ${modelName}`, contentW), '244');
    lines.push(modelLine);
    lines.push(createOverlayContentLine(width, layout, borderFg));
  }

  // ── Bottom border with hints ─────────────────────────────────────────────────────────
  const filterLabelsFooter: Record<string, string> = { all: 'All', free: 'Free', paid: 'Paid', subscription: 'Sub' };
  const filterLabelFooter = filterLabelsFooter[picker.categoryFilter] ?? 'All';
  const groupByLabel = picker.groupBy ?? 'provider';
  const selectedModel = picker.mode === 'model' ? picker.getSelected() : null;
  const showContextCapHint = selectedModel != null && selectedModel.contextWindowProvenance !== undefined;
  const hints = picker.mode === 'model'
    ? showContextCapHint
      ? `[Up/Down] [Enter] [/] Search [Space] Ctx [Esc] [Tab] Filter: ${filterLabelFooter} [G] Group: ${groupByLabel}`
      : `[Up/Down] [Enter] [/] Search [Esc] [Tab] Filter: ${filterLabelFooter} [G] Group: ${groupByLabel}`
    : picker.mode === 'contextCap'
    ? '[Enter] Confirm  [Esc] Cancel'
    : '[Up/Down] Nav  [Enter] Select  [Esc] Cancel';
  const footerLine = createOverlayBorderLine(width, layout, '└', '─', '┘', borderFg);
  putRowText(footerLine, layout.margin + 2, contentW, fitDisplay(truncateDisplay(hints, contentW), contentW), mutedFg, '', false, true);
  lines.push(footerLine);

  return lines;
}
