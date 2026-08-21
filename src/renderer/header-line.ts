/**
 * header-line.ts, the top-of-screen header row: brand, version, optional
 * conversation title, optional git segment, and the right-hand model/provider
 * pair.
 *
 * Extracted from ui-factory.ts (which sits on the 800-line source gate) when
 * the header gained the failover divergence marker. `UIFactory.createHeader`
 * remains the call name everywhere and delegates here.
 *
 * The model/provider pair rendered here is the SERVING backend, resolved by
 * core/active-model-identity.ts, the same resolution the footer uses, so the
 * two surfaces can no longer disagree about who is answering. `note` carries
 * the divergence marker naming the user's configured selection when serving
 * has moved off it.
 */

import { type Line, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { VERSION } from '../version.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { GitHeaderInfo } from './git-status.ts';
import { activeUiTones } from './theme.ts';

/** Build the git segment string and its display width. Single source of truth for header layout. */
function buildGitSegment(gitInfo: GitHeaderInfo): { text: string; width: number } {
  const branch = ` git:${gitInfo.branch}`;
  if (gitInfo.dirty) {
    const text = `${branch} * `;
    return { text, width: getDisplayWidth(text) };
  }
  if (gitInfo.ahead > 0 || gitInfo.behind > 0) {
    const arrows = (gitInfo.ahead > 0 ? ` +${gitInfo.ahead}` : '') + (gitInfo.behind > 0 ? ` -${gitInfo.behind}` : '');
    const text = `${branch}${arrows} `;
    return { text, width: getDisplayWidth(text) };
  }
  const text = `${branch} `;
  return { text, width: getDisplayWidth(text) };
}

/**
 * Pick the widest divergence marker that still fits beside the brand and the
 * model/provider pair.
 *
 * Graded, never truncated mid-word: the full marker (which names the
 * configured selection) is preferred; a bare "divergent" keyword is the
 * fallback on a narrow terminal; on a very narrow terminal the marker is
 * dropped entirely. Dropping it is safe, what remains is still the SERVING
 * backend, so the header never claims the configured backend is answering.
 * The footer carries the full marker with far more room (see ui-factory's
 * prioritized context segments).
 */
function fitHeaderNote(note: string, usedWidth: number, width: number): string {
  if (!note) return '';
  const full = `· ${note} `;
  if (usedWidth + getDisplayWidth(full) <= width) return full;
  const short = '· divergent ';
  return usedWidth + getDisplayWidth(short) <= width ? short : '';
}

/**
 * Render the header row plus its underline.
 *
 * @param width    - Terminal columns.
 * @param model    - Serving model id (already resolved; see file doc).
 * @param provider - Serving provider id.
 * @param title    - Optional conversation title, truncated to fit.
 * @param gitInfo  - Optional git branch/dirty/ahead-behind segment.
 * @param version  - Defaults to the live build VERSION; tests pass a pinned
 *                   fixture so golden snapshots survive release bumps.
 * @param note     - Divergence marker naming the configured selection when the
 *                   serving backend is not the one the user chose; '' otherwise.
 */
export function renderHeaderLine(
  width: number,
  model: string,
  provider: string,
  title?: string,
  gitInfo?: GitHeaderInfo,
  version: string = VERSION,
  note: string = '',
): Line[] {
  const lines: Line[] = [];
  // Header/footer/thinking paint on the transparent terminal background, so
  // they read chrome.* (light-terminal-aware), NOT fg.*/state.*, which stay
  // tuned for the opaque dark modal/panel boxes. Read live per render so a
  // mode flip re-resolves without any module reload (see theme.ts).
  const t = activeUiTones();
  const CYAN = t.accent.brand;
  const GREY = t.chrome.faint;
  const TITLE_COLOR = t.chrome.label;
  const brand = ` GoodVibes `;
  const ver = `v${version} `;
  const stats = ` ${model} `;
  const prov = `(${provider}) `;
  const gitWidth = gitInfo ? buildGitSegment(gitInfo).width : 0;
  // Resolve the marker before the title so the title's fit calculation
  // reserves room for it too.
  const noteStr = fitHeaderNote(note, getDisplayWidth(brand + ver + stats + prov) + gitWidth, width);
  const line = createEmptyLine(width);
  let curX = 0;
  for (const char of brand) { line[curX++] = { char, fg: CYAN, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false }; }
  for (const char of ver) { line[curX++] = { char, fg: GREY, bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false }; }
  // Optional conversation title, shown after brand/ver, truncated to fit
  if (title) {
    const titleStr = `│ ${title} `;
    // Reserve space for git info (if present) + model/provider + marker on the right
    const rightReserved = getDisplayWidth(stats + prov + noteStr) + gitWidth;
    const maxTitleW = width - curX - rightReserved - 1;
    let displayTitle: string;
    if (getDisplayWidth(titleStr) <= maxTitleW) {
      displayTitle = titleStr;
    } else {
      let truncated = '';
      let w = 0;
      for (const ch of titleStr) {
        const cw = getDisplayWidth(ch);
        if (w + cw > maxTitleW - 3) { truncated += '...'; break; }
        truncated += ch;
        w += cw;
      }
      displayTitle = truncated;
    }
    for (const char of displayTitle) { if (curX < width) line[curX++] = { char, fg: TITLE_COLOR, bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false }; }
  }
  // Build git info segment
  let gitStr = '';
  let gitFg: string = t.chrome.faint;
  if (gitInfo) {
    gitStr = buildGitSegment(gitInfo).text;
    if (gitInfo.dirty || gitInfo.ahead > 0 || gitInfo.behind > 0) {
      gitFg = t.chrome.warn; // yellow when dirty or out-of-sync
    }
  }
  const rightSideW = getDisplayWidth(stats + prov + noteStr) + getDisplayWidth(gitStr);
  let rightX = width - rightSideW;
  for (const char of gitStr) { if (rightX >= 0 && rightX < width) line[rightX++] = { char, fg: gitFg, bg: '', bold: false, dim: !gitInfo?.dirty && !(gitInfo?.ahead || gitInfo?.behind), underline: false, italic: false, strikethrough: false }; }
  for (const char of stats) { if (rightX < width) line[rightX++] = { char, fg: CYAN, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false }; }
  for (const char of prov) { if (rightX < width) line[rightX++] = { char, fg: GREY, bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false }; }
  // The marker reads as a warning, not as chrome: serving has left the
  // selection the user made and that is worth noticing.
  for (const char of noteStr) { if (rightX >= 0 && rightX < width) line[rightX++] = { char, fg: t.chrome.warn, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false }; }
  lines.push(line);
  const underline = createEmptyLine(width);
  for (let x = 0; x < width; x++) underline[x] = { char: '━', fg: t.chrome.faint, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
  lines.push(underline);
  return lines;
}
