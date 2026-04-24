import type { Line } from '../../types/grid.ts';
import { createStyledCell } from '../../types/grid.ts';
import { fitDisplay, getDisplayWidth, truncateDisplay, wrapText } from '../../utils/terminal-width.ts';
import {
  createOverlayBoxLayout,
  createOverlayContentLine,
  createOverlayFilledBorderLine,
  DEFAULT_OVERLAY_PALETTE,
  OVERLAY_GLYPHS,
  putOverlayText,
} from '../overlay-box.ts';
import { UI_TONES } from '../ui-primitives.ts';
import {
  getOnboardingWizardBodyRows,
  getOnboardingWizardVisibleFieldCount,
  type OnboardingWizardController,
  type OnboardingWizardFieldDefinition,
  type OnboardingWizardStepDefinition,
} from '../../input/onboarding/onboarding-wizard.ts';

type RenderedFieldRow =
  | { readonly kind: 'empty' }
  | { readonly kind: 'moreAbove'; readonly text: string }
  | { readonly kind: 'moreBelow'; readonly text: string }
  | {
      readonly kind: 'field';
      readonly field: OnboardingWizardFieldDefinition;
      readonly absoluteIndex: number;
      readonly line: 0 | 1;
    };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fillRange(line: Line, startX: number, width: number, bg: string): void {
  for (let x = startX; x < Math.min(line.length, startX + width); x += 1) {
    const cell = line[x];
    if (!cell) continue;
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

function drawVerticalRule(line: Line, x: number, fg: string, bg = ''): void {
  if (x < 0 || x >= line.length) return;
  line[x] = createStyledCell('│', { fg, bg });
}

function modeLabel(mode: OnboardingWizardController['mode']): string {
  if (mode === 'edit') return 'Edit existing';
  if (mode === 'reopen') return 'Reopen review';
  return 'New setup';
}

function stepGlyph(
  wizard: OnboardingWizardController,
  step: OnboardingWizardStepDefinition,
  stepIndex: number,
): { readonly glyph: string; readonly fg: string } {
  if (stepIndex === wizard.stepIndex) {
    return { glyph: OVERLAY_GLYPHS.selected, fg: UI_TONES.state.active };
  }

  const total = wizard.getStepFieldCount(stepIndex);
  const completed = wizard.getCompletedFieldCount(stepIndex);
  if (wizard.isStepDirty(stepIndex)) {
    return { glyph: '◈', fg: UI_TONES.state.warn };
  }
  if (total > 0 && completed === total) {
    return { glyph: '✓', fg: UI_TONES.state.good };
  }
  return { glyph: '•', fg: UI_TONES.fg.muted };
}

function fieldBadgeTone(
  wizard: OnboardingWizardController,
  field: OnboardingWizardFieldDefinition,
): string {
  if (field.kind === 'status') return UI_TONES.state.info;
  if (field.kind === 'modelPicker') return UI_TONES.state.info;
  if (field.kind === 'acknowledgement') {
    const label = wizard.getFieldValueLabel(field);
    return label === 'Accepted' ? UI_TONES.state.good : label === 'Pending' ? UI_TONES.state.warn : UI_TONES.fg.muted;
  }
  if (field.kind === 'checklist') {
    return wizard.getFieldValue(field) ? UI_TONES.state.good : UI_TONES.fg.muted;
  }
  if (field.kind === 'radio') return UI_TONES.state.active;
  if (field.kind === 'masked') return UI_TONES.state.warn;
  return UI_TONES.fg.secondary;
}

function buildFieldRows(
  wizard: OnboardingWizardController,
  visibleFields: number,
  capacity: number,
): readonly RenderedFieldRow[] {
  const fieldWindow = wizard.getFieldWindow(visibleFields);
  const rows: RenderedFieldRow[] = [];

  if (fieldWindow.start > 0) {
    rows.push({
      kind: 'moreAbove',
      text: `${OVERLAY_GLYPHS.moreAbove} ${fieldWindow.start} more above`,
    });
  }

  fieldWindow.fields.forEach((field, index) => {
    const absoluteIndex = fieldWindow.start + index;
    rows.push({ kind: 'field', field, absoluteIndex, line: 0 });
    rows.push({ kind: 'field', field, absoluteIndex, line: 1 });
  });

  if (fieldWindow.end < fieldWindow.total) {
    rows.push({
      kind: 'moreBelow',
      text: `${OVERLAY_GLYPHS.moreBelow} ${fieldWindow.total - fieldWindow.end} more below`,
    });
  }

  while (rows.length < capacity) rows.push({ kind: 'empty' });
  return rows.slice(0, capacity);
}

function fieldHint(
  wizard: OnboardingWizardController,
  field: OnboardingWizardFieldDefinition,
  selected: boolean,
): string {
  if (
    selected
    && wizard.isEditingTextField()
    && wizard.editingFieldId === field.id
    && (field.kind === 'text' || field.kind === 'masked')
  ) {
    const rawValue = wizard.editBuffer.length > 0 ? wizard.editBuffer : field.placeholder;
    const editingValue = field.kind === 'masked' && wizard.editBuffer.length > 0
      ? '•'.repeat(Math.min(12, Math.max(4, wizard.editBuffer.length)))
      : rawValue;
    return `Editing: ${editingValue}█`;
  }

  if (selected && field.kind === 'modelPicker') return `${field.hint} Press Enter to open picker.`;
  if (selected && field.kind === 'text') return `${field.hint} Press Enter to edit inline.`;
  if (selected && field.kind === 'masked') return `${field.hint} Press Enter to edit inline.`;
  return field.hint;
}

function renderFieldRow(
  line: Line,
  wizard: OnboardingWizardController,
  fieldRow: RenderedFieldRow,
  startX: number,
  width: number,
): void {
  if (fieldRow.kind === 'empty') return;

  if (fieldRow.kind === 'moreAbove' || fieldRow.kind === 'moreBelow') {
    putOverlayText(line, startX + 1, width - 2, truncateDisplay(fieldRow.text, width - 2), {
      fg: UI_TONES.fg.muted,
      bg: UI_TONES.bg.base,
      dim: true,
    });
    return;
  }

  const selected = fieldRow.absoluteIndex === wizard.getSelectedFieldIndex();
  const field = fieldRow.field;
  const fieldBg = selected ? DEFAULT_OVERLAY_PALETTE.selectedBg : UI_TONES.bg.base;
  fillRange(line, startX, width, fieldBg);

  if (fieldRow.line === 0) {
    const badge = truncateDisplay(`[${wizard.getFieldValueLabel(field)}]`, Math.max(8, Math.floor(width * 0.38)));
    const badgeWidth = getDisplayWidth(badge);
    const prefix = selected ? `${OVERLAY_GLYPHS.selected} ` : wizard.isFieldDirty(field.id) ? '◇ ' : '  ';
    const labelWidth = Math.max(0, width - badgeWidth - 4);

    putOverlayText(line, startX + 1, labelWidth, truncateDisplay(`${prefix}${field.label}`, labelWidth), {
      fg: UI_TONES.fg.primary,
      bg: fieldBg,
      bold: selected,
    });
    putOverlayText(line, startX + width - badgeWidth - 1, badgeWidth, badge, {
      fg: fieldBadgeTone(wizard, field),
      bg: fieldBg,
      bold: selected,
    });
    return;
  }

  putOverlayText(line, startX + 3, Math.max(0, width - 4), truncateDisplay(fieldHint(wizard, field, selected), Math.max(0, width - 4)), {
    fg: selected ? UI_TONES.fg.secondary : UI_TONES.fg.muted,
    bg: fieldBg,
    dim: !selected,
  });
}

function footerText(wizard: OnboardingWizardController): string {
  if (wizard.isEditingTextField()) {
    return '[Enter] Save  [Esc] Cancel  [Backspace] Delete  [Type] Edit value';
  }

  return '[Tab/Shift+Tab] Step  [↑↓/j/k] Move  [Enter/Space] Toggle/Open  [1-9] Jump  [Esc] Close';
}

function renderWideLayout(
  wizard: OnboardingWizardController,
  width: number,
  viewportHeight: number,
  layout: ReturnType<typeof createOverlayBoxLayout>,
): Line[] {
  const lines: Line[] = [];
  const bodyRows = getOnboardingWizardBodyRows(viewportHeight);
  const visibleFields = getOnboardingWizardVisibleFieldCount(viewportHeight);
  const currentStep = wizard.currentStep;
  const borderFg = DEFAULT_OVERLAY_PALETTE.borderFg;
  const headerBg = UI_TONES.bg.title;
  const railBg = UI_TONES.bg.section;
  const bodyBg = UI_TONES.bg.base;
  const summaryBg = UI_TONES.bg.summary;
  const innerLeft = layout.margin + 1;
  const availableInner = layout.innerWidth - 2;
  const leftWidthBase = layout.innerWidth >= 108 ? 22 : 18;
  const rightWidthBase = layout.innerWidth >= 108 ? 30 : 24;
  const minCenterWidth = 34;
  let leftWidth = Math.min(leftWidthBase, Math.max(16, availableInner - minCenterWidth - 12));
  let rightWidth = Math.min(rightWidthBase, Math.max(20, availableInner - minCenterWidth - leftWidth));
  let centerWidth = layout.innerWidth - leftWidth - rightWidth - 2;

  if (centerWidth < minCenterWidth) {
    const deficit = minCenterWidth - centerWidth;
    const leftCut = Math.min(Math.max(0, leftWidth - 16), Math.ceil(deficit / 2));
    leftWidth -= leftCut;
    rightWidth -= Math.min(Math.max(0, rightWidth - 20), deficit - leftCut);
    centerWidth = layout.innerWidth - leftWidth - rightWidth - 2;
  }

  const leftStart = innerLeft;
  const leftSeparatorX = leftStart + leftWidth;
  const centerStart = leftSeparatorX + 1;
  const rightSeparatorX = centerStart + centerWidth;
  const rightStart = rightSeparatorX + 1;
  const descriptionLines = wrapText(currentStep.description, Math.max(18, centerWidth - 2)).slice(0, 2);
  const summaryLines = [
    currentStep.summaryTitle,
    ...currentStep.summaryLines,
    `Fields ${wizard.getCompletedFieldCount(wizard.stepIndex)}/${wizard.getStepFieldCount(wizard.stepIndex)} complete`,
    `Dirty steps ${wizard.dirtyStepCount}`,
    `Pending picker ${wizard.pendingModelPickerTarget ?? 'none'}`,
  ];
  const fieldRows = buildFieldRows(wizard, visibleFields, Math.max(0, bodyRows - 3));

  const topLine = createOverlayFilledBorderLine(
    width,
    layout,
    OVERLAY_GLYPHS.topLeft,
    OVERLAY_GLYPHS.horizontal,
    OVERLAY_GLYPHS.topRight,
    borderFg,
    headerBg,
  );
  putOverlayText(topLine, layout.margin + 2, layout.width - 4, 'Onboarding Wizard', {
    fg: UI_TONES.fg.primary,
    bg: headerBg,
    bold: true,
  });
  const meta = `${modeLabel(wizard.mode)}  ${wizard.stepIndex + 1}/${wizard.steps.length}  dirty ${wizard.dirtyStepCount}`;
  putOverlayText(topLine, Math.max(layout.margin + 2, layout.margin + layout.width - getDisplayWidth(meta) - 3), layout.width - 4, meta, {
    fg: UI_TONES.fg.secondary,
    bg: headerBg,
  });
  lines.push(topLine);

  const headerLine = createOverlayContentLine(width, layout, borderFg, headerBg);
  fillRange(headerLine, leftStart, leftWidth, railBg);
  fillRange(headerLine, centerStart, centerWidth, headerBg);
  fillRange(headerLine, rightStart, rightWidth, summaryBg);
  drawVerticalRule(headerLine, leftSeparatorX, borderFg, headerBg);
  drawVerticalRule(headerLine, rightSeparatorX, borderFg, headerBg);
  putOverlayText(headerLine, leftStart + 1, leftWidth - 2, 'Steps', {
    fg: UI_TONES.fg.secondary,
    bg: railBg,
    bold: true,
  });
  putOverlayText(headerLine, centerStart + 1, centerWidth - 2, truncateDisplay(currentStep.title, centerWidth - 2), {
    fg: UI_TONES.state.active,
    bg: headerBg,
    bold: true,
  });
  putOverlayText(headerLine, rightStart + 1, rightWidth - 2, 'Summary Rail', {
    fg: UI_TONES.fg.secondary,
    bg: summaryBg,
    bold: true,
  });
  lines.push(headerLine);

  lines.push(createOverlayFilledBorderLine(
    width,
    layout,
    OVERLAY_GLYPHS.teeLeft,
    OVERLAY_GLYPHS.horizontal,
    OVERLAY_GLYPHS.teeRight,
    borderFg,
    bodyBg,
  ));

  for (let row = 0; row < bodyRows; row += 1) {
    const line = createOverlayContentLine(width, layout, borderFg, bodyBg);
    fillRange(line, leftStart, leftWidth, railBg);
    fillRange(line, centerStart, centerWidth, bodyBg);
    fillRange(line, rightStart, rightWidth, summaryBg);
    drawVerticalRule(line, leftSeparatorX, borderFg);
    drawVerticalRule(line, rightSeparatorX, borderFg);

    if (row === 0) {
      putOverlayText(line, centerStart + 1, centerWidth - 2, truncateDisplay(currentStep.title, centerWidth - 2), {
        fg: UI_TONES.fg.primary,
        bg: bodyBg,
        bold: true,
      });
    } else if (row === 1) {
      putOverlayText(line, centerStart + 1, centerWidth - 2, descriptionLines[0] ?? '', {
        fg: UI_TONES.fg.secondary,
        bg: bodyBg,
      });
    } else if (row === 2) {
      const status = fitDisplay(
        `Fields ${wizard.getCompletedFieldCount(wizard.stepIndex)}/${wizard.getStepFieldCount(wizard.stepIndex)} complete • ${modeLabel(wizard.mode)}`,
        centerWidth - 2,
      );
      putOverlayText(line, centerStart + 1, centerWidth - 2, descriptionLines[1] ?? status, {
        fg: UI_TONES.fg.secondary,
        bg: bodyBg,
      });
    } else {
      renderFieldRow(line, wizard, fieldRows[row - 3] ?? { kind: 'empty' }, centerStart, centerWidth);
    }

    const step = wizard.steps[row] ?? null;
    if (step) {
      const stepState = stepGlyph(wizard, step, row);
      const completion = `${wizard.getCompletedFieldCount(row)}/${wizard.getStepFieldCount(row)}`;
      putOverlayText(line, leftStart + 1, leftWidth - 2, truncateDisplay(`${stepState.glyph} ${row + 1}. ${step.shortLabel}`, leftWidth - 2), {
        fg: stepState.fg,
        bg: railBg,
        bold: row === wizard.stepIndex,
      });
      putOverlayText(line, Math.max(leftStart + 1, leftStart + leftWidth - getDisplayWidth(completion) - 2), leftWidth - 2, completion, {
        fg: wizard.isStepDirty(row) ? UI_TONES.state.warn : UI_TONES.fg.muted,
        bg: railBg,
      });
    }

    const summaryText = summaryLines[row];
    if (summaryText) {
      putOverlayText(line, rightStart + 1, rightWidth - 2, truncateDisplay(summaryText, rightWidth - 2), {
        fg: row === 0 ? UI_TONES.state.info : UI_TONES.fg.secondary,
        bg: summaryBg,
        bold: row === 0,
        dim: row > 0,
      });
    }

    lines.push(line);
  }

  lines.push(createOverlayFilledBorderLine(
    width,
    layout,
    OVERLAY_GLYPHS.teeLeft,
    OVERLAY_GLYPHS.horizontal,
    OVERLAY_GLYPHS.teeRight,
    borderFg,
    bodyBg,
  ));

  const footer = createOverlayFilledBorderLine(
    width,
    layout,
    OVERLAY_GLYPHS.bottomLeft,
    OVERLAY_GLYPHS.horizontal,
    OVERLAY_GLYPHS.bottomRight,
    borderFg,
    headerBg,
  );
  putOverlayText(footer, layout.margin + 2, layout.width - 4, truncateDisplay(footerText(wizard), layout.width - 4), {
    fg: UI_TONES.fg.muted,
    bg: headerBg,
    dim: true,
  });
  lines.push(footer);

  return lines.slice(0, viewportHeight);
}

function renderCollapsedLayout(
  wizard: OnboardingWizardController,
  width: number,
  viewportHeight: number,
  layout: ReturnType<typeof createOverlayBoxLayout>,
): Line[] {
  const lines: Line[] = [];
  const bodyRows = getOnboardingWizardBodyRows(viewportHeight);
  const visibleFields = getOnboardingWizardVisibleFieldCount(viewportHeight);
  const currentStep = wizard.currentStep;
  const borderFg = DEFAULT_OVERLAY_PALETTE.borderFg;
  const headerBg = UI_TONES.bg.title;
  const bodyBg = UI_TONES.bg.base;
  const innerStart = layout.margin + 1;
  const innerWidth = layout.innerWidth;
  const descriptionLines = wrapText(currentStep.description, Math.max(14, innerWidth - 2)).slice(0, 2);
  const fieldRows = buildFieldRows(wizard, visibleFields, Math.max(0, bodyRows - 3));

  const topLine = createOverlayFilledBorderLine(
    width,
    layout,
    OVERLAY_GLYPHS.topLeft,
    OVERLAY_GLYPHS.horizontal,
    OVERLAY_GLYPHS.topRight,
    borderFg,
    headerBg,
  );
  putOverlayText(topLine, layout.margin + 2, layout.width - 4, 'Onboarding Wizard', {
    fg: UI_TONES.fg.primary,
    bg: headerBg,
    bold: true,
  });
  const meta = `${wizard.stepIndex + 1}/${wizard.steps.length} • dirty ${wizard.dirtyStepCount}`;
  putOverlayText(topLine, Math.max(layout.margin + 2, layout.margin + layout.width - getDisplayWidth(meta) - 3), layout.width - 4, meta, {
    fg: UI_TONES.fg.secondary,
    bg: headerBg,
  });
  lines.push(topLine);

  const headerLine = createOverlayContentLine(width, layout, borderFg, headerBg);
  fillRange(headerLine, innerStart, innerWidth, headerBg);
  putOverlayText(headerLine, innerStart + 1, innerWidth - 2, fitDisplay(`${modeLabel(wizard.mode)} • ${currentStep.shortLabel}`, innerWidth - 2), {
    fg: UI_TONES.state.active,
    bg: headerBg,
    bold: true,
  });
  lines.push(headerLine);

  lines.push(createOverlayFilledBorderLine(
    width,
    layout,
    OVERLAY_GLYPHS.teeLeft,
    OVERLAY_GLYPHS.horizontal,
    OVERLAY_GLYPHS.teeRight,
    borderFg,
    bodyBg,
  ));

  for (let row = 0; row < bodyRows; row += 1) {
    const line = createOverlayContentLine(width, layout, borderFg, bodyBg);
    fillRange(line, innerStart, innerWidth, bodyBg);

    if (row === 0) {
      putOverlayText(line, innerStart + 1, innerWidth - 2, truncateDisplay(currentStep.title, innerWidth - 2), {
        fg: UI_TONES.fg.primary,
        bg: bodyBg,
        bold: true,
      });
    } else if (row === 1) {
      putOverlayText(line, innerStart + 1, innerWidth - 2, descriptionLines[0] ?? '', {
        fg: UI_TONES.fg.secondary,
        bg: bodyBg,
      });
    } else if (row === 2) {
      const compactMeta = fitDisplay(
        `${currentStep.summaryTitle} • ${wizard.getCompletedFieldCount(wizard.stepIndex)}/${wizard.getStepFieldCount(wizard.stepIndex)} complete`,
        innerWidth - 2,
      );
      putOverlayText(line, innerStart + 1, innerWidth - 2, descriptionLines[1] ?? compactMeta, {
        fg: UI_TONES.fg.secondary,
        bg: bodyBg,
      });
    } else {
      renderFieldRow(line, wizard, fieldRows[row - 3] ?? { kind: 'empty' }, innerStart, innerWidth);
    }

    lines.push(line);
  }

  lines.push(createOverlayFilledBorderLine(
    width,
    layout,
    OVERLAY_GLYPHS.teeLeft,
    OVERLAY_GLYPHS.horizontal,
    OVERLAY_GLYPHS.teeRight,
    borderFg,
    bodyBg,
  ));

  const footer = createOverlayFilledBorderLine(
    width,
    layout,
    OVERLAY_GLYPHS.bottomLeft,
    OVERLAY_GLYPHS.horizontal,
    OVERLAY_GLYPHS.bottomRight,
    borderFg,
    headerBg,
  );
  putOverlayText(footer, layout.margin + 2, layout.width - 4, truncateDisplay(footerText(wizard), layout.width - 4), {
    fg: UI_TONES.fg.muted,
    bg: headerBg,
    dim: true,
  });
  lines.push(footer);

  return lines.slice(0, viewportHeight);
}

export function renderOnboardingWizard(
  wizard: OnboardingWizardController,
  width: number,
  viewportHeight: number,
): Line[] {
  const layout = createOverlayBoxLayout(width, 0, width);
  const collapsed = layout.innerWidth < 86;
  return collapsed
    ? renderCollapsedLayout(wizard, width, viewportHeight, layout)
    : renderWideLayout(wizard, width, viewportHeight, layout);
}
