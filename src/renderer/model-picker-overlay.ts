import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { ModelPickerModal } from '../input/model-picker.ts';

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
  const boxW = Math.min(width - boxMargin * 2, 72);
  const contentW = boxW - 4; // 2 border chars + 2 padding chars each side
  const pad = ' '.repeat(boxMargin);

  // ── Title bar ──────────────────────────────────────────────────────────────
  const titleText = MODE_TITLES[picker.mode] ?? MODE_TITLES.model;
  const titleLine =
    pad + '\u250c' + titleText + '\u2500'.repeat(Math.max(0, boxW - 2 - getDisplayWidth(titleText))) + '\u2510';
  lines.push(UIFactory.stringToLine(titleLine, width, { fg: '#00ffff' }));

  // ── Empty separator ────────────────────────────────────────────────────────
  const emptyRow = pad + '\u2502' + ' '.repeat(boxW - 2) + '\u2502';
  lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));

  if (picker.mode === 'model') {
    // ── Model list ───────────────────────────────────────────────────────────
    if (picker.models.length === 0) {
      const noModels = pad + '\u2502 ' + 'No models available'.padEnd(contentW) + ' \u2502';
      lines.push(UIFactory.stringToLine(noModels, width, { fg: '244', dim: true }));
    } else {
      for (let i = 0; i < picker.models.length; i++) {
        const model = picker.models[i];
        const isSelected = i === picker.selectedIndex;
        const indicator = isSelected ? '\u25b6 ' : '  ';

        // Left column: model id (max 24 chars), right column: display name (remaining space)
        const maxIdLen = 24;
        const idStr = model.id.length > maxIdLen
          ? model.id.slice(0, maxIdLen - 1) + '\u2026'
          : model.id.padEnd(maxIdLen);
        const remaining = contentW - maxIdLen - 4; // 4 = indicator + gap
        // NOTE: padEnd uses .length (byte width), not display width — CJK chars
        // may cause slight misalignment. Use ASCII-safe model names where possible.
        const nameStr = model.displayName.length > remaining
          ? model.displayName.slice(0, remaining - 1) + '\u2026'
          : model.displayName.padEnd(remaining);

        const rowText = pad + '\u2502 ' + indicator + idStr + '  ' + nameStr + ' \u2502';
        lines.push(UIFactory.stringToLine(rowText, width, {
          fg: isSelected ? '#00ffff' : '252',
          bold: isSelected,
          bg: isSelected ? '#1a2a3a' : '',
        }));
      }
    }

    // ── Divider ──────────────────────────────────────────────────────────────
    const divider = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    lines.push(UIFactory.stringToLine(divider, width, { fg: '240' }));

    // ── Capability detail for selected model ─────────────────────────────────
    const selected = picker.getSelected();
    if (selected) {
      const providerLine = pad + '\u2502 ' +
        ('Provider: ' + selected.provider).padEnd(contentW) + ' \u2502';
      lines.push(UIFactory.stringToLine(providerLine, width, { fg: '244' }));

      const caps = selected.capabilities;
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
    // ── Provider list ────────────────────────────────────────────────────────
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

    // ── Divider + hint ────────────────────────────────────────────────────────
    const divider = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    lines.push(UIFactory.stringToLine(divider, width, { fg: '240' }));
    const hintLine = pad + '\u2502 ' + 'Select a provider to browse its models'.padEnd(contentW) + ' \u2502';
    lines.push(UIFactory.stringToLine(hintLine, width, { fg: '244' }));
    lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));
  } else {
    // ── Effort list ──────────────────────────────────────────────────────────
    const effortDescriptions: Record<string, string> = {
      instant: 'Fastest, minimal reasoning',
      low:     'Quick with light reasoning',
      medium:  'Balanced speed and quality',
      high:    'Thorough, deep reasoning',
    };
    for (let i = 0; i < picker.effortLevels.length; i++) {
      const level = picker.effortLevels[i];
      const isSelected = i === picker.selectedIndex;
      const indicator = isSelected ? '\u25b6 ' : '  ';
      const desc = effortDescriptions[level] ?? '';
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

    // ── Divider + model context ────────────────────────────────────────────────
    const divider = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    lines.push(UIFactory.stringToLine(divider, width, { fg: '240' }));
    const modelName = picker.pendingModel ? picker.pendingModel.displayName : 'unknown';
    const modelLine = pad + '\u2502 ' + `Model: ${modelName}`.padEnd(contentW) + ' \u2502';
    lines.push(UIFactory.stringToLine(modelLine, width, { fg: '244' }));
    lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));
  }

  // ── Bottom border with hints ───────────────────────────────────────────────
  const hints = ' [\u2191\u2193] Navigate  [Enter] Select  [Esc] Cancel ';
  const bottomLine =
    pad + '\u2514' + hints + '\u2500'.repeat(Math.max(0, boxW - 2 - getDisplayWidth(hints))) + '\u2518';
  lines.push(UIFactory.stringToLine(bottomLine, width, { fg: '240' }));

  return lines;
}
