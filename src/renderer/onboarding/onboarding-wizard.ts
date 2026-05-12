import type { Line } from '../../types/grid.ts';
import { fitDisplay, getDisplayWidth, truncateDisplay, wrapText } from '../../utils/terminal-width.ts';
import {
  createOverlayBoxLayout,
  createOverlayContentLine,
  createOverlayFilledBorderLine,
  DEFAULT_OVERLAY_PALETTE,
  OVERLAY_GLYPHS,
  putOverlayText,
} from '../overlay-box.ts';
import { clamp, drawVerticalRule, fillWidth } from '../fullscreen-primitives.ts';
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
    };

function modeLabel(mode: OnboardingWizardController['mode']): string {
  if (mode === 'edit') return 'Edit existing';
  if (mode === 'reopen') return 'Reopen review';
  return 'New setup';
}

function changedScreensLabel(wizard: OnboardingWizardController): string {
  if (wizard.dirtyStepCount === 0) return 'no changes';
  if (wizard.dirtyStepCount === 1) return '1 changed screen';
  return `${wizard.dirtyStepCount} changed screens`;
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
  if (field.kind === 'text' || field.kind === 'masked') {
    const missingRequired = wizard.getFieldValueLabel(field) === 'Missing';
    if (missingRequired) return UI_TONES.state.warn;
    if (field.kind === 'masked') return UI_TONES.state.warn;
  }
  return UI_TONES.fg.secondary;
}

