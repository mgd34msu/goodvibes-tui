/**
 * computePromptContentWidth — content width available for prompt text inside
 * the footer input box, after the box margin, inner padding, and the ' > '
 * prefix are subtracted.
 *
 * Floors at 1: on a hostile-narrow terminal the raw subtraction
 * (boxWidth - 4 - 3) can go zero or negative, and a non-positive content
 * width breaks downstream text-wrapping and cursor-position math (which
 * assume at least one column to place a character in).
 */
export function computePromptContentWidth(terminalColumns: number): number {
  const w = terminalColumns || 80;
  const boxMargin = 2;
  const boxWidth = w - (boxMargin * 2);
  return Math.max(1, boxWidth - 4 - 3); // minus padding (4) minus prefix width (3: ' > ')
}
