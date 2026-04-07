/**
 * Calculates the visual width of a string in the terminal.
 * Handles CJK characters, emoji (including ZWJ sequences), and
 * variation selectors correctly as double-width.
 */
export function getDisplayWidth(text: string): number {
  let width = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i)!;
    const charLen = code > 0xFFFF ? 2 : 1; // surrogate pair = 2 JS chars

    if (code < 32 || code === 127) {
      i += charLen;
      continue;
    }

    // Zero-width joiners, variation selectors, combining marks — 0 width
    if (
      code === 0x200D || // ZWJ
      code === 0xFE0F || // emoji variation selector
      code === 0xFE0E || // text variation selector
      (code >= 0x0300 && code <= 0x036F) || // combining diacriticals
      (code >= 0x1AB0 && code <= 0x1AFF) || // combining diacriticals ext
      (code >= 0x20D0 && code <= 0x20FF) || // combining marks for symbols
      (code >= 0xFE20 && code <= 0xFE2F) || // combining half marks
      (code >= 0xE0100 && code <= 0xE01EF) // variation selectors supplement
    ) {
      i += charLen;
      continue;
    }

    // Dingbat symbols (✓ ✗ ✔ ✘) that fall in the 0x2700-0x27BF range which is
    // classified as double-width below, but terminals render them as single-width.
    // Also includes defensive entries for box drawing and block elements.
    if (
      code === 0x2713 || // ✓ check mark
      code === 0x2717 || // ✗ ballot x
      code === 0x2714 || // ✔ heavy check mark
      code === 0x2718 || // ✘ heavy ballot x
      code === 0x2022 || // • bullet
      code === 0x258D || // ▍ left five eighths block
      (code >= 0x2500 && code <= 0x257F) // box drawing block (all single-width)
    ) {
      width += 1;
      i += charLen;
      continue;
    }

    // Emoji and pictographic — double width in most terminals
    // Note: 💭 (U+1F4AD) and 🧠 (U+1F9E0) are both in the 0x1F300–0x1F9FF range,
    // so they are correctly handled as width 2 here.
    if (
      (code >= 0x1F300 && code <= 0x1F9FF) || // misc symbols, emoticons, supplemental (includes 💭 U+1F4AD, 🧠 U+1F9E0)
      (code >= 0x1FA00 && code <= 0x1FAFF) || // chess, symbols ext-A
      (code >= 0x2600 && code <= 0x27BF) ||   // misc symbols, dingbats
      (code >= 0x2300 && code <= 0x23FF) ||   // misc technical (hourglass, etc)
      (code >= 0x2B50 && code <= 0x2B55) ||   // stars, circles
      (code >= 0xFE00 && code <= 0xFE0F) ||   // variation selectors (handled above but safe)
      (code >= 0x1F000 && code <= 0x1F02F) || // mahjong, dominos
      (code >= 0x1F680 && code <= 0x1F6FF) || // transport symbols
      code === 0x200D ||                       // ZWJ (handled above)
      (code >= 0xE000 && code <= 0xF8FF) ||   // private use area (some terminals render wide)
      code === 0x2764 || code === 0x2763 ||   // hearts
      code === 0x270A || code === 0x270B || code === 0x270C || // hand gestures
      code === 0x261D || code === 0x2639 || code === 0x263A    // misc
    ) {
      width += 2;
      i += charLen;
      continue;
    }

    // CJK and fullwidth — double width
    if (
      (code >= 0x1100 && code <= 0x115F) ||   // Hangul Jamo
      (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F) || // CJK
      (code >= 0xAC00 && code <= 0xD7A3) ||   // Hangul syllables
      (code >= 0xF900 && code <= 0xFAFF) ||   // CJK compat ideographs
      (code >= 0xFF00 && code <= 0xFF60) ||    // fullwidth forms
      (code >= 0x20000 && code <= 0x2FFFD) ||  // CJK unified ext B+
      (code >= 0x30000 && code <= 0x3FFFD)     // CJK unified ext G+
    ) {
      width += 2;
      i += charLen;
      continue;
    }

    // Everything else — single width
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

/**
 * Smart Word Wrapping.
 */
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
      const wordW = getDisplayWidth(word);
      const currentLineW = getDisplayWidth(currentLine);
      
      // Safety: If a single word is longer than the width, we must force-break it
      if (wordW > width) {
        if (currentLine) lines.push(currentLine);
        let remaining = word;
        while (getDisplayWidth(remaining) > width) {
          // Find split point
          let splitIdx = 0;
          let currentW = 0;
          for (let i = 0; i < remaining.length; i++) {
            const charW = getDisplayWidth(remaining[i]);
            if (currentW + charW > width) break;
            currentW += charW;
            splitIdx = i + 1;
          }
          lines.push(remaining.slice(0, splitIdx));
          remaining = remaining.slice(splitIdx);
        }
        currentLine = remaining;
        continue;
      }

      if ((currentLineW + wordW + (currentLine ? 1 : 0)) <= width) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
  }

  return lines;
}

/**
 * Interpolates between two RGB colors based on a factor (0-1).
 */
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
