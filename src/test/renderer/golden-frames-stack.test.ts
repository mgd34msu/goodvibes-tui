// ---------------------------------------------------------------------------
// golden-frames-stack.test.ts, the bottom of the main screen, whole: output
// text, the throbber, the input area and the status line, with the gaps
// between them, at rest, while main thinks, while it runs a tool, and with
// the keyboard in the work tree (tree mode, Alt+Up), and scrolled back from
// the live bottom (the back-to-bottom pill) at rest and while a tool runs, at
// 80, 120 and 160 columns. Every frame starts with the header row and the
// empty row under it.
//
// The transcript ends with a table row, the case where the last row of output
// used to sit directly on the input area. Each frame asserts the exact stack
// from the bottom up; the layout audit (helpers/frame-audit.ts, GAP) runs on
// every frame here and again in golden-frames-audit.test.ts.
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-stack.test.ts
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { withHeaderGap } from '../../renderer/header-line.ts';
import { renderMarkdown } from '../../renderer/markdown.ts';
import { appendConversationMessages, type ConversationRenderContext } from '../../core/conversation-rendering.ts';
import { settleSyntaxHighlighting } from '../../renderer/code-block.ts';
import { activeTokens, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import type { ThrobberState } from '../../renderer/throbber.ts';
import { auditFrame } from '../helpers/frame-audit.ts';
import { assertGoldenIn, encodeGolden } from '../helpers/golden-snapshot.ts';
import { singleLaneScene } from '../helpers/work-tree-scenes.ts';

setActiveThemeName('goodvibes');
setActiveThemeMode('dark');
const DIR = new URL('./golden-frames/', import.meta.url).pathname;
const HEIGHT = 30;
const VERSION = '0.29.0';

type Mode = 'rest' | 'thinking' | 'tool' | 'tree' | 'scrolled' | 'scrolled-tool';

const THINKING: ThrobberState = { spinner: '⠋', frame: 0, activity: { kind: 'model', phrase: 'Thinking...', elapsedMs: 12_000 } };
const TOOL: ThrobberState = { spinner: '⠙', frame: 0, activity: { kind: 'tool', tool: 'exec', argument: 'bun test src/net/retry.test.ts', elapsedMs: 3_000 } };

function blank(width: number): Line {
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  return line;
}

/** A transcript that ends on a table row. */
function tableTranscript(width: number): Line[] {
  const body: Line[] = [blank(width)];
  body.push(...UIFactory.createMessageBar(width, 'The retry helper never backs off. Can you fix it?'));
  body.push(blank(width));
  body.push(...renderMarkdown([
    'The delay now doubles each attempt. The schedule becomes:',
    '| Attempt | Delay (ms) |',
    '|---|---|',
    '| 1 | 200 |',
    '| 2 | 400 |',
  ].join('\n'), width));
  return body;
}

/** The work tree with the keyboard on its first bead. */
function treeTranscript(width: number): Line[] {
  const scene = singleLaneScene();
  const lines: Line[] = [];
  const context: ConversationRenderContext = {
    history: { addLine: (l) => { lines.push(l); }, addLines: (ls) => { lines.push(...ls); }, getLineCount: () => lines.length },
    blockRegistry: [],
    collapseState: new Map(scene.collapse),
    errorLineRegistry: [],
    messageKindRegistry: new Map(),
    configManager: null,
    splashOptions: {},
    workTreeSources: scene.sources,
    treeGlyphSet: 'rounded',
    focusId: 'c:1:0',
    frame: 0,
  };
  appendConversationMessages(context, scene.messages, width, []);
  return lines;
}

function screen(width: number, mode: Mode): Line[] {
  const header = withHeaderGap(UIFactory.createHeader(width, 'claude-opus-4', 'Fix retry backoff', { branch: 'main', dirty: true, ahead: 0, behind: 0 }, VERSION), width);
  const working = mode !== 'rest' && mode !== 'scrolled';
  const scrolled = mode === 'scrolled' || mode === 'scrolled-tool';
  const footer = buildShellFooter({
    width,
    promptText: '',
    promptLineCount: 1,
    promptCursorPos: 0,
    promptFocused: mode !== 'tree',
    workTreeFocused: mode === 'tree',
    usage: { up: 53_000, down: 1_700 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'claude-opus-4',
    workingDir: '/workspace/goodvibes-tui',
    branch: 'main',
    contextWindow: 1_000_000,
    compactThreshold: 0.8,
    lastInputTokens: 340_000,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    permissionMode: 'prompt',
    throbber: mode === 'thinking' ? THINKING : mode === 'tool' || mode === 'tree' || mode === 'scrolled-tool' ? TOOL : null,
    turnRunning: working,
    backToBottom: scrolled ? { escKey: true } : null,
  }).lines;
  const body = mode === 'tree' ? treeTranscript(width) : tableTranscript(width);
  const room = HEIGHT - header.length - footer.length;
  const visible = body.slice(Math.max(0, body.length - room));
  while (visible.length < room) visible.unshift(blank(width));
  return [...header, ...visible, ...footer];
}

const text = (line: Line | undefined): string => (line ?? []).map((c) => c.char || ' ').join('');
const isBlank = (line: Line | undefined): boolean => (line ?? []).every((c) => (c.char === ' ' || c.char === '') && c.bg === '');

describe('golden-frames : the stack under the transcript', () => {
  for (const width of [80, 120, 160]) {
    for (const mode of ['rest', 'thinking', 'tool', 'tree', 'scrolled', 'scrolled-tool'] as const) {
      const name = `stack-${mode}-${width}`;
      test(name, async () => {
        screen(width, mode);
        await settleSyntaxHighlighting();
        const lines = screen(width, mode);
        expect(lines).toHaveLength(HEIGHT);
        expect(lines.every((l) => l.length === width)).toBe(true);
        const H = HEIGHT;
        // From the bottom: the status line, the ▀ cap, padding, text, padding, the ▄ cap.
        expect(text(lines[H - 1])).toContain('ctrl+p');
        expect(text(lines[H - 2]).slice(2, 4)).toBe('╹▀');
        expect(text(lines[H - 3])[2]).toBe('┃');
        // The header row, then one empty row, then the output.
        expect(text(lines[0])).toMatch(/^ GoodVibes/);
        expect(isBlank(lines[1])).toBe(true);
        // The input area holds only input: its placeholder, in tree mode too.
        expect(text(lines[H - 4])).toContain('Ask anything');
        expect(text(lines[H - 4])).not.toContain('Esc returns');
        expect(text(lines[H - 5])[2]).toBe('┃');
        expect(text(lines[H - 6]).slice(2, 4)).toBe('╻▄');
        const pill = lines.findIndex((l) => text(l).includes('Back to bottom'));
        if (mode === 'scrolled' || mode === 'scrolled-tool') {
          // The pill sits right over the input area's ▄ cap, centered, with its esc keycap,
          // one full empty row under the text above it.
          expect(pill).toBe(H - 7);
          const row = text(lines[H - 7]);
          expect(row).toContain('↓ Back to bottom   esc ');
          const first = row.search(/\S/);
          const last = row.trimEnd().length - 1;
          const fill = lines[H - 7]!.map((c, x) => (c.bg !== '' ? x : -1)).filter((x) => x >= 0);
          expect(first - fill[0]!).toBe(2);
          expect(fill[fill.length - 1]! - last).toBeGreaterThanOrEqual(2);
          expect(Math.abs((fill[0]! + fill[fill.length - 1]!) / 2 - (width - 1) / 2)).toBeLessThanOrEqual(1);
          expect(isBlank(lines[H - 8])).toBe(true);
          if (mode === 'scrolled') {
            expect(text(lines[H - 9])).toContain('└');
            expect(text(lines[H - 1])).not.toContain('interrupt');
          } else {
            expect(text(lines[H - 9])).toContain('Running exec · bun test src/net/retry.test.ts · 3s');
            expect(isBlank(lines[H - 10])).toBe(true);
            expect(text(lines[H - 11])).toContain('└');
            // Scrolled back, the next Esc returns to the bottom and never interrupts.
            expect(text(lines[H - 1])).toContain('esc  back to bottom');
            expect(text(lines[H - 1])).not.toContain('interrupt');
          }
        } else if (mode === 'rest') {
          // Output text sits half a row over the input area (the ▄ cap's empty top half).
          expect(text(lines[H - 7])).toContain('└');
          expect(text(lines[H - 1])).not.toContain('interrupt');
        } else {
          // The throbber, then one full empty row, then the output text.
          expect(text(lines[H - 7]).slice(3, 5)).toMatch(/^[⠋⠙] $/);
          expect(text(lines[H - 7])).toContain(mode === 'thinking' ? 'Thinking... · 12s' : 'Running exec · bun test src/net/retry.test.ts · 3s');
          expect(isBlank(lines[H - 8])).toBe(true);
          if (mode !== 'tree') expect(text(lines[H - 9])).toContain('└');
          expect(text(lines[H - 1])).toContain(mode === 'tree' ? 'esc  back to typing' : 'interrupt');
        }
        // At the live bottom there is no pill.
        if (mode !== 'scrolled' && mode !== 'scrolled-tool') expect(pill).toBe(-1);
        if (mode === 'tree') expect(lines.some((l) => l[0]?.char === '┃')).toBe(true); // the focused row
        assertGoldenIn(DIR, name, lines);
        expect(encodeGolden(name, screen(width, mode))).toBe(encodeGolden(name, lines));
        expect(auditFrame(lines, width, activeTokens()).map((i) => `${i.kind} row ${i.row}: ${i.detail}`)).toEqual([]);
      });
    }
  }
});
