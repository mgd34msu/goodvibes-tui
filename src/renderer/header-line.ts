/**
 * header-line.ts, the one-row header.
 *
 *   col 1   GoodVibes, bold, in the theme's brand -> brandEnd gradient
 *           (the theme's gradient, never the protected splash constant)
 *   then    the version (faint) and the session title (muted)
 *   right   the branch with a warning-colored dirty dot (ahead/behind counts
 *           muted), 3 columns, then the serving model ending at width-2
 *
 * No rule row under it. The provider and the failover marker live on the
 * composer's inner row, next to the model the user is typing to.
 */

import { type Line, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { VERSION } from '../version.ts';
import { getDisplayWidth, interpolateColor, truncateDisplay } from '../utils/terminal-width.ts';
import type { GitHeaderInfo } from './git-status.ts';
import { activeTokens } from './theme.ts';

const BRAND = 'GoodVibes';
const BRAND_X = 1;
const GAP = 3;

interface Seg { readonly text: string; readonly fg: string; readonly bold?: boolean }

function put(line: Line, x: number, endX: number, seg: Seg): number {
  let cx = x;
  for (const ch of seg.text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (cx + w > endX) break;
    line[cx] = { char: ch, fg: seg.fg, bg: '', bold: seg.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
    if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
    cx += w;
  }
  return cx;
}

function branchSegments(gitInfo: GitHeaderInfo): Seg[] {
  const t = activeTokens();
  const segs: Seg[] = [{ text: gitInfo.branch, fg: t.textMuted }];
  if (gitInfo.ahead > 0) segs.push({ text: ` +${gitInfo.ahead}`, fg: t.textMuted });
  if (gitInfo.behind > 0) segs.push({ text: ` -${gitInfo.behind}`, fg: t.textMuted });
  if (gitInfo.dirty) segs.push({ text: ' ●', fg: t.warning });
  return segs;
}

/**
 * Render the header row.
 *
 * @param width   - Terminal columns.
 * @param model   - Serving model id (core/active-model-identity.ts).
 * @param title   - Optional session title, truncated to fit.
 * @param gitInfo - Optional branch/dirty/ahead-behind.
 * @param version - Defaults to the live build VERSION; tests pin a fixture.
 */
export function renderHeaderLine(
  width: number,
  model: string,
  title?: string,
  gitInfo?: GitHeaderInfo,
  version: string = VERSION,
): Line[] {
  const t = activeTokens();
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  const end = width - 1; // exclusive: the model ends at width-2

  // Right side first, so the title knows how much room it has.
  const modelW = getDisplayWidth(model);
  const branch = gitInfo ? branchSegments(gitInfo) : [];
  const branchW = branch.reduce((s, seg) => s + getDisplayWidth(seg.text), 0);
  const leftMin = BRAND_X + BRAND.length + 1 + getDisplayWidth(version);
  const showBranch = branchW > 0 && leftMin + GAP + branchW + GAP + modelW <= end;
  const rightW = modelW + (showBranch ? branchW + GAP : 0);
  const rightX = Math.max(leftMin + GAP, end - rightW);

  // Brand, version, title.
  let x = BRAND_X;
  [...BRAND].forEach((ch, i) => {
    x = put(line, x, end, { text: ch, fg: interpolateColor(t.brand, t.brandEnd, i / (BRAND.length - 1)), bold: true });
  });
  x = put(line, x + 1, end, { text: version, fg: t.textFaint });
  if (title) {
    const room = rightX - GAP - (x + 2);
    if (room >= 4) put(line, x + 2, rightX - GAP, { text: truncateDisplay(title, room), fg: t.textMuted });
  }

  let rx = rightX;
  if (showBranch) {
    for (const seg of branch) rx = put(line, rx, end, seg);
    rx += GAP;
  }
  put(line, rx, end, { text: model, fg: t.text });
  return [line];
}
