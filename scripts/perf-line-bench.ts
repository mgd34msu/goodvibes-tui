/**
 * perf-line-bench.ts, Headless line-production micro-benchmarks.
 *
 * Measures the cost of building Line[] ABOVE the compositor, the layer the
 * frame bench (perf-frame-bench.ts) does NOT cover. The frame bench measures
 * Compositor.composite() (buffer diff + emit); this bench measures everything
 * that produces the Line[] the compositor is handed:
 *
 *   transcript.build_1k   Line[] build for a 1000-message mixed conversation
 *                         (text, tool results, code blocks, a diff-shaped result)
 *   panel.two_pane_build  panel-workspace two-pane frame build (top + bottom pane,
 *                         workspace bar, split layout), panels invalidated per build
 *   markdown.render       renderMarkdownTracked on a representative mixed document
 *   codeblock.regex       renderCodeBlock via the regex fallback tokenizer (cold /
 *                         tree-sitter not yet cached, the streaming path)
 *   codeblock.treesitter  renderCodeBlock via the tree-sitter cache-hit path (settled)
 *   overlay.open          renderHelpOverlay frame build (representative overlay open)
 *
 * Allocation / heap accounting:
 *   Bun's process.memoryUsage().heapUsed does NOT update synchronously between
 *   GC boundaries, so it reads a flat delta for a tight allocation loop. Instead
 *   we use bun:jsc heapStats() bracketed by forced GC (Bun.gc(true)) around a
 *   retained batch of outputs, this yields the RETAINED footprint per operation
 *   (bytes + object count), the honest measure of per-frame allocation churn for
 *   row builders that produce fresh Line[]/Cell[] every frame.
 *
 * NEVER launches the interactive TUI binary. All headless, all synchronous
 * builders (tree-sitter warm-up is awaited once during setup).
 *
 * Consumed by scripts/perf-check.ts (the CI gate). Mirrors the shared-helper
 * pattern of perf-frame-bench.ts: methodology lives here so the gate always
 * measures against exactly what this module produces. A future WO may add a
 * release-gate test that drives runLineBenches() the same way.
 */

import { performance } from 'node:perf_hooks';
import { heapStats } from 'bun:jsc';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { appendConversationMessages } from '../src/core/conversation-rendering.ts';
import { ConversationManager } from '../src/core/conversation.ts';
import { renderMarkdownTracked } from '../src/renderer/markdown.ts';
import { renderCodeBlock } from '../src/renderer/code-block.ts';
import { PanelManager } from '../src/panels/panel-manager.ts';
import type { Panel, PanelCategory } from '../src/panels/types.ts';
import { createEmptyLine, createStyledCell } from '@pellux/goodvibes-sdk/platform/types';
import { buildPanelCompositeData } from '../src/renderer/panel-composite.ts';
import { renderHelpOverlay } from '../src/renderer/help-overlay.ts';
import { KeybindingsManager } from '../src/input/keybindings.ts';
import type { InputHandler } from '../src/input/handler.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Bench configuration, change here to update both gate and test. */
export const LINE_BENCH_CONFIG = {
  /** Column width used for every builder (a common real terminal width). */
  width: 100,
  /** Message count for the transcript build. */
  transcriptMessages: 1000,
} as const;

/**
 * Ratchet budgets (ms) keyed by metric id. Set just above measured reality on a
 * quiet dev linux-x64 box; CI runners run 2-4× slower so budgets carry headroom.
 * The committed perf-baseline.json `line` section is the source of truth the gate
 * compares against, these are the fallback defaults when no baseline exists.
 * Ratchet rule: tighten when measured p95 drops below budget/2.
 */
