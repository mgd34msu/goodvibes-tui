/**
 * renderOnboardingWizard, the onboarding wizard on the modal surface kit.
 *
 * The wizard owns the screen (the shell hides its header and footer), so the
 * surface takes the full width minus 1 column per side and the full height:
 * the gradient ▄ cap on the first row, the surface ▀ cap on the last, 4
 * columns of inner padding, the ✦ title row with the mode, the step position
 * and the changed-screen count, and keycap hints on the second-to-last row.
 * No box-drawing frames.
 *
 * Wide screens: the steps as a kit list on the left (the current step is the
 * gradient row; ✓ complete, ◈ changed, • untouched, completion right-aligned)
 * with the step summary under it, and on the right the step title, its
 * description, the field rows and a focus panel that wraps the selected
 * field's hint in full. Narrow screens drop the step list and keep the rest.
 */

import { activeTokens, activeUiTones } from '../theme.ts';
import {
  beginModal,
  finishModal,
  scrollCountText,
  type KitHint,
  type SurfaceLayer,
} from '../surface-kit.ts';
import { drawList, type KitRow } from '../surface-kit-list.ts';
import { panel } from '../surface-kit-parts.ts';
import { drawTextBlock, textBlockHeight, type TextLine } from '../surface-kit-extra.ts';
import type {
  OnboardingWizardController,
  OnboardingWizardFieldDefinition,
} from '../../input/onboarding/onboarding-wizard.ts';

function modeLabel(mode: OnboardingWizardController['mode']): string {
  if (mode === 'edit') return 'edit existing';
  if (mode === 'reopen') return 'reopen review';
  return 'new setup';
}

function changedScreensLabel(wizard: OnboardingWizardController): string {
  if (wizard.dirtyStepCount === 0) return 'no changes';
  if (wizard.dirtyStepCount === 1) return '1 changed screen';
  return `${wizard.dirtyStepCount} changed screens`;
}

function stepRows(wizard: OnboardingWizardController): KitRow[] {
  const tones = activeUiTones();
  return wizard.steps.map((step, index): KitRow => {
    const total = wizard.getStepFieldCount(index);
    const completed = wizard.getCompletedFieldCount(index);
    const dirty = wizard.isStepDirty(index);
    const complete = total > 0 && completed === total;
    return {
      label: `${index + 1}. ${step.shortLabel}`,
      mark: dirty ? '◈' : complete ? '✓' : '•',
      markFg: dirty ? tones.state.warn : complete ? tones.state.good : tones.fg.muted,
      right: `${completed}/${total}`,
      rightFg: dirty ? tones.state.warn : undefined,
      selected: index === wizard.stepIndex,
    };
  });
}

function fieldBadgeTone(wizard: OnboardingWizardController, field: OnboardingWizardFieldDefinition): string {
  const tones = activeUiTones();
  if (field.kind === 'status' || field.kind === 'modelPicker') return tones.state.info;
  if (field.kind === 'acknowledgement') {
    const label = wizard.getFieldValueLabel(field);
    return label === 'Accepted' ? tones.state.good : label === 'Pending' ? tones.state.warn : tones.fg.muted;
  }
  if (field.kind === 'checklist') return wizard.getFieldValue(field) ? tones.state.good : tones.fg.muted;
  if (field.kind === 'radio') return tones.state.active;
  if (field.kind === 'text' || field.kind === 'masked') {
    if (wizard.getFieldValueLabel(field) === 'Missing') return tones.state.warn;
    if (field.kind === 'masked') return tones.state.warn;
  }
  return tones.fg.secondary;
}

function fieldMark(wizard: OnboardingWizardController, field: OnboardingWizardFieldDefinition): string | undefined {
  if (wizard.isFieldDirty(field.id)) return '◇';
  if (field.kind === 'checklist' || field.kind === 'acknowledgement') return wizard.getFieldValue(field) ? '✓' : '□';
  if (field.kind === 'action') return '▶';
  if (field.kind === 'radio') return '◉';
  return undefined;
}

/** Field rows; spacer rows before a field are kept as blank rows. */
function fieldRows(wizard: OnboardingWizardController): { rows: KitRow[]; scrollStart: number } {
  const t = activeTokens();
  const rows: KitRow[] = [];
  const selectedIndex = wizard.getSelectedFieldIndex();
  const scrollField = wizard.scrollOffsets[wizard.stepIndex] ?? 0;
  let scrollStart = 0;
  wizard.currentStep.fields.forEach((field, index) => {
    for (let k = 0; k < Math.max(0, field.spacerBeforeRows ?? 0); k++) rows.push({ label: '' });
    if (index === scrollField) scrollStart = rows.length;
    rows.push({
      label: field.label,
      mark: fieldMark(wizard, field),
      markFg: wizard.isFieldDirty(field.id) ? t.warning : t.brand,
      right: `[${wizard.getFieldValueLabel(field)}]`,
      rightFg: fieldBadgeTone(wizard, field),
      selected: index === selectedIndex,
    });
  });
  return { rows, scrollStart };
}

