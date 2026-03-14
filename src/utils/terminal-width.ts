/**
 * Calculates the visual width of a string in the terminal.
 */
export function getDisplayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) continue;
    if (
      (code >= 0x1100 && code <= 0x115F) || 
      (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F) || 
      (code >= 0xAC00 && code <= 0xD7A3) || 
      (code >= 0xF900 && code <= 0xFAFF) || 
      (code >= 0xFF00 && code <= 0xFF60)
    ) { width += 2; } else { width += 1; }
  }
  return width;
}

export function center(text: string, width: number): string {
  const displayWidth = getDisplayWidth(text);
  if (displayWidth >= width) return text;
  const left = Math.floor((width - displayWidth) / 2);
  return ' '.repeat(left) + text;
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
