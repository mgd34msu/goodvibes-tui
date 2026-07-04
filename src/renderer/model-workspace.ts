/**
 * Fullscreen provider/model workspace.
 *
 * This keeps the model-picker data and commit behavior, but presents it as a
 * stable workspace with explicit target slots instead of a compact overlay.
 */

import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import type { ModelPickerModal } from '../input/model-picker.ts';
import type { ModelPickerTargetInfo } from '../input/model-picker.ts';
import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { fitDisplay, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { abbreviateCount } from '../utils/format-number.ts';
import { GLYPHS, UI_TONES } from './ui-primitives.ts';

const PALETTE = {
  border: UI_TONES.border,
  title: '#67e8f9',
  subtitle: UI_TONES.accent.conversation,
  text: UI_TONES.fg.primary,
  muted: UI_TONES.fg.muted,
  dim: UI_TONES.border,
  selectedBg: UI_TONES.bg.selected,
  targetBg: '#141b25',
  detailBg: '#121923',
  bodyBg: '#0f141d',
  footerBg: UI_TONES.bg.footer,
  good: UI_TONES.state.good,
  warn: UI_TONES.state.warn,
  info: UI_TONES.state.info,
};

const renderCache = new WeakMap<ModelPickerModal, { key: string; lines: Line[] }>();
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fillRange(line: Line, startX: number, endX: number, bg: string): void {
  for (let x = Math.max(0, startX); x <= Math.min(line.length - 1, endX); x += 1) {
    const cell = line[x] ?? createStyledCell(' ');
    line[x] = createStyledCell(cell.char, {
      fg: cell.fg,
      bg,
      bold: cell.bold,
      dim: cell.dim,
      underline: cell.underline,
      italic: cell.italic,
      strikethrough: cell.strikethrough,
      link: cell.link,
    });
  }
}

function makeLine(width: number, bg = ''): Line {
  const line = createEmptyLine(width);
  if (bg) fillRange(line, 0, width - 1, bg);
  return line;
}

function writeText(line: Line, startX: number, maxWidth: number, text: string, style: Partial<Omit<Line[number], 'char'>> = {}): void {
  let x = startX;
  let used = 0;
  for (const ch of text) {
    const width = getDisplayWidth(ch);
    if (width <= 0) continue;
    if (used + width > maxWidth || x >= line.length) break;
    line[x] = createStyledCell(ch, style);
    if (width > 1 && x + 1 < line.length) {
      line[x + 1] = createStyledCell(' ', style);
    }
    x += width;
    used += width;
  }
}

function borderLine(width: number, left: string, fill: string, right: string): Line {
  const line = makeLine(width);
  if (width <= 0) return line;
  line[0] = createStyledCell(left, { fg: PALETTE.border });
  for (let x = 1; x < width - 1; x += 1) {
    line[x] = createStyledCell(fill, { fg: PALETTE.border });
  }
  if (width > 1) line[width - 1] = createStyledCell(right, { fg: PALETTE.border });
  return line;
}

function contentLine(width: number, bg: string): Line {
  const line = makeLine(width, bg);
  if (width > 0) line[0] = createStyledCell(GLYPHS.frame.vertical, { fg: PALETTE.border });
  if (width > 1) line[width - 1] = createStyledCell(GLYPHS.frame.vertical, { fg: PALETTE.border });
  return line;
}

function drawVertical(line: Line, x: number, bg = ''): void {
  if (x <= 0 || x >= line.length - 1) return;
  line[x] = createStyledCell(GLYPHS.frame.vertical, { fg: PALETTE.border, bg });
}

function padDisplay(text: string, width: number): string {
  return fitDisplay(text, width, '');
}

function stableWindow(total: number, selected: number, visible: number): { start: number; end: number } {
  if (total <= 0 || visible <= 0) return { start: 0, end: 0 };
  const clamped = clamp(selected, 0, total - 1);
  const half = Math.floor(visible / 2);
  const maxStart = Math.max(0, total - visible);
  const start = clamp(clamped - half, 0, maxStart);
  return { start, end: Math.min(total, start + visible) };
}

function formatContext(value: number | undefined): string {
  if (!value) return '-';
  return abbreviateCount(value, { rounding: 'round', decimals: 0 });
}

function modelKey(model: ModelDefinition): string {
  return model.registryKey ?? `${model.provider}:${model.id}`;
}

function targetSummary(info: ModelPickerTargetInfo): string {
  if (!info.enabled) return 'disabled';
  // 'embeddings' has no model concept — configuredNote carries the honest
  // provider id + dimensions + configured-state summary instead of a
  // computed provider:model route (which would print a phantom "model:").
  if (info.configuredNote) return info.configuredNote;
  const route = formatRoute(info.provider, info.model);
  if (info.inherited) return `inherits ${route}`;
  return route;
}

function selectedModel(picker: ModelPickerModal): ModelDefinition | null {
  if (picker.mode !== 'model') return null;
  return picker.getSelected();
}

function formatRoute(provider: string, model: string): string {
  if (!provider && !model) return '(not set)';
  if (!provider) return model;
  if (!model) return provider;
  return model.startsWith(`${provider}:`) ? model : `${provider}:${model}`;
}

function targetLabelFor(target: string): string {
  if (target === 'helper') return 'Helper Model';
  if (target === 'tool') return 'Tool LLM';
  if (target === 'tts') return 'TTS LLM';
  if (target === 'embeddings') return 'Embeddings';
  return 'Main Chat';
}

function detailLines(picker: ModelPickerModal, width: number): string[] {
  const target = picker.getSelectedTargetInfo();
  const targetLabel = target?.label ?? targetLabelFor(picker.target);
  const targetState = target ? (target.enabled ? 'enabled' : 'disabled') : 'active';
  const selected = selectedModel(picker);
  const lines: string[] = [];
  lines.push(`Target: ${targetLabel} (${targetState})`);
  if (target) lines.push(`Current: ${targetSummary(target)}`);
  if (picker.mode === 'provider') {
    const provider = picker.getFilteredProviders()[picker.selectedIndex] ?? '';
    lines.push(`Provider selection: choose a provider, then choose a model for ${targetLabel}.`);
    if (provider) lines.push(`Selected provider: ${provider}`);
  } else if (picker.mode === 'model') {
    lines.push(`Model selection: choose the model to store for ${targetLabel}. Use filters to narrow large catalogs.`);
    if (selected) {
      const caps = selected.capabilities ?? {};
      const capText = [
        caps.reasoning ? 'reasoning' : '',
        caps.multimodal ? 'vision' : '',
        caps.toolCalling ? 'tools' : '',
        caps.codeEditing ? 'code' : '',
      ].filter(Boolean).join(', ') || 'standard';
      lines.push(`Selected: ${modelKey(selected)} | ${selected.displayName} | context ${formatContext(selected.contextWindow)} | ${capText}`);
    }
  } else if (picker.mode === 'effort') {
    lines.push(`Reasoning effort applies to the main chat model. Select the default effort for this model.`);
  } else if (picker.mode === 'embeddingProvider') {
    lines.push('Embedding provider selection: choose the provider memory search and the code index use to embed content.');
    const selectedEmbedding = picker.embeddingProviders[picker.selectedIndex];
    if (selectedEmbedding) {
      const status = selectedEmbedding.configured ? 'configured' : 'unconfigured';
      lines.push(`Selected: ${selectedEmbedding.id} | ${selectedEmbedding.dimensions} dimensions | ${status}${selectedEmbedding.detail ? ` | ${selectedEmbedding.detail}` : ''}`);
    }
  } else {
    lines.push(`Context cap overrides the detected local-model context window for this selection.`);
  }
  const filterText = `Search: ${picker.query || '(none)'} | Price: ${picker.categoryFilter} | Capability: ${picker.capabilityFilter} | Group: ${picker.groupBy} | Available only: ${picker.availableOnly ? 'yes' : 'no'}`;
  lines.push(filterText);
  return lines.flatMap((line) => wrapText(line, Math.max(1, width)));
}

function renderTargets(picker: ModelPickerModal, line: Line, startX: number, width: number, rowIndex: number): void {
  const info = picker.targetInfos[rowIndex];
  if (!info) return;
  const selected = rowIndex === picker.targetIndex;
  const bg = selected ? PALETTE.selectedBg : PALETTE.targetBg;
  fillRange(line, startX, startX + width - 1, bg);
  const marker = selected ? (picker.focusPane === 'targets' ? GLYPHS.navigation.selected : '•') : ' ';
  const state = info.enabled ? (info.inherited ? 'inherit' : 'set') : 'off';
  writeText(line, startX + 1, width - 2, `${marker} ${info.label} (${state})`, {
    fg: selected ? PALETTE.text : PALETTE.muted,
    bg,
    bold: selected,
  });
}

function renderProviderRows(picker: ModelPickerModal, lines: Line[], rows: number, startX: number, width: number): void {
  const providers = picker.getFilteredProviders();
  const { start, end } = stableWindow(providers.length, picker.selectedIndex, rows);
  const modelCounts = new Map<string, number>();
  for (const model of picker.models) modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
  for (let visibleRow = 0; visibleRow < rows; visibleRow += 1) {
    const absolute = start + visibleRow;
    const provider = providers[absolute];
    const line = lines[visibleRow]!;
    if (!provider) continue;
    const selected = absolute === picker.selectedIndex;
    const bg = selected ? PALETTE.selectedBg : PALETTE.bodyBg;
    fillRange(line, startX, startX + width - 1, bg);
    const marker = selected ? (picker.focusPane === 'items' ? GLYPHS.navigation.selected : '•') : ' ';
    const via = picker.configuredViaMap.get(provider) ?? (picker.configuredProviders.has(provider) ? 'configured' : 'not configured');
    const count = String(modelCounts.get(provider) ?? 0);
    writeText(line, startX + 1, width, padDisplay(marker, 2), { fg: PALETTE.text, bg, bold: selected });
    writeText(line, startX + 3, Math.max(0, width - 36), padDisplay(provider, Math.max(0, width - 36)), { fg: selected ? PALETTE.text : PALETTE.muted, bg, bold: selected });
    writeText(line, startX + Math.max(4, width - 31), 18, padDisplay(via, 18), { fg: picker.configuredProviders.has(provider) ? PALETTE.good : PALETTE.warn, bg });
    writeText(line, startX + Math.max(4, width - 12), 10, padDisplay(`${count} models`, 10), { fg: PALETTE.dim, bg });
  }
  if (start > 0 && lines[0]) writeText(lines[0], startX + 1, width - 2, `${GLYPHS.navigation.moreAbove} ${start} more provider(s) above`, { fg: PALETTE.dim, bg: PALETTE.bodyBg, dim: true });
  if (end < providers.length && lines[rows - 1]) writeText(lines[rows - 1]!, startX + 1, width - 2, `${GLYPHS.navigation.moreBelow} ${providers.length - end} more provider(s) below`, { fg: PALETTE.dim, bg: PALETTE.bodyBg, dim: true });
}

function renderModelRows(picker: ModelPickerModal, lines: Line[], rows: number, startX: number, width: number): void {
  const models = picker.getFilteredModels();
  const { start, end } = stableWindow(models.length, picker.selectedIndex, rows);
  const providerW = clamp(Math.floor(width * 0.14), 10, 18);
  const ctxW = 8;
  const tierW = 8;
  const capsW = 14;
  const nameW = clamp(Math.floor(width * 0.28), 16, 36);
  const keyW = Math.max(10, width - providerW - ctxW - tierW - capsW - nameW - 10);
  for (let visibleRow = 0; visibleRow < rows; visibleRow += 1) {
    const absolute = start + visibleRow;
    const model = models[absolute];
    const line = lines[visibleRow]!;
    if (!model) continue;
    const selected = absolute === picker.selectedIndex;
    const bg = selected ? PALETTE.selectedBg : PALETTE.bodyBg;
    fillRange(line, startX, startX + width - 1, bg);
    const marker = selected ? (picker.focusPane === 'items' ? GLYPHS.navigation.selected : '•') : ' ';
    const caps = model.capabilities ?? {};
    const capText = [
      caps.reasoning ? 'R' : '-',
      caps.multimodal ? 'V' : '-',
      caps.toolCalling ? 'T' : '-',
      caps.codeEditing ? 'C' : '-',
    ].join('');
    let x = startX + 1;
    writeText(line, x, 2, padDisplay(marker, 2), { fg: PALETTE.text, bg, bold: selected }); x += 2;
    writeText(line, x, keyW, padDisplay(modelKey(model), keyW), { fg: selected ? PALETTE.text : PALETTE.muted, bg, bold: selected }); x += keyW + 1;
    writeText(line, x, nameW, padDisplay(model.displayName, nameW), { fg: selected ? PALETTE.subtitle : PALETTE.text, bg }); x += nameW + 1;
    writeText(line, x, providerW, padDisplay(model.provider, providerW), { fg: PALETTE.muted, bg }); x += providerW + 1;
    writeText(line, x, ctxW, padDisplay(formatContext(model.contextWindow), ctxW), { fg: PALETTE.dim, bg }); x += ctxW + 1;
    writeText(line, x, tierW, padDisplay(model.tier ?? 'paid', tierW), { fg: model.tier === 'free' ? PALETTE.good : PALETTE.dim, bg }); x += tierW + 1;
    writeText(line, x, capsW, padDisplay(capText, capsW), { fg: PALETTE.info, bg });
  }
  if (start > 0 && lines[0]) writeText(lines[0], startX + 1, width - 2, `${GLYPHS.navigation.moreAbove} ${start} more model(s) above`, { fg: PALETTE.dim, bg: PALETTE.bodyBg, dim: true });
  if (end < models.length && lines[rows - 1]) writeText(lines[rows - 1]!, startX + 1, width - 2, `${GLYPHS.navigation.moreBelow} ${models.length - end} more model(s) below`, { fg: PALETTE.dim, bg: PALETTE.bodyBg, dim: true });
}

function renderEffortRows(picker: ModelPickerModal, lines: Line[], rows: number, startX: number, width: number): void {
  for (let row = 0; row < Math.min(rows, picker.effortLevels.length); row += 1) {
    const effort = picker.effortLevels[row]!;
    const selected = row === picker.selectedIndex;
    const bg = selected ? PALETTE.selectedBg : PALETTE.bodyBg;
    fillRange(lines[row]!, startX, startX + width - 1, bg);
    const marker = selected ? GLYPHS.navigation.selected : ' ';
    writeText(lines[row]!, startX + 1, width - 2, `${marker} ${effort}`, { fg: selected ? PALETTE.text : PALETTE.muted, bg, bold: selected });
  }
}

function renderContextCapRows(picker: ModelPickerModal, lines: Line[], rows: number, startX: number, width: number): void {
  if (rows <= 0) return;
  const model = picker.contextCapPendingModel;
  const input = picker.contextCapQuery.length > 0 ? picker.contextCapQuery : '(use detected context)';
  const copy = [
    `Model: ${model ? modelKey(model) : '(none)'}`,
    `Detected context: ${formatContext(model?.contextWindow)}`,
    `Override: ${input}`,
    'Type digits to set a cap. Enter confirms; Esc returns to the model list.',
  ];
  for (let row = 0; row < Math.min(rows, copy.length); row += 1) {
    const line = lines[row]!;
    fillRange(line, startX, startX + width - 1, PALETTE.bodyBg);
    writeText(line, startX + 1, width - 2, copy[row]!, { fg: row === 2 ? PALETTE.title : PALETTE.text, bg: PALETTE.bodyBg, bold: row === 2 });
  }
}

function renderEmbeddingProviderRows(picker: ModelPickerModal, lines: Line[], rows: number, startX: number, width: number): void {
  const providers = picker.embeddingProviders;
  const { start, end } = stableWindow(providers.length, picker.selectedIndex, rows);
  for (let visibleRow = 0; visibleRow < rows; visibleRow += 1) {
    const absolute = start + visibleRow;
    const provider = providers[absolute];
    const line = lines[visibleRow]!;
    if (!provider) continue;
    const selected = absolute === picker.selectedIndex;
    const bg = selected ? PALETTE.selectedBg : PALETTE.bodyBg;
    fillRange(line, startX, startX + width - 1, bg);
    const marker = selected ? (picker.focusPane === 'items' ? GLYPHS.navigation.selected : '•') : ' ';
    const status = provider.configured ? 'configured' : 'unconfigured';
    writeText(line, startX + 1, width, padDisplay(marker, 2), { fg: PALETTE.text, bg, bold: selected });
    writeText(line, startX + 3, Math.max(0, width - 30), padDisplay(provider.label, Math.max(0, width - 30)), { fg: selected ? PALETTE.text : PALETTE.muted, bg, bold: selected });
    writeText(line, startX + Math.max(4, width - 25), 12, padDisplay(`${provider.dimensions}d`, 12), { fg: PALETTE.dim, bg });
    writeText(line, startX + Math.max(4, width - 13), 12, padDisplay(status, 12), { fg: provider.configured ? PALETTE.good : PALETTE.warn, bg });
  }
  if (start > 0 && lines[0]) writeText(lines[0], startX + 1, width - 2, `${GLYPHS.navigation.moreAbove} ${start} more provider(s) above`, { fg: PALETTE.dim, bg: PALETTE.bodyBg, dim: true });
  if (end < providers.length && lines[rows - 1]) writeText(lines[rows - 1]!, startX + 1, width - 2, `${GLYPHS.navigation.moreBelow} ${providers.length - end} more provider(s) below`, { fg: PALETTE.dim, bg: PALETTE.bodyBg, dim: true });
}

function writeTableHeader(line: Line, picker: ModelPickerModal, startX: number, width: number): void {
  fillRange(line, startX, startX + width - 1, PALETTE.footerBg);
  const style = { fg: PALETTE.muted, bg: PALETTE.footerBg, bold: true };
  if (picker.mode === 'provider') {
    writeText(line, startX + 1, width - 2, 'Provider                         Configuration       Catalog', style);
    return;
  }
  if (picker.mode === 'effort') {
    writeText(line, startX + 1, width - 2, 'Reasoning effort                 Meaning', style);
    return;
  }
  if (picker.mode === 'contextCap') {
    writeText(line, startX + 1, width - 2, 'Context cap input', style);
    return;
  }
  if (picker.mode === 'embeddingProvider') {
    writeText(line, startX + 1, width - 2, 'Embedding provider                Dimensions   Status', style);
    return;
  }
  const providerW = clamp(Math.floor(width * 0.14), 10, 18);
  const ctxW = 8;
  const tierW = 8;
  const capsW = 14;
  const nameW = clamp(Math.floor(width * 0.28), 16, 36);
  const keyW = Math.max(10, width - providerW - ctxW - tierW - capsW - nameW - 10);
  let x = startX + 3;
  writeText(line, x, keyW, padDisplay('Model key', keyW), style); x += keyW + 1;
  writeText(line, x, nameW, padDisplay('Display name', nameW), style); x += nameW + 1;
  writeText(line, x, providerW, padDisplay('Provider', providerW), style); x += providerW + 1;
  writeText(line, x, ctxW, padDisplay('Context', ctxW), style); x += ctxW + 1;
  writeText(line, x, tierW, padDisplay('Tier', tierW), style); x += tierW + 1;
  writeText(line, x, capsW, padDisplay('Caps', capsW), style);
}

export function renderModelWorkspace(picker: ModelPickerModal, width: number, viewportHeight: number): Line[] {
  const cacheKey = getRenderCacheKey(picker, width, viewportHeight);
  const cached = renderCache.get(picker);
  if (cached?.key === cacheKey) return cached.lines;

  const safeWidth = Math.max(20, width);
  const safeHeight = Math.max(12, viewportHeight);
  const lines: Line[] = [];
  const targetW = clamp(Math.round(safeWidth * 0.18), 24, 34);
  const contentX = targetW + 1;
  const contentW = Math.max(1, safeWidth - contentX - 1);

  const top = borderLine(safeWidth, GLYPHS.frame.topLeft, GLYPHS.frame.horizontal, GLYPHS.frame.topRight);
  writeText(top, 2, safeWidth - 4, ' Model Workspace / Providers And Models ', { fg: PALETTE.title, bold: true });
  lines.push(top);

  const header = contentLine(safeWidth, PALETTE.footerBg);
  writeText(header, 2, targetW - 2, 'Targets', { fg: PALETTE.subtitle, bold: true, bg: PALETTE.footerBg });
  drawVertical(header, targetW, PALETTE.footerBg);
  const modeLabel = picker.mode === 'provider' ? 'Provider list' : picker.mode === 'model' ? 'Model list' : picker.mode === 'effort' ? 'Reasoning effort' : picker.mode === 'embeddingProvider' ? 'Embedding providers' : 'Context cap';
  writeText(header, contentX + 1, contentW - 2, `${modeLabel}  •  ${picker.getItemCount()} item(s)`, { fg: PALETTE.subtitle, bold: true, bg: PALETTE.footerBg });
  lines.push(header);

  const sep = borderLine(safeWidth, GLYPHS.frame.teeLeft, GLYPHS.frame.horizontal, GLYPHS.frame.teeRight);
  if (targetW > 0 && targetW < safeWidth - 1) sep[targetW] = createStyledCell(GLYPHS.frame.cross, { fg: PALETTE.border });
  lines.push(sep);

  const footerRows = 2;
  const bodyRows = safeHeight - 3 - footerRows;
  const maxDetailRows = Math.max(3, bodyRows - 2);
  const minDetailRows = Math.min(6, maxDetailRows);
  const detailRows = clamp(Math.round(bodyRows * 0.32), minDetailRows, maxDetailRows);
  const listRows = Math.max(1, bodyRows - detailRows - 1);
  const details = detailLines(picker, contentW - 2).slice(0, detailRows);

  for (let row = 0; row < bodyRows; row += 1) {
    const inDetail = row < detailRows;
    const line = contentLine(safeWidth, inDetail ? PALETTE.detailBg : PALETTE.bodyBg);
    fillRange(line, 1, targetW - 1, PALETTE.targetBg);
    drawVertical(line, targetW, inDetail ? PALETTE.detailBg : PALETTE.bodyBg);
    renderTargets(picker, line, 1, targetW - 1, row);
    if (inDetail) {
      const text = details[row] ?? '';
      const fg = row === 0 ? PALETTE.title : row <= 2 ? PALETTE.text : PALETTE.muted;
      writeText(line, contentX + 1, contentW - 2, text, { fg, bg: PALETTE.detailBg, bold: row === 0 });
    }
    lines.push(line);
  }

  const listStart = 3 + detailRows + 1;
  if (listStart - 1 < lines.length) {
    const divider = lines[listStart - 1]!;
    writeTableHeader(divider, picker, contentX, contentW - 1);
  }

  const listLines = lines.slice(listStart, listStart + listRows);
  if (picker.mode === 'provider') {
    renderProviderRows(picker, listLines, listLines.length, contentX, contentW - 1);
  } else if (picker.mode === 'model') {
    renderModelRows(picker, listLines, listLines.length, contentX, contentW - 1);
  } else if (picker.mode === 'contextCap') {
    renderContextCapRows(picker, listLines, listLines.length, contentX, contentW - 1);
  } else if (picker.mode === 'embeddingProvider') {
    renderEmbeddingProviderRows(picker, listLines, listLines.length, contentX, contentW - 1);
  } else {
    renderEffortRows(picker, listLines, listLines.length, contentX, contentW - 1);
  }

  const footer = contentLine(safeWidth, PALETTE.footerBg);
  const targetHint = picker.focusPane === 'targets' ? 'Focus targets' : 'Focus list';
  const searchHint = picker.searchFocused ? 'Typing filters search; Esc clears search' : '/ search';
  const hints = `${targetHint} • Up/Down navigate • Left/Right pane • Enter select • ${searchHint} • Tab price • C caps • A available • B benchmark • G group • Esc close`;
  writeText(footer, 2, safeWidth - 4, hints, { fg: PALETTE.muted, bg: PALETTE.footerBg });
  lines.push(footer);
  lines.push(borderLine(safeWidth, GLYPHS.frame.bottomLeft, GLYPHS.frame.horizontal, GLYPHS.frame.bottomRight));

  while (lines.length < safeHeight) lines.push(makeLine(safeWidth));
  const result = lines.slice(0, safeHeight);
  renderCache.set(picker, { key: cacheKey, lines: result });
  return result;
}

function getRenderCacheKey(picker: ModelPickerModal, width: number, viewportHeight: number): string {
  const base: Array<string | number> = [
    width,
    viewportHeight,
    picker.mode,
    picker.target,
    picker.focusPane,
    picker.targetIndex,
    picker.query,
    picker.searchFocused ? 1 : 0,
    picker.selectedIndex,
    picker.scrollOffset,
    picker.categoryFilter,
    picker.capabilityFilter,
    picker.availableOnly ? 1 : 0,
    picker.benchmarkSort,
    picker.groupBy,
    keyForSet(picker.pinnedIds),
    keyForSet(picker.configuredProviders),
    keyForMap(picker.configuredViaMap),
    keyForTargets(picker.targetInfos),
  ];

  if (picker.mode === 'model') {
    const filtered = picker.getFilteredModels();
    const selected = filtered[picker.selectedIndex];
    base.push(objectId(picker.models), objectId(filtered), filtered.length, selected?.registryKey ?? selected?.id ?? '');
  } else if (picker.mode === 'provider') {
    const filteredProviders = picker.getFilteredProviders();
    base.push(objectId(picker.providers), objectId(filteredProviders), filteredProviders.length);
  } else if (picker.mode === 'effort') {
    base.push(objectId(picker.effortLevels), picker.effortLevels.join('\u001f'), picker.pendingModel?.registryKey ?? picker.pendingModel?.id ?? '');
  } else if (picker.mode === 'contextCap') {
    base.push(picker.contextCapQuery, picker.contextCapPendingModel?.registryKey ?? picker.contextCapPendingModel?.id ?? '');
  } else if (picker.mode === 'embeddingProvider') {
    base.push(objectId(picker.embeddingProviders), picker.embeddingProviders.length);
  }

  return base.join('\u001e');
}

function objectId(value: object): number {
  const existing = objectIds.get(value);
  if (existing !== undefined) return existing;
  const next = nextObjectId++;
  objectIds.set(value, next);
  return next;
}

function keyForSet(values: ReadonlySet<string>): string {
  return values.size === 0 ? '' : [...values].sort().join('\u001f');
}

function keyForMap(values: ReadonlyMap<string, string | undefined>): string {
  if (values.size === 0) return '';
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\u001d${value ?? ''}`)
    .join('\u001f');
}

function keyForTargets(values: readonly ModelPickerTargetInfo[]): string {
  return values
    .map((entry) => [
      entry.target,
      entry.label,
      entry.description,
      entry.provider,
      entry.model,
      entry.enabled ? 1 : 0,
      entry.inherited ? 1 : 0,
      entry.configuredNote ?? '',
    ].join('\u001d'))
    .join('\u001f');
}