/** The focus panel's lines: what the selected field is and what it does, in full. */
function focusLines(wizard: OnboardingWizardController): TextLine[] {
  const t = activeTokens();
  if (wizard.isEditingTextField() && wizard.editingFieldId !== null) {
    const field = wizard.getFieldById(wizard.editingFieldId);
    if (field && (field.kind === 'text' || field.kind === 'masked')) {
      const raw = wizard.editBuffer.length > 0 ? wizard.editBuffer : field.placeholder;
      const shown = field.kind === 'masked' && wizard.editBuffer.length > 0
        ? '•'.repeat(Math.min(12, Math.max(4, wizard.editBuffer.length)))
        : raw;
      return [
        { text: `Editing: ${field.label}`, style: { fg: t.text, bold: true } },
        { text: `${shown}▏`, style: { fg: t.text } },
        { text: field.hint, style: { fg: t.textMuted } },
      ];
    }
  }
  const field = wizard.getSelectedField();
  if (!field) return [{ text: 'No selectable row is active on this screen.', style: { fg: t.textMuted } }];
  let hint = field.hint;
  if (field.kind === 'modelPicker') hint = `${hint} Press Enter to open the picker.`;
  if (field.kind === 'text' || field.kind === 'masked') hint = `${hint} Press Enter to edit inline.`;
  return [
    { text: `Focus: ${field.label} [${wizard.getFieldValueLabel(field)}]`, style: { fg: t.text, bold: true } },
    { text: hint, style: { fg: t.textMuted } },
  ];
}

function hintsFor(wizard: OnboardingWizardController): KitHint[] {
  if (wizard.isEditingTextField()) {
    return [['⏎', 'save'], ['esc', 'cancel edit'], ['bksp', 'delete char'], ['del', 'clear']];
  }
  return [['↑↓', 'move'], ['⏎', 'change'], ['tab', 'next screen'], ['shift+tab', 'back'], ['del', 'clear']];
}

/** Text width at which the step list sits beside the step body. */
const WIDE_WIDTH = 90;

/**
 * Render the wizard as a SurfaceLayer covering the screen (x 1, y 0).
 * `width` and `viewportHeight` are the screen size the wizard owns.
 */
export function renderOnboardingWizard(
  wizard: OnboardingWizardController,
  width: number,
  viewportHeight: number,
): SurfaceLayer {
  const t = activeTokens();
  const step = wizard.currentStep;
  const hints = hintsFor(wizard);
  // The wizard owns the screen: full width minus 1 per side, full height.
  // beginModal sizes against a screen tall enough that the requested height
  // is never clamped; the layer is then placed at the top row.
  const height = Math.max(5, viewportHeight - 2);
  const f = beginModal(width, Math.max(viewportHeight * 2, 12), {
    title: 'Onboarding',
    sub: `${modeLabel(wizard.mode)} · step ${wizard.stepIndex + 1} of ${wizard.steps.length} · ${changedScreensLabel(wizard)}`,
    hints,
    width: width - 2,
    height,
    dim: false,
  });
  const inner = f.r - f.l + 1;
  const wide = inner >= WIDE_WIDTH;

  let x0 = f.l;
  if (wide) {
    const railW = inner >= 140 ? 32 : 28;
    const railX1 = f.l + railW - 1;
    const steps = stepRows(wizard);
    const res = drawList(f.canvas, { rows: steps, top: f.top, bottom: f.bottom, x0: f.l, x1: railX1 });
    const summary: TextLine[] = [
      { text: step.summaryTitle, style: { fg: t.info, bold: true } },
      ...step.summaryLines.slice(0, 2).map((text) => ({ text, style: { fg: t.textMuted } })),
      { text: `Fields ${wizard.getCompletedFieldCount(wizard.stepIndex)}/${wizard.getStepFieldCount(wizard.stepIndex)} complete`, style: { fg: t.textMuted } },
    ];
    const summaryTop = res.endY + 1;
    if (summaryTop + textBlockHeight(summary, railW) - 1 <= f.bottom) drawTextBlock(f.canvas, f.l, summaryTop, railW, summary, f.bottom);
    x0 = railX1 + 6;
  }
  const x1 = f.r;
  const textW = x1 - x0 + 1;

  // Step title and its description, in full.
  let y = drawTextBlock(f.canvas, x0, f.top, textW, [
    { text: step.title, style: { fg: t.text, bold: true } },
    { text: step.description, style: { fg: t.textMuted } },
  ], f.bottom) + 1;

  // The focus panel at the bottom sizes to its text (never clipped); the
  // field rows get the rows between.
  const focus = focusLines(wizard);
  const panelTextW = textW;
  const focusRows = textBlockHeight(focus, panelTextW);
  const panelH = Math.min(focusRows + 2, Math.max(3, f.bottom - y - 1));
  const panelY = f.bottom - panelH + 1;
  const p = panel(f.canvas, x0 - 2, panelY, textW + 4, panelH);
  drawTextBlock(f.canvas, p.l, p.top, p.r - p.l + 1, focus, p.bottom);

  const listBottom = panelY - 2;
  if (y > listBottom) y = listBottom;
  const fields = fieldRows(wizard);
  if (fields.rows.length === 0) {
    drawTextBlock(f.canvas, x0, y, textW, [{ text: 'This screen has no fields.', style: { fg: t.textMuted } }], listBottom);
  } else {
    const res = drawList(f.canvas, { rows: fields.rows, top: y, bottom: listBottom, x0, x1, scrollStart: fields.scrollStart });
    f.hintRight = scrollCountText(res.above, res.below);
  }
  return { ...finishModal(f), y: 0 };
}