export const LINE_BUDGETS: Readonly<Record<string, number>> = {
  'transcript.build_1k_ms': 400,
  // appending ONE message to a warm 1000-message transcript. The
  // per-message Line[] cache reuses the unchanged 1000 and renders only the new
  // one, so this collapses from the full build_1k cost (~45 ms) to well under
  // 1 ms on a quiet box.
  // ratchet: re-measured with the per-message cache in place, on a quiet linux-x64 box the p50 is
  // rock-stable at 0.87-0.91 ms across 8 runs. Gate stat is p50 (a robust median
  // over 200 iterations, it does not spike on a single GC pause). Budget
  // tightened 20 -> 6 ms: ~6.7× this-box p50 and ~1.7-3.3× a CI-slowed median
  // (runners run 2-4× slower). A regression that reintroduces the pre-cache full
  // rebuild on append (~45 ms) now fails the gate by ~7.5×.
  'transcript.append_one_ms': 6,
  // a resize invalidates every width-dependent message (all of them), so
  // it still pays a near-full re-render, gated at the same ceiling as build_1k.
  'transcript.resize_1k_ms': 400,
  'panel.two_pane_build_ms': 4,
  'markdown.render_ms': 6,
  'codeblock.regex_ms': 4,
  'codeblock.treesitter_ms': 4,
  'overlay.open_ms': 10,
} as const;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface LineBenchCase {
  /** Metric id (matches LINE_BUDGETS keys and perf-baseline.json line keys). */
  readonly id: string;
  /** Human-readable label for the report table. */
  readonly label: string;
  readonly unit: 'ms';
  readonly timeMeanMs: number;
  readonly timeP50Ms: number;
  readonly timeP95Ms: number;
  readonly iterations: number;
  /** Line[] length produced by a single operation. */
  readonly linesProduced: number;
  /** Retained heap bytes per operation (GC-bracketed). */
  readonly heapBytesPerOp: number;
  /** Retained JS object count per operation (GC-bracketed). */
  readonly objectsPerOp: number;
}

// ---------------------------------------------------------------------------
// Timing + heap harness
// ---------------------------------------------------------------------------

interface Percentiles {
  mean: number;
  p50: number;
  p95: number;
}

function timeOp(fn: () => unknown, iterations: number, warmup: number): Percentiles {
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const p50 = samples[Math.floor(samples.length * 0.5)]!;
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  return { mean, p50, p95 };
}

/**
 * Retained-footprint heap measurement. Bun's heapStats().heapSize / objectCount
 * only settle at GC boundaries, so we force GC on both sides and keep every
 * produced output alive across the batch. The delta divided by the batch size is
 * the retained bytes/objects a single build leaves behind, the allocation churn
 * a real frame throws away and re-allocates every repaint.
 */