function buildFieldRows(
  wizard: OnboardingWizardController,
  visibleFields: number,
  capacity: number,
): readonly RenderedFieldRow[] {
  wizard.ensureSelectionVisible(visibleFields);
  const fields = wizard.currentStep.fields;
  const rows: RenderedFieldRow[] = [];
  if (fields.length === 0 || capacity <= 0) return rows;

  const allRows: RenderedFieldRow[] = [];
  fields.forEach((field, absoluteIndex) => {
    const spacerRows = Math.max(0, field.spacerBeforeRows ?? 0);
    for (let index = 0; index < spacerRows; index += 1) {
      allRows.push({ kind: 'empty' });
    }
    allRows.push({ kind: 'field', field, absoluteIndex });
  });

  const selectedFieldIndex = wizard.getSelectedFieldIndex();
  const selectedRowIndex = Math.max(0, allRows.findIndex((row) => row.kind === 'field' && row.absoluteIndex === selectedFieldIndex));
  const scrollFieldIndex = wizard.scrollOffsets[wizard.stepIndex] ?? 0;
  const scrollRowIndex = allRows.findIndex((row) => row.kind === 'field' && row.absoluteIndex === scrollFieldIndex);
  const maxStart = Math.max(0, allRows.length - capacity);
  let start = clamp(scrollRowIndex >= 0 ? scrollRowIndex : 0, 0, maxStart);

  if (selectedRowIndex < start) start = selectedRowIndex;
  if (selectedRowIndex >= start + capacity) start = selectedRowIndex - capacity + 1;
  start = clamp(start, 0, maxStart);

  if (start > 0 && selectedRowIndex === start) start = Math.max(0, start - 1);
  if (start + capacity < allRows.length && selectedRowIndex === start + capacity - 1) {
    start = Math.min(maxStart, start + 1);
  }

  rows.push(...allRows.slice(start, start + capacity));
  if (start > 0 && rows.length > 0) {
    rows[0] = {
      kind: 'moreAbove',
      text: `${OVERLAY_GLYPHS.moreAbove} ${start} more above`,
    };
  }

  const hiddenBelow = Math.max(0, allRows.length - (start + capacity));
  if (hiddenBelow > 0 && rows.length > 0) {
    rows[rows.length - 1] = {
      kind: 'moreBelow',
      text: `${OVERLAY_GLYPHS.moreBelow} ${hiddenBelow} more below`,
    };
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

function fieldRowPrefix(
  wizard: OnboardingWizardController,
  field: OnboardingWizardFieldDefinition,
  selected: boolean,
): string {
  if (selected) return `${OVERLAY_GLYPHS.selected} `;
  if (wizard.isFieldDirty(field.id)) return '◇ ';
  if (field.kind === 'checklist') return (wizard.getFieldValue(field) as boolean) ? '✓ ' : '□ ';
  if (field.kind === 'acknowledgement') return (wizard.getFieldValue(field) as boolean) ? '✓ ' : '□ ';
  if (field.kind === 'action') return '▶ ';
  if (field.kind === 'radio') return '◉ ';
  return '  ';
}

function selectedFieldText(wizard: OnboardingWizardController): {
  readonly title: string;
  readonly hint: string;
} {
  if (wizard.isEditingTextField() && wizard.editingFieldId !== null) {
    const editingField = wizard.getFieldById(wizard.editingFieldId);
    if (editingField) {
      return {
        title: `Editing: ${editingField.label}`,
        hint: fieldHint(wizard, editingField, true),
      };
    }
  }

  const field = wizard.getSelectedField();
  if (!field) {
    return {
      title: 'Selected: none',
      hint: 'No selectable row is active on this screen.',
    };
  }

  return {
    title: `Selected: ${field.label} [${wizard.getFieldValueLabel(field)}]`,
    hint: fieldHint(wizard, field, true),
  };
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
  fillWidth(line, startX, width, fieldBg);

  const badge = truncateDisplay(`[${wizard.getFieldValueLabel(field)}]`, Math.max(8, Math.floor(width * 0.34)));
  const badgeWidth = getDisplayWidth(badge);
  const labelWidth = Math.max(0, width - badgeWidth - 4);
  const prefix = fieldRowPrefix(wizard, field, selected);

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
}

function footerText(wizard: OnboardingWizardController): string {
  if (wizard.isEditingTextField()) {
    return '[Enter] Save value  [Esc] Cancel edit  [Backspace] Delete char  [Del/Ctrl+U] Clear value';
  }

  return '[Enter] Toggle/open  [Esc] Close  [Tab/Shift+Tab] Screen  [↑↓] Move  [Del/Ctrl+U] Clear input';
}

function controlsText(wizard: OnboardingWizardController): string {
  if (wizard.isEditingTextField()) {
    return 'Controls: Enter saves this value, Esc cancels editing, Backspace deletes one character, Delete or Ctrl+U clears the field.';
  }
  return 'Controls: Enter or Space changes the selected row; Delete or Ctrl+U clears selected text inputs; Tab/Shift+Tab changes screens; arrows move.';
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
  const leftWidthBase = layout.innerWidth >= 150 ? 32 : layout.innerWidth >= 108 ? 28 : 24;
  const rightWidthBase = layout.innerWidth >= 150 ? 34 : layout.innerWidth >= 108 ? 32 : 24;
  const minCenterWidth = layout.innerWidth >= 120 ? 48 : 40;
  let leftWidth = Math.min(leftWidthBase, Math.max(20, availableInner - minCenterWidth - 12));
  let rightWidth = Math.min(rightWidthBase, Math.max(22, availableInner - minCenterWidth - leftWidth));
  let centerWidth = layout.innerWidth - leftWidth - rightWidth - 2;

  if (centerWidth < minCenterWidth) {
    const deficit = minCenterWidth - centerWidth;
    const leftCut = Math.min(Math.max(0, leftWidth - 20), Math.ceil(deficit / 2));
    leftWidth -= leftCut;
    rightWidth -= Math.min(Math.max(0, rightWidth - 22), deficit - leftCut);
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
    ...currentStep.summaryLines.slice(0, 2),
    `Fields ${wizard.getCompletedFieldCount(wizard.stepIndex)}/${wizard.getStepFieldCount(wizard.stepIndex)} complete`,
    changedScreensLabel(wizard),
  ];
  const fieldStartRow = 6;
  const selectedText = selectedFieldText(wizard);
  const fieldRows = buildFieldRows(wizard, visibleFields, Math.max(0, bodyRows - fieldStartRow));

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
  const meta = `${modeLabel(wizard.mode)}  ${wizard.stepIndex + 1}/${wizard.steps.length}  ${changedScreensLabel(wizard)}`;
  putOverlayText(topLine, Math.max(layout.margin + 2, layout.margin + layout.width - getDisplayWidth(meta) - 3), layout.width - 4, meta, {
    fg: UI_TONES.fg.secondary,
    bg: headerBg,
  });
  lines.push(topLine);

  const headerLine = createOverlayContentLine(width, layout, borderFg, headerBg);
  fillWidth(headerLine, leftStart, leftWidth, railBg);
  fillWidth(headerLine, centerStart, centerWidth, headerBg);
  fillWidth(headerLine, rightStart, rightWidth, summaryBg);
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
  putOverlayText(headerLine, rightStart + 1, rightWidth - 2, 'Summary', {
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
    fillWidth(line, leftStart, leftWidth, railBg);
    fillWidth(line, centerStart, centerWidth, bodyBg);
    fillWidth(line, rightStart, rightWidth, summaryBg);
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
      putOverlayText(line, centerStart + 1, centerWidth - 2, descriptionLines[1] ?? '', {
        fg: UI_TONES.fg.secondary,
        bg: bodyBg,
      });
    } else if (row === 3) {
      fillWidth(line, centerStart, centerWidth, railBg);
      putOverlayText(line, centerStart + 1, centerWidth - 2, truncateDisplay(controlsText(wizard), centerWidth - 2), {
        fg: UI_TONES.state.info,
        bg: railBg,
      });
    } else if (row === 4) {
      fillWidth(line, centerStart, centerWidth, DEFAULT_OVERLAY_PALETTE.selectedBg);
      putOverlayText(line, centerStart + 1, centerWidth - 2, truncateDisplay(`Focus: ${selectedText.title.replace(/^Selected: /, '')}`, centerWidth - 2), {
        fg: UI_TONES.fg.primary,
        bg: DEFAULT_OVERLAY_PALETTE.selectedBg,
        bold: true,
      });
    } else if (row === 5) {
      fillWidth(line, centerStart, centerWidth, DEFAULT_OVERLAY_PALETTE.selectedBg);
      putOverlayText(line, centerStart + 1, centerWidth - 2, truncateDisplay(selectedText.hint, centerWidth - 2), {
        fg: UI_TONES.fg.secondary,
        bg: DEFAULT_OVERLAY_PALETTE.selectedBg,
      });
    } else {
      renderFieldRow(line, wizard, fieldRows[row - fieldStartRow] ?? { kind: 'empty' }, centerStart, centerWidth);
    }

    const step = wizard.steps[row] ?? null;
    if (step) {
      const stepState = stepGlyph(wizard, step, row);
      const completion = `${wizard.getCompletedFieldCount(row)}/${wizard.getStepFieldCount(row)}`;
      const completionWidth = getDisplayWidth(completion);
      const stepLabelWidth = Math.max(0, leftWidth - completionWidth - 4);
      putOverlayText(line, leftStart + 1, stepLabelWidth, truncateDisplay(`${stepState.glyph} ${row + 1}. ${step.shortLabel}`, stepLabelWidth), {
        fg: stepState.fg,
        bg: railBg,
        bold: row === wizard.stepIndex,
      });
      putOverlayText(line, Math.max(leftStart + 1, leftStart + leftWidth - completionWidth - 2), completionWidth, completion, {
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
  const fieldStartRow = 6;
  const selectedText = selectedFieldText(wizard);
  const fieldRows = buildFieldRows(wizard, visibleFields, Math.max(0, bodyRows - fieldStartRow));

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
  const meta = `${wizard.stepIndex + 1}/${wizard.steps.length} • ${changedScreensLabel(wizard)}`;
  putOverlayText(topLine, Math.max(layout.margin + 2, layout.margin + layout.width - getDisplayWidth(meta) - 3), layout.width - 4, meta, {
    fg: UI_TONES.fg.secondary,
    bg: headerBg,
  });
  lines.push(topLine);

  const headerLine = createOverlayContentLine(width, layout, borderFg, headerBg);
  fillWidth(headerLine, innerStart, innerWidth, headerBg);
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
    fillWidth(line, innerStart, innerWidth, bodyBg);

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
      putOverlayText(line, innerStart + 1, innerWidth - 2, descriptionLines[1] ?? '', {
        fg: UI_TONES.fg.secondary,
        bg: bodyBg,
      });
    } else if (row === 3) {
      fillWidth(line, innerStart, innerWidth, UI_TONES.bg.section);
      putOverlayText(line, innerStart + 1, innerWidth - 2, truncateDisplay(controlsText(wizard), innerWidth - 2), {
        fg: UI_TONES.state.info,
        bg: UI_TONES.bg.section,
      });
    } else if (row === 4) {
      fillWidth(line, innerStart, innerWidth, DEFAULT_OVERLAY_PALETTE.selectedBg);
      putOverlayText(line, innerStart + 1, innerWidth - 2, truncateDisplay(`Focus: ${selectedText.title.replace(/^Selected: /, '')}`, innerWidth - 2), {
        fg: UI_TONES.fg.primary,
        bg: DEFAULT_OVERLAY_PALETTE.selectedBg,
        bold: true,
      });
    } else if (row === 5) {
      fillWidth(line, innerStart, innerWidth, DEFAULT_OVERLAY_PALETTE.selectedBg);
      putOverlayText(line, innerStart + 1, innerWidth - 2, truncateDisplay(selectedText.hint, innerWidth - 2), {
        fg: UI_TONES.fg.secondary,
        bg: DEFAULT_OVERLAY_PALETTE.selectedBg,
      });
    } else {
      renderFieldRow(line, wizard, fieldRows[row - fieldStartRow] ?? { kind: 'empty' }, innerStart, innerWidth);
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
  const margin = width >= 64 ? 1 : 0;
  const layout = createOverlayBoxLayout(width, margin, Math.max(20, width - margin * 2));
  const collapsed = layout.innerWidth < 86;
  return collapsed
    ? renderCollapsedLayout(wizard, width, viewportHeight, layout)
    : renderWideLayout(wizard, width, viewportHeight, layout);
}
