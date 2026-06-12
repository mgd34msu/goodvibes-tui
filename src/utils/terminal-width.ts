/**
 * Strip ANSI SGR/CSI escape sequences and OSC-8 hyperlink sequences
 * from a string so that only visible characters remain for width measurement.
 *
 * Covers:
 *   - CSI sequences: ESC [ ... <final byte 0x40-0x7E>  (includes SGR \x1b[...m)
 *   - OSC sequences: ESC ] ... ST  where ST is ESC\\ or BEL (0x07)
 *   - Simple ESC followed by a single non-bracket/non-] character (e.g. ESC c)
 */
function stripAnsi(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\x1b') {
      const next = text[i + 1];
      if (next === '[') {
        // CSI: skip until final byte (0x40-0x7E)
        i += 2;
        while (i < text.length) {
          const c = text.charCodeAt(i);
          i++;
          if (c >= 0x40 && c <= 0x7e) break;
        }
      } else if (next === ']') {
        // OSC: skip until ST (ESC\\ or BEL)
        i += 2;
        while (i < text.length) {
          if (text[i] === '\x07') { i++; break; }
          if (text[i] === '\x1b' && text[i + 1] === '\\') { i += 2; break; }
          i++;
        }
      } else {
        // Simple two-byte escape (ESC + one char)
        i += next !== undefined ? 2 : 1;
      }
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}

/**
 * Calculates the visual width of a string in the terminal.
 * Handles CJK characters, emoji, and variation selectors correctly as
 * double-width. ANSI escape sequences (SGR/CSI/OSC-8) are stripped before
 * measurement.
 *
 * NOTE: Width is measured per Unicode scalar value (code point), not per
 * grapheme cluster. ZWJ sequences (e.g. 👨‍👩‍👧‍👦) are handled component-by-component:
 * each component's width is summed and ZWJ/VS chars contribute zero width,
 * so the total is accurate. However, truncation (truncateDisplay) may split
 * a ZWJ family mid-sequence, leaving dangling ZWJ/VS characters. This is a
 * cosmetic degradation only — line widths remain correct.
 */
export function getDisplayWidth(text: string): number {
  text = stripAnsi(text);
  let width = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i)!;
    const charLen = code > 0xFFFF ? 2 : 1;

    if (code < 32 || code === 127) {
      i += charLen;
      continue;
    }

    if (
      code === 0x200d ||
      code === 0xfe0f ||
      code === 0xfe0e ||
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe20 && code <= 0xfe2f) ||
      (code >= 0xe0100 && code <= 0xe01ef)
    ) {
      i += charLen;
      continue;
    }

    if (
      code === 0x2713 ||
      code === 0x2717 ||
      code === 0x2714 ||
      code === 0x2718 ||
      code === 0x2022 ||
      code === 0x258d ||
      (code >= 0x2500 && code <= 0x257f)
    ) {
      width += 1;
      i += charLen;
      continue;
    }

    if (
      (code >= 0x1f300 && code <= 0x1f9ff) ||
      (code >= 0x1fa00 && code <= 0x1faff) ||
      (code >= 0x2600 && code <= 0x27bf) ||
      (code >= 0x2300 && code <= 0x23ff) ||
      (code >= 0x2b50 && code <= 0x2b55) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0x1f000 && code <= 0x1f02f) ||
      (code >= 0x1f680 && code <= 0x1f6ff) ||
      code === 0x200d ||
      (code >= 0xe000 && code <= 0xf8ff) ||
      code === 0x2764 || code === 0x2763 ||
      code === 0x270a || code === 0x270b || code === 0x270c ||
      code === 0x261d || code === 0x2639 || code === 0x263a
    ) {
      width += 2;
      i += charLen;
      continue;
    }

    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd)
    ) {
      width += 2;
      i += charLen;
      continue;
    }

    width += 1;
    i += charLen;
  }
  return width;
}

export function center(text: string, width: number): string {
  const displayWidth = getDisplayWidth(text);
  if (displayWidth >= width) return text;
  const left = Math.floor((width - displayWidth) / 2);
  return ' '.repeat(left) + text;
}

export function truncateDisplay(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  if (getDisplayWidth(text) <= width) return text;
  const ellipsisWidth = getDisplayWidth(ellipsis);
  if (ellipsisWidth >= width) return truncateDisplay(ellipsis, width, '');

  let result = '';
  let currentWidth = 0;
  for (const char of text) {
    const charWidth = getDisplayWidth(char);
    if (currentWidth + charWidth + ellipsisWidth > width) break;
    result += char;
    currentWidth += charWidth;
  }
  return result + ellipsis;
}

export function padDisplayEnd(text: string, width: number): string {
  const currentWidth = getDisplayWidth(text);
  if (currentWidth >= width) return text;
  return text + ' '.repeat(width - currentWidth);
}

export function fitDisplay(text: string, width: number, ellipsis = '…'): string {
  return padDisplayEnd(truncateDisplay(text, width, ellipsis), width);
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      const wordWidth = getDisplayWidth(word);
      const currentLineWidth = getDisplayWidth(currentLine);

      if (wordWidth > width) {
        if (currentLine) lines.push(currentLine);
        let remaining = word;
        while (getDisplayWidth(remaining) > width) {
          let splitIdx = 0;
          let currentWidth = 0;
          for (let i = 0; i < remaining.length; i++) {
            const charWidth = getDisplayWidth(remaining[i]!);
            if (currentWidth + charWidth > width) break;
            currentWidth += charWidth;
            splitIdx = i + 1;
          }
          lines.push(remaining.slice(0, splitIdx));
          remaining = remaining.slice(splitIdx);
        }
        currentLine = remaining;
        continue;
      }

      if ((currentLineWidth + wordWidth + (currentLine ? 1 : 0)) <= width) {
        currentLine += `${currentLine ? ' ' : ''}${word}`;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) lines.push(currentLine);
  }

  return lines;
}

export function interpolateColor(startHex: string, endHex: string, factor: number): string {
  const parse = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  };

  const [r1, g1, b1] = parse(startHex);
  const [r2, g2, b2] = parse(endHex);
  const r = Math.round(r1 + factor * (r2 - r1));
  const g = Math.round(g1 + factor * (g2 - g1));
  const b = Math.round(b1 + factor * (b2 - b1));
  return `${r};${g};${b}`;
}
