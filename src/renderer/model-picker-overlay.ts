import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { ModelPickerModal } from '../input/model-picker.ts';
import { EFFORT_DESCRIPTIONS } from '../providers/effort-levels.ts';

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
 * Render the model picker modal as Line[] for overlay in the viewport.
 * Handles model, provider, and effort modes.
 */
export function renderModelPickerOverlay(
  picker: ModelPickerModal,
  width: number,
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

  // ── Search bar (model mode only) ───────────────────────────────────────────────
  if (picker.mode === 'model') {
    // Category filter indicator
    const filterLabels: Record<string, string> = { all: 'All', free: 'Free', premium: 'Premium' };
    const filterLabel = filterLabels[picker.categoryFilter] ?? 'All';
    const filterTag = `[${filterLabel}]`;
    const searchPrefix = '\u2502 \ud83d\udd0d ';
    const cursorChar = picker.query.length > 0 ? '' : '\u2592'; // block cursor when empty
    const queryDisplay = picker.query + cursorChar;
    const filterTagW = getDisplayWidth(filterTag);
    // Available space for query: contentW minus prefix-after-border (3 for search icon+space) minus filter tag minus gap
    const maxQueryW = contentW - 3 - filterTagW - 2;
    const queryTrunc = getDisplayWidth(queryDisplay) > maxQueryW
      ? '\u2026' + queryDisplay.slice(-(maxQueryW - 1))
      : queryDisplay;
    const spacer = ' '.repeat(Math.max(0, contentW - 3 - getDisplayWidth(queryTrunc) - filterTagW - 1));
    const searchRowText = pad + searchPrefix + queryTrunc + spacer + filterTag + ' \u2502';
    lines.push(UIFactory.stringToLine(searchRowText, width, {
      fg: picker.query.length > 0 ? '#ffffff' : '244',
    }));

    // Thin divider under search bar
    const searchDivider = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    lines.push(UIFactory.stringToLine(searchDivider, width, { fg: '238' }));
  } else {
    // Empty separator for non-model modes
    const emptyRow = pad + '\u2502' + ' '.repeat(boxW - 2) + '\u2502';
    lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));
  }

  const emptyRow = pad + '\u2502' + ' '.repeat(boxW - 2) + '\u2502';

  if (picker.mode === 'model') {
    // ── Model list (grouped by provider) ───────────────────────────────────────────
    const filtered = picker.getFilteredModels();
    if (filtered.length === 0) {
      const msg = picker.query.length > 0
        ? `No models match "${picker.query.length > 20 ? picker.query.slice(0, 20) + '\u2026' : picker.query}"`
        : 'No models available';
      const noModels = pad + '\u2502 ' + msg.padEnd(contentW) + ' \u2502';
      lines.push(UIFactory.stringToLine(noModels, width, { fg: '244', dim: true }));
    } else {
      let selIdx = 0; // tracks index into filtered (not grouped) for selectedIndex comparison
      let lastProvider = '';

      for (const model of filtered) {
        // Provider group header
        if (model.provider !== lastProvider) {
          const headerText = ' \u25e4 ' + model.provider;
          const headerRow = pad + '\u2502' + headerText.padEnd(boxW - 2) + '\u2502';
          lines.push(UIFactory.stringToLine(headerRow, width, { fg: '#4488cc', bold: false }));
          lastProvider = model.provider;
        }

        const isSelected = selIdx === picker.selectedIndex;
        const indicator = isSelected ? '\u25b6 ' : '  ';

        // Left column: model id (max 24 chars), right column: display name (remaining space)
        const maxIdLen = 24;
        const idStr = model.id.length > maxIdLen
          ? model.id.slice(0, maxIdLen - 1) + '\u2026'
          : model.id.padEnd(maxIdLen);
        const remaining = contentW - maxIdLen - 4; // 4 = indicator + gap
        const nameStr = model.displayName.length > remaining
          ? model.displayName.slice(0, remaining - 1) + '\u2026'
          : model.displayName.padEnd(remaining);

        const rowText = pad + '\u2502 ' + indicator + idStr + '  ' + nameStr + ' \u2502';
        lines.push(UIFactory.stringToLine(rowText, width, {
          fg: isSelected ? '#00ffff' : '252',
          bold: isSelected,
          bg: isSelected ? '#1a2a3a' : '',
        }));

        selIdx++;
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
    // ── Provider list ───────────────────────────────────────────────────────────────────────
    if (picker.providers.length === 0) {
      const noProviders = pad + '\u2502 ' + 'No providers available'.padEnd(contentW) + ' \u2502';
      lines.push(UIFactory.stringToLine(noProviders, width, { fg: '244', dim: true }));
    } else {
      for (let i = 0; i < picker.providers.length; i++) {
        const provider = picker.providers[i];
        const isSelected = i === picker.selectedIndex;
        const indicator = isSelected ? '\u25b6 ' : '  ';
        const rowText = pad + '\u2502 ' + indicator + provider.padEnd(contentW - 2) + ' \u2502';
        lines.push(UIFactory.stringToLine(rowText, width, {
          fg: isSelected ? '#00ffff' : '252',
          bold: isSelected,
          bg: isSelected ? '#1a2a3a' : '',
        }));
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
  const filterLabel = picker.categoryFilter === 'all' ? 'All' : picker.categoryFilter === 'free' ? 'Free' : 'Premium';
  const hints = picker.mode === 'model'
    ? ` [\u2191\u2193] Navigate  [Enter] Select  [Esc] Clear/Cancel  [Tab] Filter: ${filterLabel} `
    : ' [\u2191\u2193] Navigate  [Enter] Select  [Esc] Cancel ';
  const bottomLine =
    pad + '\u2514' + hints + '\u2500'.repeat(Math.max(0, boxW - 2 - getDisplayWidth(hints))) + '\u2518';
  lines.push(UIFactory.stringToLine(bottomLine, width, { fg: '240' }));

  return lines;
}