function measureHeap(fn: () => unknown, iterations: number): { bytesPerOp: number; objectsPerOp: number } {
  const held: unknown[] = [];
  Bun.gc(true);
  Bun.gc(true);
  const before = heapStats();
  for (let i = 0; i < iterations; i++) held.push(fn());
  Bun.gc(true);
  Bun.gc(true);
  const after = heapStats();
  // Reference held after the second GC so the batch is provably alive across it.
  if (held.length !== iterations) throw new Error('heap batch lost outputs');
  return {
    bytesPerOp: (after.heapSize - before.heapSize) / iterations,
    objectsPerOp: (after.objectCount - before.objectCount) / iterations,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CODE_SAMPLE_TS = [
  'function fibonacci(n: number): number {',
  '  if (n <= 1) return n;',
  '  let a = 0, b = 1;',
  '  for (let i = 2; i <= n; i++) {',
  '    const next = a + b;',
  '    a = b;',
  '    b = next;',
  '  }',
  '  return b;',
  '}',
  '',
  'const memo = new Map<number, number>();',
  'export async function compute(values: number[]): Promise<number[]> {',
  '  return Promise.all(values.map(async (v) => fibonacci(v)));',
  '}',
];

const DIFF_SAMPLE = [
  '--- a/src/renderer/compositor.ts',
  '+++ b/src/renderer/compositor.ts',
  '@@ -10,7 +10,8 @@ export class Compositor {',
  '   private readonly buffer: Buffer;',
  '-  private dirty = false;',
  '+  private dirty = true;',
  '+  private frames = 0;',
  '   constructor(stdout: NodeJS.WriteStream) {',
  '     this.buffer = new Buffer(stdout.columns, stdout.rows);',
  '   }',
].join('\n');

const MARKDOWN_SAMPLE = [
  '# Renderer overview',
  '',
  'The renderer builds a `Line[]` frame from conversation state and hands it to the',
  'compositor. Each **message** is rendered independently and the results are',
  'concatenated. Key stages:',
  '',
  '1. Parse markdown into blocks',
  '2. Wrap inline text to the content width',
  '3. Tokenize fenced code blocks',
  '4. Emit `Line[]` with per-cell foreground/background',
  '',
  '> Note: the compositor never re-parses; it only diffs cells.',
  '',
  'Here is a fenced block:',
  '',
  '```ts',
  'const frame = renderMarkdownTracked(text, width);',
  'compositor.composite({ viewport: frame.lines });',
  '```',
  '',
  '| Stage | Cost | Cached |',
  '| ----- | ---- | ------ |',
  '| parse | high | no     |',
  '| wrap  | mid  | no     |',
  '| emit  | low  | yes    |',
  '',
  'See `conversation-rendering.ts` for the per-message loop and',
  '`markdown.ts` for the block parser. Inline styles like *emphasis*,',
  '**strong**, and `code` are resolved during the wrap stage.',
].join('\n');

/** Build a 1000-message mixed conversation (text, tool results, code, diff). */
function buildMixedConversation(count: number): ConversationMessageSnapshot[] {
  const msgs: ConversationMessageSnapshot[] = [];
  const codeFence = '```ts\n' + CODE_SAMPLE_TS.slice(0, 6).join('\n') + '\n```';
  for (let i = 0; i < count; i++) {
    switch (i % 5) {
      case 0:
        msgs.push({ role: 'user', content: `Please investigate task ${i} and report the failing assertion in detail.` });
        break;
      case 1:
        msgs.push({
          role: 'assistant',
          content: `Here is the analysis for task ${i}. The root cause is a stale cache key.\n\n${codeFence}`,
          model: 'claude-opus',
          provider: 'anthropic',
        });
        break;
      case 2:
        msgs.push({
          role: 'tool',
          callId: `read-${i}`,
          toolName: 'Read',
          content: `line one of file ${i}\nline two\nline three\nline four\nline five`,
        });
        break;
      case 3:
        msgs.push({ role: 'tool', callId: `edit-${i}`, toolName: 'Edit', content: DIFF_SAMPLE });
        break;
      default:
        msgs.push({
          role: 'assistant',
          content: `Summary for ${i}:\n\n- checked the registry\n- confirmed the width math\n- verified \`getDisplayWidth\` handles wide glyphs`,
        });
        break;
    }
  }
  return msgs;
}

/** Minimal in-memory history sink matching the ConversationRenderContext shape. */
function makeConversationContext() {
  const lines: Line[] = [];
  return {
    history: {
      addLine: (l: Line) => { lines.push(l); },
      addLines: (ls: Line[]) => { for (const l of ls) lines.push(l); },
      getLineCount: () => lines.length,
    },
    blockRegistry: [] as unknown[],
    collapseState: new Map<string, boolean>(),
    errorLineRegistry: [] as number[],
    messageKindRegistry: new Map<number, never>(),
    configManager: null,
    splashOptions: {},
    _lines: lines,
  };
}

/**
 * A self-contained, deterministic full-pane content panel for the two-pane
 * composite benchmark. Fills each pane with styled rows (mixed fg tones + a
 * separator) so the compositor does representative per-cell work every frame.
 * (the purge) replaced the previously-used DocsPanel here, a migrated,
 * now-deleted panel, with this bench-local implementation so the perf bench
 * never breaks when a domain panel is retired.
 */
/**
 * Category the bench panels register under. Typed as PanelCategory so a future
 * rename of the category union fails `bun run typecheck` here instead of at run
 * time, the string literal 'system' used to sit inline and had already gone
 * stale when the union was split into the current nine categories.
 */
const BENCH_PANEL_CATEGORY: PanelCategory = 'runtime-ops';

function createBenchPanel(id: string, name: string, icon: string): Panel {
  const palette = ['#e2e8f0', '#94a3b8', '#38bdf8', '#22c55e', '#f59e0b'];
  return {
    id, name, icon, category: BENCH_PANEL_CATEGORY,
    onActivate: () => {}, onDeactivate: () => {}, onDestroy: () => {},
    isTransient: false, isPinned: false, needsRender: true,
    invalidate: () => {}, markRendered: () => {},
    render: (width: number, height: number): Line[] => {
      const lines: Line[] = [];
      for (let row = 0; row < height; row++) {
        if (row === 1) {
          const sep = createEmptyLine(width);
          for (let x = 0; x < width; x++) sep[x] = createStyledCell('─', { fg: '#334155' });
          lines.push(sep);
          continue;
        }
        const line = createEmptyLine(width);
        const text = `  ${name} row ${row}: composite benchmark content, mixed tokens, glyphs, and padding fill`;
        const fg = palette[row % palette.length]!;
        for (let x = 0; x < text.length && x < width; x++) {
          line[x] = createStyledCell(text[x]!, { fg, bold: row % 5 === 0 });
        }
        lines.push(line);
      }
      return lines;
    },
  };
}

/** Register two full-pane content panels and open them in the top and bottom panes. */
function makeTwoPaneManager(): { manager: PanelManager; input: InputHandler } {
  const manager = new PanelManager();
  manager.registerType({ id: 'bench-top', name: 'Top', icon: '⬆', category: BENCH_PANEL_CATEGORY, description: 'bench top pane', factory: () => createBenchPanel('bench-top', 'Top', '⬆') });
  manager.registerType({ id: 'bench-bottom', name: 'Bottom', icon: '⬇', category: BENCH_PANEL_CATEGORY, description: 'bench bottom pane', factory: () => createBenchPanel('bench-bottom', 'Bottom', '⬇') });
  manager.show();
  manager.open('bench-top', 'top');
  manager.open('bench-bottom', 'bottom');
  const input = { panelFocused: true } as unknown as InputHandler;
  return { manager, input };
}

// ---------------------------------------------------------------------------
// Bench runner
// ---------------------------------------------------------------------------

/**
 * Run all line-production micro-benchmarks headlessly.
 * Returns one LineBenchCase per measured builder, in report order.
 */
export async function runLineBenches(): Promise<LineBenchCase[]> {
  const { width, transcriptMessages } = LINE_BENCH_CONFIG;
  const cases: LineBenchCase[] = [];

  // --- transcript.build_1k ---------------------------------------------------
  {
    const messages = buildMixedConversation(transcriptMessages);
    const build = (): Line[] => {
      const ctx = makeConversationContext();
      appendConversationMessages(ctx as never, messages, width, []);
      return ctx._lines;
    };
    const linesProduced = build().length;
    const t = timeOp(build, 12, 3);
    const heap = measureHeap(build, 2);
    cases.push({
      id: 'transcript.build_1k_ms',
      label: 'transcript Line[] build (1000 mixed msgs)',
      unit: 'ms',
      timeMeanMs: t.mean, timeP50Ms: t.p50, timeP95Ms: t.p95,
      iterations: 12, linesProduced,
      heapBytesPerOp: heap.bytesPerOp, objectsPerOp: heap.objectsPerOp,
    });
  }

  // --- transcript.append_one (warm per-message cache) ----------------
  // Seed a 1000-message conversation and warm the per-message Line[] cache with a
  // cold build. Then measure the realistic cost of ONE appended message: add it,
  // rebuild the display (1000 cache hits + 1 miss), and remove it to keep the
  // conversation size stable across iterations. This is the headline: the
  // same rebuild that costs ~45 ms cold (transcript.build_1k) drops to well under
  // 1 ms because only the appended message is re-rendered.
  {
    const seed = buildMixedConversation(transcriptMessages);
    const cm = new ConversationManager(() => width);
    cm.fromJSON({ messages: seed as never[] });
    cm.getDisplayBlocks(); // cold build, warms the cache for indices 0..N-1
    let n = 0;
    const appendOne = (): Line[] => {
      cm.addUserMessage(`appended probe message ${n++}`);
      const lines = cm.getDisplayBlocks(); // warm rebuild: N hits + 1 miss
      cm.removeMessagesAfter(transcriptMessages); // truncate back to N; marks dirty
      return lines;
    };
    const linesProduced = appendOne().length;
    const t = timeOp(appendOne, 200, 20);
    const heap = measureHeap(appendOne, 20);
    cases.push({
      id: 'transcript.append_one_ms',
      label: 'transcript append-one (warm per-message cache)',
      unit: 'ms',
      timeMeanMs: t.mean, timeP50Ms: t.p50, timeP95Ms: t.p95,
      iterations: 200, linesProduced,
      heapBytesPerOp: heap.bytesPerOp, objectsPerOp: heap.objectsPerOp,
    });
  }

  // --- transcript.resize_1k (width change invalidates everything) -----
  // A resize changes the render width, which is part of every message's cache
  // key, so it invalidates all 1000 messages and pays a near-full re-render. We
  // toggle between two widths each iteration so no rebuild can reuse the cache,
  // the honest cost of a resize on a large transcript.
  {
    const seed = buildMixedConversation(transcriptMessages);
    // Annotated `number`: LINE_BENCH_CONFIG is `as const`, so `width` is the
    // literal type 100 and an unannotated `let` would inherit it and reject the
    // width flip below.
    let w: number = width;
    const cm = new ConversationManager(() => w);
    cm.fromJSON({ messages: seed as never[] });
    cm.getDisplayBlocks();
    const resize = (): Line[] => {
      w = w === width ? width - 1 : width; // flip width so every entry misses
      cm.setWidthProvider(() => w);
      return cm.getDisplayBlocks();
    };
    const linesProduced = resize().length;
    const t = timeOp(resize, 12, 3);
    const heap = measureHeap(resize, 2);
    cases.push({
      id: 'transcript.resize_1k_ms',
      label: 'transcript resize (full width-change re-render)',
      unit: 'ms',
      timeMeanMs: t.mean, timeP50Ms: t.p50, timeP95Ms: t.p95,
      iterations: 12, linesProduced,
      heapBytesPerOp: heap.bytesPerOp, objectsPerOp: heap.objectsPerOp,
    });
  }

  // --- panel.two_pane_build --------------------------------------------------
  {
    const { manager, input } = makeTwoPaneManager();
    const topPanel = manager.getTopPane().panels[0]!;
    const bottomPanel = manager.getBottomPane().panels[0]!;
    const build = () => {
      topPanel.invalidate();
      bottomPanel.invalidate();
      return buildPanelCompositeData(manager, input, 60, 40);
    };
    const first = build();
    const linesProduced = (first.panelData?.topContent.length ?? 0)
      + (first.panelData?.bottomContent?.length ?? 0)
      + (first.panelData?.workspaceBar.length ?? 0);
    const t = timeOp(build, 500, 50);
    const heap = measureHeap(build, 300);
    cases.push({
      id: 'panel.two_pane_build_ms',
      label: 'panel-workspace two-pane frame build',
      unit: 'ms',
      timeMeanMs: t.mean, timeP50Ms: t.p50, timeP95Ms: t.p95,
      iterations: 500, linesProduced,
      heapBytesPerOp: heap.bytesPerOp, objectsPerOp: heap.objectsPerOp,
    });
  }

  // --- markdown.render -------------------------------------------------------
  {
    const build = (): Line[] => renderMarkdownTracked(MARKDOWN_SAMPLE, width).lines;
    const linesProduced = build().length;
    const t = timeOp(build, 500, 50);
    const heap = measureHeap(build, 300);
    cases.push({
      id: 'markdown.render_ms',
      label: 'markdown render (mixed document)',
      unit: 'ms',
      timeMeanMs: t.mean, timeP50Ms: t.p50, timeP95Ms: t.p95,
      iterations: 500, linesProduced,
      heapBytesPerOp: heap.bytesPerOp, objectsPerOp: heap.objectsPerOp,
    });
  }

  // --- codeblock.regex (fallback tokenizer, cache-miss / streaming path) ------
  // Each iteration renders a UNIQUE variant so the shared tree-sitter cache never
  // hits, exercising the regex fallback tokenizer every time (the cold path a
  // streaming code block takes before tree-sitter warms).
  {
    let n = 0;
    const build = (): Line[] => {
      const variant = [`// variant ${n++}`, ...CODE_SAMPLE_TS];
      return renderCodeBlock(variant, 'ts', width, { isStreaming: true });
    };
    const linesProduced = build().length;
    const t = timeOp(build, 500, 50);
    const heap = measureHeap(build, 300);
    cases.push({
      id: 'codeblock.regex_ms',
      label: 'code-block render (regex fallback path)',
      unit: 'ms',
      timeMeanMs: t.mean, timeP50Ms: t.p50, timeP95Ms: t.p95,
      iterations: 500, linesProduced,
      heapBytesPerOp: heap.bytesPerOp, objectsPerOp: heap.objectsPerOp,
    });
  }

  // --- codeblock.treesitter (parsed cache-hit path, settled render) ----------
  // Warm the shared highlighter cache for one fixed sample, then measure repeated
  // renders of that SAME sample, every call is a tree-sitter cache hit.
  {
    const warmCode = CODE_SAMPLE_TS;
    const flatten = (ls: Line[]) => ls.map((l) => l.map((c) => c.fg).join(',')).join('|');
    const cold = flatten(renderCodeBlock(warmCode, 'ts', width));
    let warmed = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 40));
      if (flatten(renderCodeBlock(warmCode, 'ts', width)) !== cold) { warmed = true; break; }
    }
    if (!warmed) {
      // Tree-sitter never warmed (WASM unavailable). Fall back to reporting the
      // same path as regex rather than fabricating a number.
      process.stderr.write('perf-line-bench: tree-sitter cache did not warm; codeblock.treesitter reports cold path.\n');
    }
    const build = (): Line[] => renderCodeBlock(warmCode, 'ts', width);
    const linesProduced = build().length;
    const t = timeOp(build, 500, 50);
    const heap = measureHeap(build, 300);
    cases.push({
      id: 'codeblock.treesitter_ms',
      label: 'code-block render (tree-sitter cache-hit path)',
      unit: 'ms',
      timeMeanMs: t.mean, timeP50Ms: t.p50, timeP95Ms: t.p95,
      iterations: 500, linesProduced,
      heapBytesPerOp: heap.bytesPerOp, objectsPerOp: heap.objectsPerOp,
    });
  }

  // --- overlay.open ----------------------------------------------------------
  {
    const kb = new KeybindingsManager({ configPath: '/nonexistent/perf-bench-keybindings.json' });
    const build = (): Line[] => renderHelpOverlay(width, kb, [], 0, 40);
    const linesProduced = build().length;
    const t = timeOp(build, 500, 50);
    const heap = measureHeap(build, 300);
    cases.push({
      id: 'overlay.open_ms',
      label: 'overlay open (help overlay frame build)',
      unit: 'ms',
      timeMeanMs: t.mean, timeP50Ms: t.p50, timeP95Ms: t.p95,
      iterations: 500, linesProduced,
      heapBytesPerOp: heap.bytesPerOp, objectsPerOp: heap.objectsPerOp,
    });
  }

  return cases;
}
