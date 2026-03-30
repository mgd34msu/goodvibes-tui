import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { ModelPickerModal } from '../input/model-picker.ts';
import { EFFORT_DESCRIPTIONS } from '../providers/effort-levels.ts';
import { getBenchmarks, getQualityTier, S_TIER_THRESHOLD, A_TIER_THRESHOLD, B_TIER_THRESHOLD } from '../providers/model-benchmarks.ts';
import { getSyntheticModelInfoFromCatalog } from '../providers/model-catalog.ts';

/** Format a context window number into a short human-readable string. */
function fmtContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Title text per picker mode. */
const MODE_TITLES: Record<string, string> = {
  model: '\u2500 Select Model ',
  provider: '\u2500 Select Provider ',
  effort: '\u2500 Select Effort Level ',
};

/**
 * Number of fixed chrome lines in the model-picker overlay (title + search + divider + detail×2 + footer).
 * Used by callers to compute maxVisible item rows.
 */
export const MODEL_PICKER_CHROME_LINES = 7;

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
): Line[] {
  const lines: Line[] = [];
  const boxMargin = 4;
  const boxW = Math.max(4, Math.min(width - boxMargin * 2, 72));
  const contentW = boxW - 4; // 2 border chars + 2 padding chars each side
  const pad = ' '.repeat(boxMargin);

  // ── Title bar ───────────────────────────────────────────────────────────────────────
  const titleText = MODE_TITLES[picker.mode] ?? MODE_TITLES.model;
  const titleLine =
    pad + '\u250c' + titleText + '\u2500'.repeat(Math.max(0, boxW - 2 - getDisplayWidth(titleText))) + '\u2510';
  lines.push(UIFactory.stringToLine(titleLine, width, { fg: '#00ffff' }));

  // ── Search bar (model and provider modes) ────────────────────────────────────
  if (picker.mode === 'model' || picker.mode === 'provider') {
    const searchPrefix = '\u2502 \ud83d\udd0d ';
    const cursorChar = picker.query.length > 0 ? '' : '\u2592'; // block cursor when empty
    const queryDisplay = picker.query + cursorChar;
    let filterTag = '';
    let filterTagW = 0;
    if (picker.mode === 'model') {
      // Category filter indicator — model mode only
      const filterLabels: Record<string, string> = { all: 'All', free: 'Free', paid: 'Paid', subscription: 'Sub' };
      const filterLabel = filterLabels[picker.categoryFilter] ?? 'All';
      filterTag = `[${filterLabel}]`;
      filterTagW = getDisplayWidth(filterTag);
    }
    // Available space for query: contentW minus prefix-after-border (3 for search icon+space) minus filter tag minus gap
    const maxQueryW = contentW - 3 - filterTagW - (filterTagW > 0 ? 2 : 1);
    const queryTrunc = getDisplayWidth(queryDisplay) > maxQueryW
      ? '\u2026' + queryDisplay.slice(-(maxQueryW - 1))
      : queryDisplay;
    const spacer = ' '.repeat(Math.max(0, contentW - 3 - getDisplayWidth(queryTrunc) - filterTagW - (filterTagW > 0 ? 1 : 0)));
    const searchRowText = filterTag
      ? pad + searchPrefix + queryTrunc + spacer + filterTag + ' \u2502'
      : pad + searchPrefix + queryTrunc + spacer + '\u2502';
    lines.push(UIFactory.stringToLine(searchRowText, width, {
      fg: picker.query.length > 0 ? '#ffffff' : '244',
    }));

    // Thin divider under search bar
    const searchDivider = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    lines.push(UIFactory.stringToLine(searchDivider, width, { fg: '238' }));
  } else {
    // Empty separator for effort mode
    const emptyRow = pad + '\u2502' + ' '.repeat(boxW - 2) + '\u2502';
    lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));
  }

  const emptyRow = pad + '\u2502' + ' '.repeat(boxW - 2) + '\u2502';

  if (picker.mode === 'model') {
    // ── Model list (grouped, with scroll window) ────────────────────────────────────
    const filtered = picker.getFilteredModels();
    if (filtered.length === 0) {
      const msg = picker.query.length > 0
        ? `No models match "${picker.query.length > 20 ? picker.query.slice(0, 20) + '\u2026' : picker.query}"`
        : 'No models available';
      const noModels = pad + '\u2502 ' + msg.padEnd(contentW) + ' \u2502';
      lines.push(UIFactory.stringToLine(noModels, width, { fg: '244', dim: true }));
    } else {
      // Determine the visible slice [scrollOffset, scrollOffset + maxVisible)
      const scrollOffset = Math.max(0, Math.min(picker.scrollOffset, Math.max(0, filtered.length - maxVisible)));
      const visibleEnd = Math.min(filtered.length, scrollOffset + maxVisible);
      const visibleModels = filtered.slice(scrollOffset, visibleEnd);

      // Scroll indicators
      if (scrollOffset > 0) {
        const upHint = pad + '\u2502' + (` \u25b4 ${scrollOffset} more above`).padEnd(boxW - 2) + '\u2502';
        lines.push(UIFactory.stringToLine(upHint, width, { fg: '240', dim: true }));
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
          const headerText = ' \u25e4 ' + groupKey;
          const headerRow = pad + '\u2502' + headerText.padEnd(boxW - 2) + '\u2502';
          lines.push(UIFactory.stringToLine(headerRow, width, { fg: '#4488cc', bold: false }));
          lastGroupKey = groupKey;
        }

        const isSelected = absIdx === picker.selectedIndex;
        const indicator = isSelected ? '\u25b6 ' : '  ';

        // Pre-compute synthetic info once per model (avoid 3 separate lookups per frame)
        const synthInfo = model.provider === 'synthetic' ? getSyntheticModelInfoFromCatalog(model.id) : null;

        // Quality tier badge: [S] / [A] / [B] / [C]
        let tier: string | null = null;
        if (model.provider === 'synthetic') {
          if (synthInfo?.bestCompositeScore != null) {
            const s = synthInfo.bestCompositeScore;
            tier = s >= S_TIER_THRESHOLD ? 'S' : s >= A_TIER_THRESHOLD ? 'A' : s >= B_TIER_THRESHOLD ? 'B' : 'C';
          }
        } else {
          const bData = getBenchmarks(model.id) ?? getBenchmarks(model.displayName);
          tier = bData ? getQualityTier(bData.benchmarks) : null;
        }
        const tierBadge = tier ? `[${tier}]` : '   ';
        // Pin star: ★ if pinned
        const pinStar = picker.pinnedIds.has(model.id) ? '\u2605 ' : '  ';
        // Free badge
        const freeBadge = model.tier === 'free' ? '\u25c6' : ' ';
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
          ? model.id.slice(0, maxIdLen - 1) + '\u2026'
          : model.id.padEnd(maxIdLen);
        const remaining = contentW - maxIdLen - 4 - badgesW - 2 - provCountW; // 4 = indicator+pin, 2 = gap before name
        const nameStr = model.displayName.length > Math.max(0, remaining)
          ? model.displayName.slice(0, Math.max(0, remaining) - 1) + '\u2026'
          : model.displayName.padEnd(Math.max(0, remaining));

        const rowText = pad + '\u2502 ' + indicator + pinStar + idStr + '  ' + nameStr + providerCountStr + ' ' + freeBadge + tierBadge + ' \u2502';
        lines.push(UIFactory.stringToLine(rowText, width, {
          fg: isSelected ? '#00ffff' : '252',
          bold: isSelected,
          bg: isSelected ? '#1a2a3a' : '',
        }));
      }

      if (visibleEnd < filtered.length) {
        const remaining2 = filtered.length - visibleEnd;
        const downHint = pad + '\u2502' + (` \u25be ${remaining2} more below`).padEnd(boxW - 2) + '\u2502';
        lines.push(UIFactory.stringToLine(downHint, width, { fg: '240', dim: true }));
      }
    }

    // ── Divider ────────────────────────────────────────────────────────────────────
    const divider = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    lines.push(UIFactory.stringToLine(divider, width, { fg: '240' }));

    // ── Capability detail for selected model ────────────────────────────────────────────
    const selected = picker.getSelected();
    if (selected) {
      const providerLine = pad + '\u2502 ' +
        ('Provider: ' + selected.provider).padEnd(contentW) + ' \u2502';
      lines.push(UIFactory.stringToLine(providerLine, width, { fg: '244' }));

      const caps = selected.capabilities ?? { reasoning: false, multimodal: false, toolCalling: false, codeEditing: false };
      const ctxStr = `Context: ${fmtContext(selected.contextWindow)}`;
      const capParts: string[] = [ctxStr];
      if (caps.reasoning)  capParts.push('Reasoning: \u2713');
      if (caps.multimodal) capParts.push('Vision: \u2713');
      if (caps.toolCalling) capParts.push('Tools: \u2713');
      if (caps.codeEditing) capParts.push('Code: \u2713');
      const capText = capParts.join('  ');
      const capPadded = capText + ' '.repeat(Math.max(0, contentW - getDisplayWidth(capText)));
      const capLine = pad + '\u2502 ' + capPadded + ' \u2502';
      lines.push(UIFactory.stringToLine(capLine, width, { fg: '244' }));
    } else {
      lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));
      lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));
    }
  } else if (picker.mode === 'provider') {
    // ── Provider list (grouped: Popular / All Providers) ───────────────────────────────────
    const allProviderItems = picker.getItems(); // includes group headers
    const selectableCount = picker.getFilteredProviders().length;
    if (selectableCount === 0) {
      const msg = picker.query.length > 0
        ? `No providers match "${picker.query.length > 20 ? picker.query.slice(0, 20) + '\u2026' : picker.query}"`
        : 'No providers available';
      const noProviders = pad + '\u2502 ' + msg.padEnd(contentW) + ' \u2502';
      lines.push(UIFactory.stringToLine(noProviders, width, { fg: '244', dim: true }));
    } else {
      // Build the flat selectable index → item-list-index mapping for scroll tracking
      // scrollOffset / selectedIndex track selectable items only
      const providerScrollOffset = Math.max(0, Math.min(picker.scrollOffset, Math.max(0, selectableCount - maxVisible)));
      const providerVisibleEnd = Math.min(selectableCount, providerScrollOffset + maxVisible);

      // Scroll indicator — items above
      if (providerScrollOffset > 0) {
        const upHint = pad + '\u2502' + (` \u25b4 ${providerScrollOffset} more above`).padEnd(boxW - 2) + '\u2502';
        lines.push(UIFactory.stringToLine(upHint, width, { fg: '240', dim: true }));
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
          const headerText = ' \u25e4 ' + pendingHeader;
          const headerRow = pad + '\u2502' + headerText.padEnd(boxW - 2) + '\u2502';
          lines.push(UIFactory.stringToLine(headerRow, width, { fg: '#4488cc' }));
          pendingHeader = null;
        }

        const isSelected = selectableIdx === picker.selectedIndex;
        const indicator = isSelected ? '\u25b6 ' : '  ';
        const checkmark = item.isConfigured ? '\u2713 ' : '  ';
        const labelW = contentW - 2 - 2; // indicator(2) + checkmark(2)
        const labelStr = item.label.length > labelW
          ? item.label.slice(0, labelW - 1) + '\u2026'
          : item.label.padEnd(labelW);
        const rowText = pad + '\u2502 ' + indicator + checkmark + labelStr + ' \u2502';
        lines.push(UIFactory.stringToLine(rowText, width, {
          fg: isSelected ? '#00ffff' : '252',
          bold: isSelected,
          bg: isSelected ? '#1a2a3a' : '',
        }));
      }

      // Scroll indicator — items below
      if (providerVisibleEnd < selectableCount) {
        const remaining2 = selectableCount - providerVisibleEnd;
        const downHint = pad + '\u2502' + (` \u25be ${remaining2} more below`).padEnd(boxW - 2) + '\u2502';
        lines.push(UIFactory.stringToLine(downHint, width, { fg: '240', dim: true }));
      }
    }

    // ── Divider + hint ──────────────────────────────────────────────────────────────────
    const divider = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    lines.push(UIFactory.stringToLine(divider, width, { fg: '240' }));
    const hintLine = pad + '\u2502 ' + 'Select a provider to browse its models'.padEnd(contentW) + ' \u2502';
    lines.push(UIFactory.stringToLine(hintLine, width, { fg: '244' }));
    lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));
  } else {
    // ── Effort list ────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < picker.effortLevels.length; i++) {
      const level = picker.effortLevels[i];
      const isSelected = i === picker.selectedIndex;
      const indicator = isSelected ? '\u25b6 ' : '  ';
      const desc = EFFORT_DESCRIPTIONS[level] ?? '';
      const labelW = 10;
      const labelStr = level.padEnd(labelW);
      const remaining = contentW - labelW - 4;
      const descStr = desc.length > remaining ? desc.slice(0, remaining - 1) + '\u2026' : desc.padEnd(remaining);
      const rowText = pad + '\u2502 ' + indicator + labelStr + '  ' + descStr + ' \u2502';
      lines.push(UIFactory.stringToLine(rowText, width, {
        fg: isSelected ? '#00ffff' : '252',
        bold: isSelected,
        bg: isSelected ? '#1a2a3a' : '',
      }));
    }

    // ── Divider + model context ──────────────────────────────────────────────────────
    const divider = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    lines.push(UIFactory.stringToLine(divider, width, { fg: '240' }));
    const modelName = picker.pendingModel ? picker.pendingModel.displayName : 'unknown';
    const modelLine = pad + '\u2502 ' + `Model: ${modelName}`.padEnd(contentW) + ' \u2502';
    lines.push(UIFactory.stringToLine(modelLine, width, { fg: '244' }));
    lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));
  }

  // ── Bottom border with hints ─────────────────────────────────────────────────────────
  const filterLabelsFooter: Record<string, string> = { all: 'All', free: 'Free', paid: 'Paid', subscription: 'Sub' };
  const filterLabelFooter = filterLabelsFooter[picker.categoryFilter] ?? 'All';
  const groupByLabel = picker.groupBy ?? 'provider';
  const hints = picker.mode === 'model'
    ? ` [\u2191\u2193] Navigate  [Enter] Select  [Esc] Clear/Cancel  [Tab] Filter: ${filterLabelFooter}  [G] Group: ${groupByLabel} `
    : ' [\u2191\u2193] Navigate  [Enter] Select  [Esc] Cancel ';
  const bottomLine =
    pad + '\u2514' + hints + '\u2500'.repeat(Math.max(0, boxW - 2 - getDisplayWidth(hints))) + '\u2518';
  lines.push(UIFactory.stringToLine(bottomLine, width, { fg: '240' }));

  return lines;
}
